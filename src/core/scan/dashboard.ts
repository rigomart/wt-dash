import { listArgs, parseWorktrunk, SchemaMismatchError } from "../worktrunk/list";
import { discoverRepos, readLinkedWorktrees, type LinkedWorktrees } from "./discovery";
import { enrichRows } from "./enrich";
import { listingOrder } from "./order";
import type {
  CommandRunner,
  DashboardService,
  DashboardSnapshot,
  SizeEntry,
  SizeService,
  WorktreeRow,
} from "../types";

interface DashboardOptions {
  projectRoot: string;
  wtPath: string;
  runner: CommandRunner;
  sizeService: SizeService;
  discover?: (root: string, maxDepth: number) => Promise<string[]>;
  readLinked?: (repo: string) => Promise<LinkedWorktrees | null>;
  readCreated?: (worktree: string) => Promise<string | null>;
  readBranchCreated?: (repo: string, branch: string) => Promise<string | null>;
}

export function createDashboardService(options: DashboardOptions): DashboardService {
  const listeners = new Set<(snapshot: DashboardSnapshot) => void>();
  const controllers = new Set<AbortController>();
  const runningByPath = new Map<string, number>();
  const newestTicketByPath = new Map<string, number>();
  let measurements = 0;
  let closed = false;
  let generation = 0;
  let snapshot: DashboardSnapshot = {
    generation: 0,
    repos: [],
    rows: [],
    progress: { phase: "idle", reposTotal: 0, reposDone: 0, startedAt: null, completedAt: null },
    errors: {},
    fatalError: null,
    sizing: [],
  };

  function publish(next: Omit<DashboardSnapshot, "sizing">): void {
    snapshot = { ...next, sizing: [...runningByPath.keys()] };
    for (const listener of listeners) listener(snapshot);
  }

  function current(value: number): boolean {
    return !closed && value === generation && snapshot.fatalError === null;
  }

  function withSizes(rows: WorktreeRow[]): WorktreeRow[] {
    return rows.map((row) => {
      const cached = row.path === null ? null : options.sizeService.get(row.path);
      return cached ? { ...row, sizeKiB: cached.sizeKiB, sizeMeasuredAt: cached.measuredAt } : row;
    });
  }

  /** Callers publish afterwards, so the sizing mark reaches the screen. */
  function track(path: string, task: Promise<SizeEntry | null>): Promise<void> {
    const ticket = ++measurements;
    newestTicketByPath.set(path, ticket);
    runningByPath.set(path, (runningByPath.get(path) ?? 0) + 1);
    return task
      .catch(() => null)
      .then((measured) => {
        const left = runningByPath.get(path)! - 1;
        if (left) runningByPath.set(path, left);
        else runningByPath.delete(path);
        const newest = newestTicketByPath.get(path) === ticket;
        if (!left) newestTicketByPath.delete(path);
        if (closed) return;
        const entry = newest ? (measured ?? options.sizeService.get(path)) : null;
        let changed = !left;
        const rows = snapshot.rows.map((row) => {
          if (
            !entry ||
            row.path !== path ||
            (row.sizeKiB === entry.sizeKiB && row.sizeMeasuredAt === entry.measuredAt)
          )
            return row;
          changed = true;
          return { ...row, sizeKiB: entry.sizeKiB, sizeMeasuredAt: entry.measuredAt };
        });
        if (changed) publish({ ...snapshot, rows });
      });
  }

  function scheduleSizes(rows: WorktreeRow[], first: boolean): void {
    for (const row of rows)
      if (row.path !== null)
        void track(row.path, options.sizeService.measureIfStale(row.path, first));
  }

  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    async refresh(only) {
      if (closed) return;
      // A targeted rescan would cancel a full scan that is still filling in rows; widen it instead.
      const targeted =
        only?.length && snapshot.progress.phase !== "scanning" ? new Set(only) : null;
      const scanGeneration = ++generation;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      // Keep the current rows on screen; each repo's rows are swapped out as its fresh listing arrives.
      const kept = snapshot.fatalError ? [] : snapshot.rows;
      publish({
        generation: scanGeneration,
        repos: snapshot.repos,
        rows: kept,
        progress: {
          phase: "scanning",
          reposTotal: 0,
          reposDone: 0,
          startedAt: new Date().toISOString(),
          completedAt: null,
        },
        errors: targeted
          ? Object.fromEntries(
              Object.entries(snapshot.errors).filter(([repo]) => !targeted.has(repo)),
            )
          : {},
        fatalError: null,
      });
      const scanned = new Set<string>();
      let repos: string[];
      try {
        repos = targeted
          ? [...targeted]
          : await (options.discover ?? discoverRepos)(options.projectRoot, 3);
      } catch (error) {
        if (current(scanGeneration)) {
          publish({
            ...snapshot,
            fatalError: `Repository discovery failed: ${String(error)}`,
            progress: {
              ...snapshot.progress,
              phase: "error",
              completedAt: new Date().toISOString(),
            },
          });
        }
        return;
      }
      if (!current(scanGeneration)) return;
      const linked = await Promise.all(repos.map(options.readLinked ?? readLinkedWorktrees));
      if (!current(scanGeneration)) return;
      const found = repos.map((path, index) => ({ path, linked: linked[index]?.count ?? null }));
      const linkedByPath = new Map(repos.map((path, index) => [path, linked[index]]));
      const { order, first } = listingOrder(
        repos.map((path, index) => ({ path, linked: linked[index]! })),
        (path) => options.sizeService.get(path)?.sizeKiB ?? null,
      );
      publish({
        ...snapshot,
        repos: targeted
          ? [...snapshot.repos.filter((repo) => !targeted.has(repo.path)), ...found].sort((a, b) =>
              a.path.localeCompare(b.path),
            )
          : found,
        progress: { ...snapshot.progress, reposTotal: repos.length },
      });
      // Branches without a worktree take most of a cold `wt list`; the full listing reuses what this one cached.
      const sized = new Set<string>();
      const quickRepos = order.filter((repo) => linkedByPath.get(repo)?.count !== 0);
      async function tryListWorktrees(repo: string): Promise<void> {
        const controller = new AbortController();
        controllers.add(controller);
        try {
          const result = await options.runner(
            options.wtPath,
            listArgs(repo, false),
            controller.signal,
          );
          if (result.exitCode !== 0 || !current(scanGeneration)) return;
          const rows = await enrichRows(
            repo,
            withSizes(parseWorktrunk(repo, result.stdout).filter((row) => row.kind === "worktree")),
            options.runner,
            {
              readCreated: options.readCreated,
              readBranchCreated: options.readBranchCreated,
              signal: controller.signal,
            },
          );
          if (!current(scanGeneration)) return;
          scheduleSizes(rows, first.has(repo));
          sized.add(repo);
          publish({
            ...snapshot,
            rows: [
              ...snapshot.rows.filter((row) => row.repoPath !== repo || row.kind !== "worktree"),
              ...rows,
            ],
          });
        } catch {
        } finally {
          controllers.delete(controller);
        }
      }
      let nextQuick = 0;
      // A cold `wt list` keeps every core busy, so list the first project alone.
      if (quickRepos.length && quickRepos[0] === order[0])
        await tryListWorktrees(quickRepos[nextQuick++]!);
      async function quickWorker(): Promise<void> {
        while (nextQuick < quickRepos.length && current(scanGeneration))
          await tryListWorktrees(quickRepos[nextQuick++]!);
      }
      await Promise.all(
        Array.from({ length: Math.min(4, quickRepos.length - nextQuick) }, () => quickWorker()),
      );
      if (!current(scanGeneration)) return;
      let nextRepo = 0;
      async function worker(): Promise<void> {
        while (nextRepo < order.length && current(scanGeneration)) {
          const repo = order[nextRepo++]!;
          const controller = new AbortController();
          controllers.add(controller);
          try {
            const result = await options.runner(options.wtPath, listArgs(repo), controller.signal);
            if (!current(scanGeneration)) continue;
            scanned.add(repo);
            if (result.exitCode !== 0) {
              publish({
                ...snapshot,
                rows: snapshot.rows.filter((row) => row.repoPath !== repo),
                errors: {
                  ...snapshot.errors,
                  [repo]: result.stderr.trim() || `wt exited ${result.exitCode}`,
                },
              });
            } else {
              let rows: WorktreeRow[];
              try {
                rows = withSizes(
                  await enrichRows(repo, parseWorktrunk(repo, result.stdout), options.runner, {
                    readCreated: options.readCreated,
                    readBranchCreated: options.readBranchCreated,
                    signal: controller.signal,
                  }),
                );
              } catch (error) {
                if (!current(scanGeneration)) continue;
                publish({
                  ...snapshot,
                  rows: [],
                  fatalError:
                    error instanceof SchemaMismatchError
                      ? error.message
                      : `Invalid Worktrunk JSON from ${repo}: ${String(error)}`,
                  progress: {
                    ...snapshot.progress,
                    phase: "error",
                    completedAt: new Date().toISOString(),
                  },
                });
                for (const other of controllers) other.abort();
                continue;
              }
              if (!current(scanGeneration)) continue;
              if (!sized.has(repo)) scheduleSizes(rows, first.has(repo));
              publish({
                ...snapshot,
                rows: [...snapshot.rows.filter((row) => row.repoPath !== repo), ...rows],
              });
            }
          } catch (error) {
            if (!current(scanGeneration)) continue;
            scanned.add(repo);
            publish({
              ...snapshot,
              rows: snapshot.rows.filter((row) => row.repoPath !== repo),
              errors: { ...snapshot.errors, [repo]: String(error) },
            });
          } finally {
            controllers.delete(controller);
            if (current(scanGeneration)) {
              publish({
                ...snapshot,
                progress: { ...snapshot.progress, reposDone: snapshot.progress.reposDone + 1 },
              });
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, repos.length) }, () => worker()));
      if (current(scanGeneration)) {
        publish({
          ...snapshot,
          // After a full scan, rows from repos that were not listed again (for example, deleted repos) are stale.
          rows: targeted ? snapshot.rows : snapshot.rows.filter((row) => scanned.has(row.repoPath)),
          progress: {
            ...snapshot.progress,
            phase: "complete",
            completedAt: new Date().toISOString(),
          },
        });
      }
    },
    async refreshSize(worktreeId) {
      const row = snapshot.rows.find((candidate) => candidate.id === worktreeId);
      if (!row || row.path === null || closed) return;
      const measured = track(row.path, options.sizeService.measure(row.path));
      publish(snapshot);
      await measured;
    },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      listeners.clear();
    },
  };
}

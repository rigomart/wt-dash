import { assess } from "./assess";
import { readComparisonBase } from "./base";
import { basename } from "node:path";
import {
  discoverRepos,
  readCreatedAt,
  readLinkedWorktrees,
  type LinkedWorktrees,
} from "./discovery";
import { parseWorktrunk, SchemaMismatchError } from "./worktrunk";
import type {
  CommandRunner,
  DashboardService,
  DashboardSnapshot,
  SizeService,
  WorktreeRow,
} from "./types";

interface DashboardOptions {
  projectRoot: string;
  wtPath: string;
  runner: CommandRunner;
  sizeService: SizeService;
  discover?: (root: string, maxDepth: number) => Promise<string[]>;
  readLinked?: (repo: string) => Promise<LinkedWorktrees | null>;
  readCreated?: (worktree: string) => Promise<string | null>;
}

/**
 * Repos in the order the projects screen shows them: most worktrees first, with the repo whose worktrees
 * took the most space at the last measurement moved up to second. `first` holds the repos listed first.
 */
export function listingOrder(
  repos: Array<{ path: string; linked: LinkedWorktrees | null }>,
  sizeOf: (path: string) => number | null,
): { order: string[]; first: Set<string> } {
  const ranked = [...repos].sort(
    (a, b) =>
      (b.linked?.count ?? 0) - (a.linked?.count ?? 0) ||
      basename(a.path).localeCompare(basename(b.path)) ||
      a.path.localeCompare(b.path),
  );
  const saved = (repo: (typeof repos)[number]) =>
    (repo.linked?.paths ?? []).reduce((sum, path) => sum + (sizeOf(path) ?? 0), 0);
  const heaviest = ranked.reduce<(typeof repos)[number] | null>(
    (best, repo) => (saved(repo) > (best ? saved(best) : 0) ? repo : best),
    null,
  );
  const promoted = heaviest !== null && heaviest !== ranked[0];
  if (promoted) {
    ranked.splice(ranked.indexOf(heaviest), 1);
    ranked.splice(1, 0, heaviest);
  }
  const order = ranked.map((repo) => repo.path);
  return { order, first: new Set(order.slice(0, promoted ? 2 : 1)) };
}

export function createDashboardService(options: DashboardOptions): DashboardService {
  const listeners = new Set<(snapshot: DashboardSnapshot) => void>();
  const controllers = new Set<AbortController>();
  let closed = false;
  let generation = 0;
  let snapshot: DashboardSnapshot = {
    generation: 0,
    repos: [],
    rows: [],
    progress: { phase: "idle", reposTotal: 0, reposDone: 0, startedAt: null, completedAt: null },
    errors: {},
    fatalError: null,
  };

  function publish(next: DashboardSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  }

  function current(value: number): boolean {
    return !closed && value === generation && snapshot.fatalError === null;
  }

  function withSizes(rows: WorktreeRow[]): WorktreeRow[] {
    return rows.map((row) => {
      const cached = options.sizeService.get(row.path);
      return cached ? { ...row, sizeKiB: cached.sizeKiB, sizeMeasuredAt: cached.measuredAt } : row;
    });
  }

  function scheduleSizes(rows: WorktreeRow[], scanGeneration: number, first: boolean): void {
    for (const row of rows) {
      void options.sizeService
        .measureIfStale(row.path, first)
        .then(() => {
          const entry = options.sizeService.get(row.path);
          if (!entry || !current(scanGeneration)) return;
          const index = snapshot.rows.findIndex((candidate) => candidate.id === row.id);
          if (index < 0) return;
          const shown = snapshot.rows[index]!;
          if (shown.sizeKiB === entry.sizeKiB && shown.sizeMeasuredAt === entry.measuredAt) return;
          const updated = [...snapshot.rows];
          updated[index] = { ...shown, sizeKiB: entry.sizeKiB, sizeMeasuredAt: entry.measuredAt };
          publish({ ...snapshot, rows: updated });
        })
        .catch(() => {
          // A failed size check leaves the row's current estimate in place.
        });
    }
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
      let nextRepo = 0;
      async function worker(): Promise<void> {
        while (nextRepo < order.length && current(scanGeneration)) {
          const repo = order[nextRepo++]!;
          const controller = new AbortController();
          controllers.add(controller);
          try {
            const result = await options.runner(
              options.wtPath,
              ["-C", repo, "--config-set", "list.json-schema=2", "list", "--format=json"],
              controller.signal,
            );
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
                rows = withSizes(parseWorktrunk(repo, result.stdout));
                if (rows.length) {
                  const [base, created] = await Promise.all([
                    readComparisonBase(
                      repo,
                      rows[0]!.defaultBranch,
                      options.runner,
                      controller.signal,
                    ),
                    Promise.all(
                      rows.map((row) => (options.readCreated ?? readCreatedAt)(row.path)),
                    ),
                  ]);
                  rows = rows.map((row, index) => {
                    const enriched = { ...row, mainBase: base, createdAt: created[index]! };
                    const assessment = assess(enriched);
                    return { ...enriched, verdict: assessment.verdict, reason: assessment.reason };
                  });
                }
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
              publish({
                ...snapshot,
                rows: [...snapshot.rows.filter((row) => row.repoPath !== repo), ...rows],
              });
              scheduleSizes(rows, scanGeneration, first.has(repo));
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
      if (!row || closed) return;
      const scanGeneration = generation;
      const entry = await options.sizeService.measure(row.path);
      if (!entry || !current(scanGeneration)) return;
      publish({
        ...snapshot,
        rows: snapshot.rows.map((candidate) =>
          candidate.id === worktreeId
            ? { ...candidate, sizeKiB: entry.sizeKiB, sizeMeasuredAt: entry.measuredAt }
            : candidate,
        ),
      });
    },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      listeners.clear();
    },
  };
}

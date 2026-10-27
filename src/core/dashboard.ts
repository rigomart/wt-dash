import { assess } from "./assess";
import { readComparisonBase } from "./base";
import { discoverRepos } from "./discovery";
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
}

export function createDashboardService(options: DashboardOptions): DashboardService {
  const listeners = new Set<(snapshot: DashboardSnapshot) => void>();
  const controllers = new Set<AbortController>();
  let closed = false;
  let generation = 0;
  let snapshot: DashboardSnapshot = {
    generation: 0,
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

  function scheduleSizes(rows: WorktreeRow[], scanGeneration: number): void {
    for (const row of rows) {
      void options.sizeService
        .measure(row.path)
        .then((entry) => {
          if (!entry || !current(scanGeneration)) return;
          const index = snapshot.rows.findIndex((candidate) => candidate.id === row.id);
          if (index < 0) return;
          const updated = [...snapshot.rows];
          updated[index] = {
            ...updated[index]!,
            sizeKiB: entry.sizeKiB,
            sizeMeasuredAt: entry.measuredAt,
          };
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
      publish({ ...snapshot, progress: { ...snapshot.progress, reposTotal: repos.length } });
      let nextRepo = 0;
      async function worker(): Promise<void> {
        while (nextRepo < repos.length && current(scanGeneration)) {
          const repo = repos[nextRepo++]!;
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
                  const base = await readComparisonBase(
                    repo,
                    rows[0]!.defaultBranch,
                    options.runner,
                    controller.signal,
                  );
                  rows = rows.map((row) => {
                    const enriched = { ...row, mainBase: base };
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
              scheduleSizes(rows, scanGeneration);
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

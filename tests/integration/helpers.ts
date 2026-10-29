import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Built, Repo, Sandbox } from "../support/fixture";
import { findRow } from "../support/fixture";
import type {
  CommandRunner,
  DashboardService,
  DashboardSnapshot,
  WorktreeRow,
} from "../../src/core/types";

/** Resolves with the first snapshot that satisfies `predicate`, current one included. */
export function waitFor(
  service: DashboardService,
  predicate: (snapshot: DashboardSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<DashboardSnapshot> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("snapshot timeout"));
    }, timeoutMs);
    unsubscribe = service.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      queueMicrotask(unsubscribe);
      resolve(snapshot);
    });
  });
}

/** Lists `repo` again and returns the snapshot once the scan is complete. */
export async function scan(service: DashboardService, repo: Repo): Promise<DashboardSnapshot> {
  await service.refresh([repo.path]);
  const snapshot = service.getSnapshot();
  if (snapshot.progress.phase !== "complete" || snapshot.errors[repo.path])
    throw new Error(`scan of ${repo.name} ended ${snapshot.progress.phase}`);
  return snapshot;
}

export function row(snapshot: DashboardSnapshot, built: Built): WorktreeRow {
  const found = findRow(snapshot.rows, built);
  if (!found) throw new Error(`no row for ${built.branch}`);
  return found;
}

export const exists = (path: string) =>
  realpath(path).then(
    () => true,
    () => false,
  );

export async function branches(repo: Repo): Promise<string[]> {
  return (await repo.git("branch", "--list", "--format=%(refname:short)"))
    .split("\n")
    .filter(Boolean);
}

export interface LogLine {
  repo: string;
  branch: string | null;
  path: string | null;
  flags: string[];
  exitCode: number;
  branchOutcome: string | null;
  error: string | null;
}

/** Entries of removals.log for `target`, a worktree path or a branch without one. */
export async function logFor(sandbox: Sandbox, target: Built): Promise<LogLine[]> {
  const text = await readFile(join(sandbox.cacheDir, "removals.log"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogLine)
    .filter(
      (line) =>
        line.repo === target.repo && line.path === target.path && line.branch === target.branch,
    );
}

export interface Event {
  phase: "start" | "end";
  command: string;
  args: string[];
}

/** Wraps a runner to record when each command starts and ends. */
export function timeline(base: CommandRunner): { runner: CommandRunner; events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    async runner(command, args, signal, environment) {
      events.push({ phase: "start", command, args });
      try {
        return await base(command, args, signal, environment);
      } finally {
        events.push({ phase: "end", command, args });
      }
    },
  };
}

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { assess, recentAgentMark } from "../assess";
import { readTip } from "../git/refs";
import { readFiles, readOperation } from "../git/status";
import { listWorktrees } from "../git/worktrees";
import type { CommandRunner, WorktreeRow } from "../types";
import { readMarks } from "../worktrunk/list";
import { filesStamp, stateStamp } from "./plan";
import type { FileReport, RemovalEntry } from "./types";

/** Merge, upstream and integration state are not read here; removeBatch re-lists when a ref they depend on moves. */
export async function recheckWorktree(
  entry: RemovalEntry,
  confirmed: WorktreeRow,
  runner: CommandRunner,
): Promise<string | null> {
  // Git lists the main worktree first.
  const state = (await listWorktrees(entry.row.repoPath, runner))
    .slice(1)
    .find((item) => item.path === entry.row.path);
  if (!state) return "it is missing or is the main worktree";
  const fresh: WorktreeRow = {
    ...confirmed,
    ...state,
    operation: state.prunable ? null : await readOperation(state.path, runner),
  };
  const blocked = assess(fresh).removalBlockReason;
  if (blocked) return blocked;
  if (stateStamp(fresh) !== stateStamp(entry.row)) return "it changed; refresh and preview again";
  let files: FileReport;
  try {
    files = await readFiles(fresh, runner);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return filesStamp(files) !== filesStamp(entry) ? "Local files changed since preview" : null;
}
export async function recheckMark(row: WorktreeRow, runner: CommandRunner): Promise<string | null> {
  if (!row.branch || recentAgentMark(row)) return null;
  const mark = (await readMarks(row.repoPath, runner)).get(row.branch);
  if (!mark) return null;
  return recentAgentMark({ ...row, marker: mark.marker, markerSetAt: mark.setAt })
    ? "an agent started work here; refresh and preview again"
    : null;
}
export async function recheckBranch(
  row: WorktreeRow,
  runner: CommandRunner,
): Promise<string | null> {
  const branch = row.branch!;
  const worktrees = await listWorktrees(row.repoPath, runner);
  if (worktrees.some((item) => item.branch === branch))
    return "it is missing or now has a worktree";
  // `wt remove <name>` removes the worktree whose folder is <name>, if there is one, before it looks for a branch.
  const asPath = resolve(row.repoPath, branch);
  const real = (path: string) => realpath(path).catch(() => path);
  const named = new Set([asPath, await real(asPath)]);
  for (const item of worktrees) {
    if (named.has(item.path) || named.has(await real(item.path)))
      return "a worktree folder has the same name, so Worktrunk would remove that instead; delete it with git branch";
  }
  const tip = await readTip(row.repoPath, `refs/heads/${branch}`, runner);
  if (tip === null) return "it is missing or now has a worktree";
  return tip !== row.headSha ? "it changed; refresh and preview again" : null;
}

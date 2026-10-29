import { failure } from "../process";
import type { CommandResult, CommandRunner, WorktreeFacts } from "../types";

export type WorktreeState = Pick<
  WorktreeFacts,
  "headSha" | "branch" | "locked" | "lockReason" | "prunable" | "operation"
> & { path: string };
/** Branch names have no refs/heads/ prefix, as Worktrunk reports them. */
function parseWorktreeList(stdout: string): Array<Omit<WorktreeState, "operation">> {
  const worktrees: Array<Omit<WorktreeState, "operation">> = [];
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? null : line.slice(space + 1);
    if (key === "worktree" && value)
      worktrees.push({
        path: value,
        headSha: null,
        branch: null,
        locked: false,
        lockReason: null,
        prunable: false,
      });
    const current = worktrees.at(-1);
    if (!current) continue;
    if (key === "HEAD") current.headSha = value;
    else if (key === "branch") current.branch = value?.replace(/^refs\/heads\//, "") ?? null;
    else if (key === "locked") {
      current.locked = true;
      current.lockReason = value;
    } else if (key === "prunable") current.prunable = true;
  }
  return worktrees;
}

export async function listWorktrees(
  repoPath: string,
  runner: CommandRunner,
): Promise<ReturnType<typeof parseWorktreeList>> {
  const list = await runner("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  if (list.exitCode !== 0) throw failure("git worktree list", list);
  return parseWorktreeList(list.stdout);
}

export async function dryPrune(repoPath: string, runner: CommandRunner): Promise<string[]> {
  const result = await runner("git", [
    "-C",
    repoPath,
    "worktree",
    "prune",
    "--dry-run",
    "--expire=now",
    "--verbose",
  ]);
  if (result.exitCode !== 0) throw failure("git worktree prune", result);
  return (result.stdout + "\n" + result.stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function pruneNow(repoPath: string, runner: CommandRunner): Promise<void> {
  const result = await runner("git", [
    "-C",
    repoPath,
    "worktree",
    "prune",
    "--expire=now",
    "--verbose",
  ]);
  if (result.exitCode !== 0) throw failure("git worktree prune", result);
}

export function prune(repoPath: string, runner: CommandRunner): Promise<CommandResult> {
  return runner("git", ["-C", repoPath, "worktree", "prune"]);
}

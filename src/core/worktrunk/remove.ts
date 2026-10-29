import type { CommandResult, CommandRunner, WorktreeRow } from "../types";

export function runRemove(
  wtPath: string,
  row: WorktreeRow,
  flags: string[],
  runner: CommandRunner,
): Promise<CommandResult> {
  const target = row.path ?? row.branch!;
  return runner(wtPath, [
    "-C",
    row.repoPath,
    "remove",
    "-y",
    "--no-hooks",
    "--foreground",
    "--format=json",
    ...flags,
    target,
  ]);
}

export function parseRemoval(
  row: WorktreeRow,
  stdout: string,
): { branchOutcome: string; pruned: boolean | undefined } {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const value = values.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" &&
      item !== null &&
      (row.kind === "branch"
        ? item.kind === "branch_only" && item.branch === row.branch
        : item.kind === "worktree" && item.path === row.path),
  );
  if (!value || typeof value.branch_outcome !== "string") {
    throw new Error("Unexpected Worktrunk removal result");
  }
  return {
    branchOutcome: value.branch_outcome,
    pruned: typeof value.pruned === "boolean" ? value.pruned : undefined,
  };
}

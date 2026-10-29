import fixture from "../fixtures/list-v2.json";
import { parseWorktrunk } from "../../src/core/worktrunk/list";
import type { CommandRunner } from "../../src/core/types";

export const repo = "/Users/test/projects/sample";
export const rows = parseWorktrunk(repo, JSON.stringify(fixture));
export const branchRow = rows[0]!;
export const detachedRow = rows[1]!;

export function commandResult(stdout = "", exitCode = 0) {
  return { stdout, stderr: exitCode ? "command failed" : "", exitCode };
}

export function porcelain(payload: any): string {
  return payload.items
    .filter((item: any) => item.worktree)
    .map((item: any) => {
      const worktree = item.worktree;
      const lines = [
        `worktree ${worktree.path}`,
        `HEAD ${item.head.sha}`,
        item.branch ? `branch refs/heads/${item.branch}` : "detached",
      ];
      if (worktree.locked)
        lines.push(worktree.locked.reason ? `locked ${worktree.locked.reason}` : "locked");
      if (worktree.prunable) lines.push(`prunable ${worktree.prunable.reason}`);
      return lines.join("\n") + "\n";
    })
    .join("\n");
}

/** `gitDirs[path]` holds Git operation markers; none exist unless a test creates them. */
export function worktreeState(
  args: string[],
  payload: any = fixture,
  gitDirs: Record<string, string> = {},
) {
  if (args.includes("--porcelain")) return commandResult(porcelain(payload));
  if (args.includes("--git-path")) {
    const gitDir = gitDirs[args[1]!] ?? "/nonexistent/git-dir";
    const markers = args.filter((_, index) => args[index - 1] === "--git-path");
    return commandResult(markers.map((marker) => `${gitDir}/${marker}\n`).join(""));
  }
  return null;
}

export const repoB = "/Users/test/projects/other";
export const payloadB = structuredClone(fixture);
payloadB.items[0]!.worktree!.path = repoB;
payloadB.items[1]!.worktree!.path = `${repoB}/.claude/worktrees/b`;
payloadB.items[2]!.worktree!.path = "/Users/test/.codex/worktrees/def/other";
const rowsB = parseWorktrunk(repoB, JSON.stringify(payloadB));
export const branchRowB = rowsB[0]!;
export const detachedRowB = rowsB[1]!;

export function twoRepoRunner(
  calls: string[][],
  listA: () => Promise<ReturnType<typeof commandResult>> = async () =>
    commandResult(JSON.stringify(fixture)),
): CommandRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    const state = worktreeState(args, args[1] === repo ? fixture : payloadB);
    if (state) return state;
    if (args.includes("list"))
      return args[1] === repo ? listA() : commandResult(JSON.stringify(payloadB));
    if (args.includes("remove"))
      return commandResult(
        JSON.stringify({ kind: "worktree", path: args.at(-1), branch_outcome: "deleted" }),
      );
    return commandResult();
  };
}

export function fakeRepos(options: {
  payloads: Record<string, any>;
  statuses?: Record<string, string>;
  gitDirs?: Record<string, string>;
  /** A missing or null tip means the ref does not exist. */
  tips?: Record<string, string | null>;
  fails?: (command: string, args: string[]) => boolean;
  removeOutput?: (path: string) => string;
  onRemove?: (path: string) => Promise<void> | void;
}) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (options.fails?.(command, args)) return commandResult("", 1);
    const target = args[1]!;
    const state = worktreeState(args, options.payloads[target], options.gitDirs);
    if (state) return state;
    if (args.includes("--verify") && args.includes("-q")) {
      const tip = options.tips?.[args.at(-1)!];
      return tip ? commandResult(`${tip}\n`) : { stdout: "", stderr: "", exitCode: 1 };
    }
    if (command === "/wt" && args.includes("list"))
      return commandResult(JSON.stringify(options.payloads[target]));
    if (args.includes("status")) return commandResult(options.statuses?.[target] ?? "");
    if (args.includes("remove")) {
      const path = args.at(-1)!;
      await options.onRemove?.(path);
      return commandResult(
        options.removeOutput?.(path) ??
          JSON.stringify({ kind: "worktree", path, branch_outcome: "deleted" }),
      );
    }
    return commandResult();
  };
  return { calls, runner };
}

export function threeWorktrees(): any {
  const payload: any = structuredClone(fixture);
  const third = structuredClone(payload.items[2]);
  third.head.sha = "ddd";
  third.worktree.path = "/Users/test/.codex/worktrees/xyz/sample";
  payload.items.push(third);
  return payload;
}
export const wtLists = (calls: string[][], target: string) =>
  calls.filter((call) => call[0] === "/wt" && call.includes("list") && call[2] === target).length;
export const removed = (calls: string[][]) =>
  calls.filter((call) => call.includes("remove")).map((call) => call.at(-1));

export function noNewCommits(): any {
  const payload: any = structuredClone(fixture);
  payload.items[1].display = { state: "empty" };
  payload.items[1].default_branch = { ahead: 0, behind: 0, integration: { reason: "same_commit" } };
  return payload;
}

export function withBranch(state: string, extra: object = {}): any {
  const payload: any = structuredClone(fixture);
  payload.items.push({
    branch: "old",
    head: { sha: "old-sha", committed_at: "2026-09-20T00:00:00Z" },
    default_branch:
      state === "integrated"
        ? { ahead: 0, behind: 2, integration: { reason: "ancestor" } }
        : { ahead: 2, behind: 0 },
    display: { state },
    ...extra,
  });
  return payload;
}
export const branchCreated = "2026-09-01T00:00:00Z";
export const aged = { readBranchCreated: async () => branchCreated };

export const branchOnly = (payload: any, root = repo) => ({
  ...parseWorktrunk(root, JSON.stringify(payload)).find((row) => row.kind === "branch")!,
  createdAt: branchCreated,
});
export const branchRemoved = (outcome = "deleted") =>
  JSON.stringify([
    {
      kind: "branch_only",
      branch: "old",
      branch_checked_out_at: null,
      branch_outcome: outcome,
      pruned: false,
    },
  ]);

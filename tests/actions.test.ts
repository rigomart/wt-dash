import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./fixtures/list-v2.json";
import { parseWorktrunk } from "../src/core/worktrunk";
import { createActionService, type RemovalChoice } from "../src/core/actions";
import type { CommandRunner, WorktreeRow } from "../src/core/types";

const repo = "/Users/test/projects/sample";
const rows = parseWorktrunk(repo, JSON.stringify(fixture));
const branchRow = rows[0]!;
const detachedRow = rows[1]!;

function commandResult(stdout = "", exitCode = 0) {
  return { stdout, stderr: exitCode ? "command failed" : "", exitCode };
}

function porcelain(payload: any): string {
  return payload.items
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
function worktreeState(
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

test("removes a safe worktree by path and records the branch outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const state = worktreeState(args);
    if (state) return state;
    if (args.includes("list"))
      return commandResult(args.includes("list.json-schema=2") ? JSON.stringify(fixture) : "[]");
    if (args.includes("status")) return commandResult();
    if (args.includes("remove"))
      return commandResult(
        JSON.stringify([
          {
            kind: "worktree",
            branch: "feature/name",
            path: branchRow.path,
            branch_outcome: "deleted",
          },
        ]),
      );
    if (args.includes("prune")) return commandResult();
    return commandResult(
      "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/disk 100 10 90 10% /System/Volumes/Data\n",
    );
  };
  try {
    const actions = createActionService({
      wtPath: "/wt",
      runner,
      logPath: join(directory, "removals.log"),
    });
    const plan = await actions.prepareRemoval([branchRow]);
    expect(plan.entries[0]?.blockedReason).toBeNull();
    const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
    expect(result.items).toEqual([
      { id: branchRow.id, status: "removed", branchOutcome: "deleted" },
    ]);
    expect(
      calls.some(
        (call) => call[0] === "/wt" && call.includes("remove") && call.at(-1) === branchRow.path,
      ),
    ).toBe(true);
    expect(calls.find((call) => call.includes("remove"))).toContain("--no-hooks");
    expect(
      calls.some((call) => call.includes("-f") || call.includes("-D") || call.includes("--reap")),
    ).toBe(false);
    const log = JSON.parse((await readFile(join(directory, "removals.log"), "utf8")).trim());
    expect(log.path).toBe(branchRow.path);
    expect(log.branchOutcome).toBe("deleted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a batch confirmed while another runs waits for it, and pruning waits for both", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const removed: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const runner: CommandRunner = async (_command, args) => {
    const state = worktreeState(args);
    if (state) return state;
    if (args.includes("list")) return commandResult(JSON.stringify(fixture));
    if (args.includes("remove")) {
      const path = args.at(-1)!;
      if (!removed.length) await firstHeld;
      removed.push(path);
      return commandResult(JSON.stringify([{ kind: "worktree", path, branch_outcome: "deleted" }]));
    }
    return commandResult();
  };
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const first = actions.executeRemoval(await actions.prepareRemoval([branchRow]), {
      [branchRow.id]: { include: true },
    });
    const second = actions.executeRemoval(await actions.prepareRemoval([detachedRow]), {
      [detachedRow.id]: { include: true },
    });
    await Bun.sleep(10);
    expect(removed).toEqual([]);
    await expect(actions.preparePrune(repo)).rejects.toThrow("Cleanup is running");
    releaseFirst();
    expect((await first).items.map((item) => item.status)).toEqual(["removed"]);
    expect((await second).items.map((item) => item.status)).toEqual(["removed"]);
    expect(removed).toEqual([branchRow.path, detachedRow.path]);
    await expect(actions.preparePrune(repo)).resolves.toMatchObject({ repoPath: repo });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspecting files separates uncommitted changes, ignored files, and rebuildable caches", async () => {
  const runner: CommandRunner = async () =>
    commandResult(
      "?? notes.md\n M src/app.ts\n!! .env\n!! data.sqlite\n!! node_modules/\n!! .turbo/\n",
    );
  const actions = createActionService({ wtPath: "/wt", runner, logPath: "/unused" });
  const report = await actions.inspectFiles(branchRow);
  expect(report.localFiles).toEqual(["?? notes.md", " M src/app.ts"]);
  expect(report.ignoredFiles).toEqual([".env", "data.sqlite"]);
  expect(report.disposableIgnored).toBe(2);
});

test("refuses to remove a dirty row without its own discard choice", async () => {
  const dirtyPayload = structuredClone(fixture);
  dirtyPayload.items[1]!.worktree!.changes!.modified = true;
  const dirtyRow = parseWorktrunk(repo, JSON.stringify(dirtyPayload))[0]!;
  let removes = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("list")) return commandResult(JSON.stringify(dirtyPayload));
    if (args.includes("status")) return commandResult(" M src/file.ts\n");
    if (args.includes("remove")) {
      removes++;
      return commandResult(
        JSON.stringify({
          kind: "worktree",
          path: dirtyRow.path,
          branch_outcome: "retained_unmerged",
        }),
      );
    }
    return commandResult();
  };
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([dirtyRow]);
    expect(plan.entries[0]?.requiresDiscard).toBe(true);
    const result = await actions.executeRemoval(plan, { [dirtyRow.id]: { include: true } });
    expect(result.items[0]?.status).toBe("skipped");
    expect(removes).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks a stale plan when HEAD changes before execution", async () => {
  let lists = 0;
  let removes = 0;
  const changed = structuredClone(fixture);
  changed.items[1]!.head!.sha = "changed";
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("list"))
      return commandResult(JSON.stringify(++lists === 1 ? fixture : changed));
    if (args.includes("status")) return commandResult();
    if (args.includes("remove")) removes++;
    return commandResult();
  };
  const actions = createActionService({
    wtPath: "/wt",
    runner,
    logPath: join(tmpdir(), "unused-action-log"),
  });
  const plan = await actions.prepareRemoval([branchRow]);
  const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
  expect(result.items[0]?.status).toBe("skipped");
  expect(removes).toBe(0);
});

test("detached worktree removal passes its absolute path", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const state = worktreeState(args);
    if (state) return state;
    if (args.includes("list")) return commandResult(JSON.stringify(fixture));
    if (args.includes("status")) return commandResult();
    if (args.includes("remove"))
      return commandResult(
        JSON.stringify({
          kind: "worktree",
          branch: null,
          path: detachedRow.path,
          branch_outcome: "not_attempted",
        }),
      );
    return commandResult();
  };
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([detachedRow]);
    await actions.executeRemoval(plan, { [detachedRow.id]: { include: true } });
    expect(calls.find((call) => call.includes("remove"))?.at(-1)).toBe(detachedRow.path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignored files are reported but removal needs neither a discard choice nor -f", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const removals: string[][] = [];
  const runner: CommandRunner = async (_command, args) => {
    const state = worktreeState(args);
    if (state) return state;
    if (args.includes("list")) return commandResult(JSON.stringify(fixture));
    if (args.includes("status")) return commandResult("!! .env\n!! node_modules/\n");
    if (args.includes("remove")) {
      removals.push(args);
      return commandResult(
        JSON.stringify({ kind: "worktree", path: branchRow.path, branch_outcome: "deleted" }),
      );
    }
    return commandResult();
  };
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([branchRow]);
    expect(plan.entries[0]?.ignoredFiles).toEqual([".env"]);
    expect(plan.entries[0]?.requiresDiscard).toBe(false);
    const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
    expect(result.items[0]?.status).toBe("removed");
    expect(removals).toHaveLength(1);
    expect(removals[0]).not.toContain("-f");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("locked worktree is blocked in the core even if included", async () => {
  const locked: any = structuredClone(fixture);
  locked.items[1]!.worktree!.locked = { reason: "active session" };
  const lockedRow = parseWorktrunk(repo, JSON.stringify(locked))[0]!;
  let removals = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("list")) return commandResult(JSON.stringify(locked));
    if (args.includes("remove")) removals++;
    return commandResult();
  };
  const actions = createActionService({
    wtPath: "/wt",
    runner,
    logPath: join(tmpdir(), "unused-action-log"),
  });
  const plan = await actions.prepareRemoval([lockedRow]);
  expect(plan.entries[0]?.blockedReason).toContain("active session");
  const result = await actions.executeRemoval(plan, { [lockedRow.id]: { include: true } });
  expect(result.items[0]?.status).toBe("skipped");
  expect(removals).toBe(0);
});

test("a Git operation cannot be removed even when local change flags look clean", async () => {
  const busyFixture: any = structuredClone(fixture);
  busyFixture.items[1].worktree.operation = "rebase";
  const busyRow = parseWorktrunk(repo, JSON.stringify(busyFixture))[0]!;
  const runner: CommandRunner = async (_command, args) =>
    args.includes("list") ? commandResult(JSON.stringify(busyFixture)) : commandResult();
  const actions = createActionService({
    wtPath: "/wt",
    runner,
    logPath: join(tmpdir(), "unused-action-log"),
  });
  const plan = await actions.prepareRemoval([busyRow]);
  expect(plan.entries[0]?.blockedReason).toContain("rebase");
});

test("prune refuses to run when the dry-run record list changes", async () => {
  let checks = 0;
  let prunes = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("--dry-run"))
      return commandResult(++checks === 1 ? "prune old\n" : "prune other\n");
    if (args.includes("prune")) prunes++;
    return commandResult();
  };
  const actions = createActionService({
    wtPath: "/wt",
    runner,
    logPath: join(tmpdir(), "unused-action-log"),
  });
  const plan = await actions.preparePrune(repo);
  expect(plan.records).toEqual(["prune old"]);
  expect(actions.executePrune(plan)).rejects.toThrow("changed");
  expect(prunes).toBe(0);
});

test("reports an unverified result when Worktrunk succeeds but its output cannot be parsed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const runner: CommandRunner = async (_command, args) => {
    const state = worktreeState(args);
    if (state) return state;
    if (args.includes("list")) return commandResult(JSON.stringify(fixture));
    if (args.includes("remove")) return commandResult("not JSON");
    return commandResult();
  };
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([branchRow]);
    const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
    expect(result.items[0]?.status).toBe("unverified");
    expect(result.warnings.join(" ")).toContain("could not be verified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("marker changes do not invalidate Git confirmation or trigger activity checks", async () => {
  const marked = structuredClone(fixture);
  Object.assign(marked.items[1]!, { marker: "🤖" });
  const row = parseWorktrunk(repo, JSON.stringify(marked))[0]!;
  let lists = 0;
  const calls: string[][] = [];
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const state = worktreeState(args, marked);
    if (state) return state;
    if (args.includes("list")) {
      if (++lists > 1) Object.assign(marked.items[1]!, { marker: "💬" });
      return commandResult(JSON.stringify(marked));
    }
    if (args.includes("remove"))
      return commandResult(
        JSON.stringify({ kind: "worktree", path: row.path, branch_outcome: "deleted" }),
      );
    return commandResult();
  };
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([row]);
    expect(plan.entries[0]?.blockedReason).toBeNull();
    const result = await actions.executeRemoval(plan, { [row.id]: { include: true } });
    expect(result.items[0]?.status).toBe("removed");
    expect(lists).toBe(2);
    expect(
      calls.some((call) => call[0] === "lsof" || call[0] === "ps" || call.includes("--get-regexp")),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["lock", "conflict", "unknown status"])(
  "a fresh Git check blocks a %s appearing after confirmation",
  async (blocker) => {
    const changed: any = structuredClone(fixture);
    if (blocker === "lock") changed.items[1].worktree.locked = { reason: "manual lock" };
    if (blocker === "conflict") changed.items[1].worktree.changes.conflicted = true;
    if (blocker === "unknown status") delete changed.items[1].worktree.changes;
    let lists = 0;
    let removals = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("list"))
        return commandResult(JSON.stringify(++lists === 1 ? fixture : changed));
      if (args.includes("remove")) removals++;
      return commandResult();
    };
    const actions = createActionService({
      wtPath: "/wt",
      runner,
      logPath: join(tmpdir(), "unused-action-log"),
    });
    const plan = await actions.prepareRemoval([branchRow]);
    expect(plan.entries[0]?.blockedReason).toBeNull();
    const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
    expect(result.items[0]?.status).toBe("skipped");
    expect(removals).toBe(0);
  },
);

test("new local files after confirmation prevent removal", async () => {
  let statuses = 0;
  let removals = 0;
  const runner: CommandRunner = async (_command, args) => {
    const state = worktreeState(args);
    if (state) return state;
    if (args.includes("list")) return commandResult(JSON.stringify(fixture));
    if (args.includes("status")) return commandResult(++statuses === 1 ? "" : "?? new-notes.md\n");
    if (args.includes("remove")) removals++;
    return commandResult();
  };
  const actions = createActionService({
    wtPath: "/wt",
    runner,
    logPath: join(tmpdir(), "unused-action-log"),
  });
  const plan = await actions.prepareRemoval([branchRow]);
  const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
  expect(result.items[0]?.status).toBe("skipped");
  expect(result.items[0]?.error).toContain("Local files changed");
  expect(removals).toBe(0);
});

test("all Git locks block removal and keep the full reason without owner inference", async () => {
  const locked: any = structuredClone(fixture);
  const reason = "claude session old (pid 42 start Wed Sep 23 15:55:03 2026)";
  locked.items[1].worktree.locked = { reason };
  const row = parseWorktrunk(repo, JSON.stringify(locked))[0]!;
  const runner: CommandRunner = async (_command, args) =>
    args.includes("list") ? commandResult(JSON.stringify(locked)) : commandResult();
  const service = createActionService({
    wtPath: "/wt",
    runner,
    logPath: join(tmpdir(), "unused-action-log"),
  });
  const plan = await service.prepareRemoval([row]);
  expect(plan.entries[0]?.blockedReason).toContain(reason);
  expect(plan.entries[0]?.blockedReason).not.toContain("Stale");
});

const repoB = "/Users/test/projects/other";
const payloadB = structuredClone(fixture);
payloadB.items[0]!.worktree!.path = repoB;
payloadB.items[1]!.worktree!.path = `${repoB}/.claude/worktrees/b`;
payloadB.items[2]!.worktree!.path = "/Users/test/.codex/worktrees/def/other";
const rowsB = parseWorktrunk(repoB, JSON.stringify(payloadB));
const branchRowB = rowsB[0]!;
const detachedRowB = rowsB[1]!;

function twoRepoRunner(
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

test("preview lists each repo and reads its comparison base once", async () => {
  const calls: string[][] = [];
  const actions = createActionService({
    wtPath: "/wt",
    runner: twoRepoRunner(calls),
    logPath: "/unused",
  });
  const plan = await actions.prepareRemoval([branchRow, detachedRow, branchRowB, detachedRowB]);
  expect(plan.entries.map((entry) => entry.blockedReason)).toEqual([null, null, null, null]);
  for (const target of [repo, repoB]) {
    expect(calls.filter((call) => call.includes("list") && call[2] === target)).toHaveLength(1);
    expect(calls.filter((call) => call.includes("rev-parse") && call[2] === target)).toHaveLength(
      1,
    );
  }
  expect(calls.filter((call) => call.includes("status"))).toHaveLength(4);
});

test("preview keeps input order across repos listed in parallel", async () => {
  const calls: string[][] = [];
  const slowA = async () => {
    await Bun.sleep(20);
    return commandResult(JSON.stringify(fixture));
  };
  const actions = createActionService({
    wtPath: "/wt",
    runner: twoRepoRunner(calls, slowA),
    logPath: "/unused",
  });
  const input = [branchRow, branchRowB, detachedRow, detachedRowB];
  const plan = await actions.prepareRemoval(input);
  expect(plan.entries.map((entry) => entry.row.id)).toEqual(input.map((row) => row.id));
  const listB = calls.findIndex((call) => call.includes("list") && call[2] === repoB);
  const statusA = calls.findIndex((call) => call.includes("status") && call[2] === branchRow.path);
  expect(listB).toBeLessThan(statusA);
});

test.each([
  ["exits non-zero", async () => commandResult("", 1), "Error: wt list exited 1: command failed"],
  [
    "throws",
    async () => {
      throw new Error("spawn failed");
    },
    "Error: spawn failed",
  ],
  [
    "returns an unknown schema",
    async () => commandResult(JSON.stringify({ ...fixture, schema: 3 })),
    "SchemaMismatchError: Worktrunk JSON schema changed: expected 2, received 3",
  ],
] as const)("a listing that %s blocks only its own repo's rows", async (_name, listA, reason) => {
  const calls: string[][] = [];
  const actions = createActionService({
    wtPath: "/wt",
    runner: twoRepoRunner(calls, listA),
    logPath: "/unused",
  });
  const plan = await actions.prepareRemoval([branchRow, branchRowB, detachedRow, detachedRowB]);
  const blocked = (row: typeof branchRow) => ({
    row,
    blockedReason: reason,
    localFiles: [],
    ignoredFiles: [],
    disposableIgnored: 0,
    requiresDiscard: false,
    branchWillBeRetained: false,
  });
  expect(plan.entries[0]).toEqual(blocked(branchRow));
  expect(plan.entries[2]).toEqual(blocked(detachedRow));
  const alone = createActionService({
    wtPath: "/wt",
    runner: twoRepoRunner([]),
    logPath: "/unused",
  });
  expect([plan.entries[1], plan.entries[3]]).toEqual(
    (await alone.prepareRemoval([branchRowB, detachedRowB])).entries,
  );
  expect(calls.some((call) => call[0] === "git" && call[2] === repo)).toBe(false);
});

function fakeRepos(options: {
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

function threeWorktrees(): any {
  const payload: any = structuredClone(fixture);
  const third = structuredClone(payload.items[2]);
  third.head.sha = "ddd";
  third.worktree.path = "/Users/test/.codex/worktrees/xyz/sample";
  payload.items.push(third);
  return payload;
}

function steps(calls: string[][]): string[] {
  return calls.flatMap((call) => {
    if (call[0] === "/wt") return [call.includes("remove") ? `remove ${call.at(-1)}` : "wt list"];
    if (call.includes("--porcelain")) return ["worktree list"];
    if (call.includes("--git-path")) return [`git operation ${call[2]}`];
    if (call.includes("status")) return [`status ${call[2]}`];
    return [];
  });
}
const wtLists = (calls: string[][], target: string) =>
  calls.filter((call) => call[0] === "/wt" && call.includes("list") && call[2] === target).length;
const removed = (calls: string[][]) =>
  calls.filter((call) => call.includes("remove")).map((call) => call.at(-1));

test("removal lists the repo once when its removals start, then checks each worktree right before removing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const calls: string[][] = [];
  try {
    const actions = createActionService({
      wtPath: "/wt",
      runner: twoRepoRunner(calls),
      logPath: join(directory, "log"),
    });
    const plan = await actions.prepareRemoval([branchRow, detachedRow]);
    const result = await actions.executeRemoval(plan, {
      [branchRow.id]: { include: true },
      [detachedRow.id]: { include: true },
    });
    expect(result.items.map((item) => item.status)).toEqual(["removed", "removed"]);
    expect(steps(calls)).toEqual([
      "wt list",
      `status ${branchRow.path}`,
      `status ${detachedRow.path}`,
      "wt list",
      "worktree list",
      `git operation ${branchRow.path}`,
      `status ${branchRow.path}`,
      `remove ${branchRow.path}`,
      "worktree list",
      `git operation ${detachedRow.path}`,
      `status ${detachedRow.path}`,
      `remove ${detachedRow.path}`,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interleaved repos are removed one repo at a time, with items and warnings in plan order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    const { calls, runner } = fakeRepos({
      payloads: { [repo]: fixture, [repoB]: payloadB },
      removeOutput: (path) =>
        path === branchRow.path
          ? JSON.stringify({ kind: "worktree", path, branch_outcome: "deleted" })
          : "not JSON",
      fails: (_command, args) => args.at(-1) === "prune",
    });
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const input = [branchRow, branchRowB, detachedRow];
    const plan = await actions.prepareRemoval(input);
    const prepared = calls.length;
    const result = await actions.executeRemoval(
      plan,
      Object.fromEntries(input.map((row) => [row.id, { include: true }])),
    );
    const batch = calls.slice(prepared);
    expect(result.items.map((item) => [item.id, item.status])).toEqual([
      [branchRow.id, "removed"],
      [branchRowB.id, "unverified"],
      [detachedRow.id, "unverified"],
    ]);
    expect(removed(batch)).toEqual([branchRow.path, detachedRow.path, branchRowB.path]);
    expect([wtLists(batch, repo), wtLists(batch, repoB)]).toEqual([1, 1]);
    expect(batch.filter((call) => call.includes("--porcelain"))).toHaveLength(3);
    expect(batch.filter((call) => call.includes("status"))).toHaveLength(3);
    expect(result.warnings).toEqual([
      `Removal outcome for ${branchRowB.path} could not be verified; check the refreshed list`,
      `Removal outcome for ${detachedRow.path} could not be verified; check the refreshed list`,
      `Could not prune ${repo}: command failed`,
      `Could not prune ${repoB}: command failed`,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each<
  [
    string,
    { payload?: (target: any) => void; marker?: string; todo?: string; status?: string },
    string,
  ]
>([
  [
    "a new commit",
    { payload: (t) => (t.head.sha = "eee") },
    "it changed; refresh and preview again",
  ],
  [
    "a branch switch",
    { payload: (t) => (t.branch = "other") },
    "it changed; refresh and preview again",
  ],
  [
    "a lock",
    { payload: (t) => (t.worktree.locked = { reason: "manual lock" }) },
    "it's locked (manual lock); unlock it first",
  ],
  [
    "a lock without a reason",
    { payload: (t) => (t.worktree.locked = { reason: null }) },
    "it's locked; unlock it first",
  ],
  [
    "a missing folder",
    {
      payload: (t) =>
        (t.worktree.prunable = { reason: "gitdir file points to non-existent location" }),
    },
    "the folder is gone; prune it instead",
  ],
  ["a rebase", { marker: "rebase-merge" }, "finish or abort the rebase first"],
  ["an apply-style rebase", { marker: "rebase-apply" }, "finish or abort the rebase first"],
  ["a merge", { marker: "MERGE_HEAD" }, "finish or abort the merge first"],
  ["a cherry-pick", { marker: "CHERRY_PICK_HEAD" }, "finish or abort the cherry-pick first"],
  ["a revert", { marker: "REVERT_HEAD" }, "finish or abort the revert first"],
  ["a bisect", { marker: "BISECT_LOG" }, "finish or abort the bisect first"],
  [
    "a cherry-pick known only to the sequencer",
    { todo: "pick 1234567 first\npick 89abcde second\n" },
    "finish or abort the cherry-pick first",
  ],
  [
    "a revert known only to the sequencer",
    { todo: "# reverting\nrevert 1234567 first\n" },
    "finish or abort the revert first",
  ],
  [
    "a sequencer with an unknown todo",
    { todo: "exec make\n" },
    "finish or abort the cherry-pick first",
  ],
  ["a sequencer without a todo", { marker: "sequencer" }, "finish or abort the cherry-pick first"],
  [
    "a sequencer with an unreadable todo",
    { marker: "sequencer/todo" },
    "finish or abort the cherry-pick first",
  ],
  ["an untracked file", { status: "?? notes.md\n" }, "Local files changed since preview"],
  ["a modified file", { status: " M src/app.ts\n" }, "Local files changed since preview"],
  ["a conflict", { status: "UU src/app.ts\n" }, "Local files changed since preview"],
])("%s after the repo's removals start skips only that worktree", async (_name, change, reason) => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    const payload = threeWorktrees();
    const [target, first, last] = parseWorktrunk(repo, JSON.stringify(payload));
    const gitDir = join(directory, "git");
    const statuses: Record<string, string> = {};
    const { calls, runner } = fakeRepos({
      payloads: { [repo]: payload },
      statuses,
      gitDirs: { [target!.path]: gitDir },
      onRemove: async (path) => {
        if (path !== first!.path) return;
        change.payload?.(payload.items[1]);
        if (change.status) statuses[target!.path] = change.status;
        if (change.marker) await mkdir(join(gitDir, change.marker), { recursive: true });
        if (change.todo) {
          await mkdir(join(gitDir, "sequencer"), { recursive: true });
          await writeFile(join(gitDir, "sequencer", "todo"), change.todo);
        }
      },
    });
    const actions = createActionService({
      wtPath: "/wt",
      runner,
      logPath: join(directory, "log"),
    });
    const input = [first!, target!, last!];
    const plan = await actions.prepareRemoval(input);
    expect(plan.entries.map((entry) => entry.blockedReason)).toEqual([null, null, null]);
    const result = await actions.executeRemoval(
      plan,
      Object.fromEntries(input.map((row) => [row.id, { include: true }])),
    );
    expect(result.items).toEqual([
      { id: first!.id, status: "removed", branchOutcome: "deleted" },
      { id: target!.id, status: "skipped", error: reason },
      { id: last!.id, status: "removed", branchOutcome: "deleted" },
    ]);
    expect(removed(calls)).toEqual([first!.path, last!.path]);
    expect(wtLists(calls, repo)).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** `change` runs while the first worktree is removed, after the batch-start listing. Returns only the batch's calls. */
async function removeWhileRefsMove(
  payload: any,
  order: WorktreeRow[],
  change: (tips: Record<string, string | null>) => void,
  options: { tips?: Record<string, string | null>; choices?: Record<string, RemovalChoice> } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    const tips: Record<string, string | null> = {
      "refs/heads/main": "aaa",
      "main@{upstream}": "aaa",
      "feature/name@{upstream}": "bbb",
      ...options.tips,
    };
    const { calls, runner } = fakeRepos({
      payloads: { [repo]: payload },
      tips,
      onRemove: (path) => {
        if (path === order[0]!.path) change(tips);
      },
    });
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval(order);
    expect(plan.entries.map((entry) => entry.blockedReason)).toEqual(order.map(() => null));
    const prepared = calls.length;
    const result = await actions.executeRemoval(
      plan,
      Object.fromEntries(
        order.map((row) => [row.id, options.choices?.[row.id] ?? { include: true }]),
      ),
    );
    return { result, calls: calls.slice(prepared) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a rewound default branch re-lists the repo before the next removal, which uses the fresh verdict", async () => {
  const payload = threeWorktrees();
  const [target, first, last] = parseWorktrunk(repo, JSON.stringify(payload));
  const { result, calls } = await removeWhileRefsMove(payload, [first!, target!, last!], (tips) => {
    tips["refs/heads/main"] = "older";
    payload.items[1].display.state = "ahead";
    payload.items[1].default_branch = { ahead: 1, behind: 0 };
  });
  expect(result.items).toEqual([
    { id: first!.id, status: "removed", branchOutcome: "deleted" },
    { id: target!.id, status: "skipped", error: "it changed; refresh and preview again" },
    { id: last!.id, status: "removed", branchOutcome: "deleted" },
  ]);
  expect(steps(calls).filter((step) => step === "wt list" || step.startsWith("remove"))).toEqual([
    "wt list",
    `remove ${first!.path}`,
    "wt list",
    `remove ${last!.path}`,
  ]);
});

test("a detached worktree is re-listed when the default branch moves", async () => {
  const payload: any = structuredClone(fixture);
  payload.items[2].display.state = "same_commit";
  const [first, detached] = parseWorktrunk(repo, JSON.stringify(payload));
  const { result, calls } = await removeWhileRefsMove(payload, [first!, detached!], (tips) => {
    tips["refs/heads/main"] = "older";
    payload.items[2].display.state = "ahead";
  });
  expect(result.items.map((item) => [item.status, item.error])).toEqual([
    ["removed", undefined],
    ["skipped", "it changed; refresh and preview again"],
  ]);
  expect(wtLists(calls, repo)).toBe(2);
  expect(removed(calls)).toEqual([first!.path]);
});

test("a forced branch deletion is re-listed when the branch's upstream moves", async () => {
  const payload: any = structuredClone(fixture);
  payload.items[1].display.state = "ahead";
  payload.items[1].default_branch = { ahead: 1, behind: 0 };
  const [unmerged, first] = parseWorktrunk(repo, JSON.stringify(payload));
  const { result, calls } = await removeWhileRefsMove(
    payload,
    [first!, unmerged!],
    (tips) => {
      tips["feature/name@{upstream}"] = "older";
      payload.items[1].upstream.ahead = 1;
    },
    { choices: { [unmerged!.id]: { include: true, forceDeleteBranch: true } } },
  );
  expect(result.items.map((item) => [item.status, item.error])).toEqual([
    ["removed", undefined],
    ["skipped", "it changed; refresh and preview again"],
  ]);
  expect(wtLists(calls, repo)).toBe(2);
  expect(calls.some((call) => call.includes("-D"))).toBe(false);
});

test.each<[string, Record<string, string | null>]>([
  ["no ref moved", {}],
  ["the upstream is still missing", { "feature/name@{upstream}": null }],
])("merge state is not derived again before a removal when %s", async (_name, startTips) => {
  const payload = threeWorktrees();
  const [target, first] = parseWorktrunk(repo, JSON.stringify(payload));
  const { result, calls } = await removeWhileRefsMove(
    payload,
    [first!, target!],
    () => {
      payload.items[1].display.state = "ahead";
      payload.items[1].default_branch = { ahead: 2, behind: 0 };
    },
    { tips: startTips },
  );
  expect(result.items.map((item) => item.status)).toEqual(["removed", "removed"]);
  expect(wtLists(calls, repo)).toBe(1);
  expect(calls.filter((call) => call.includes("--verify") && call.includes("-q"))).not.toHaveLength(
    0,
  );
});

test("a failing ref read right before a removal skips only that worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    let listed = false;
    let failed = false;
    const { calls, runner } = fakeRepos({
      payloads: { [repo]: fixture },
      tips: { "refs/heads/main": "aaa" },
      fails: (command, args) => {
        if (command === "/wt" && args.includes("list")) listed = true;
        if (!listed || failed || !args.includes("--verify") || !args.includes("-q")) return false;
        failed = true;
        return true;
      },
    });
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([branchRow, detachedRow]);
    listed = false;
    const result = await actions.executeRemoval(plan, {
      [branchRow.id]: { include: true },
      [detachedRow.id]: { include: true },
    });
    expect(result.items).toEqual([
      {
        id: branchRow.id,
        status: "skipped",
        error: "Error: git rev-parse exited 1: command failed",
      },
      { id: detachedRow.id, status: "removed", branchOutcome: "deleted" },
    ]);
    expect(removed(calls)).toEqual([detachedRow.path]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing listing when a repo's removals start skips only that repo's worktrees", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    let prepared = false;
    const { calls, runner } = fakeRepos({
      payloads: { [repo]: fixture, [repoB]: payloadB },
      fails: (command, args) =>
        prepared && command === "/wt" && args.includes("list") && args[1] === repo,
    });
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const input = [branchRow, branchRowB, detachedRow];
    const plan = await actions.prepareRemoval(input);
    prepared = true;
    const result = await actions.executeRemoval(
      plan,
      Object.fromEntries(input.map((row) => [row.id, { include: true }])),
    );
    const reason = "Error: wt list exited 1: command failed";
    expect(result.items).toEqual([
      { id: branchRow.id, status: "skipped", error: reason },
      { id: branchRowB.id, status: "removed", branchOutcome: "deleted" },
      { id: detachedRow.id, status: "skipped", error: reason },
    ]);
    expect(wtLists(calls, repo)).toBe(2);
    expect(removed(calls)).toEqual([branchRowB.path]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  [
    "git worktree list",
    (args: string[]) => args.includes("--porcelain"),
    "Error: git worktree list exited 1: command failed",
  ],
  [
    "git rev-parse",
    (args: string[]) => args.includes("--git-path"),
    "Error: git rev-parse exited 1: command failed",
  ],
  [
    "git status",
    (args: string[]) => args.includes("status"),
    "Could not inspect local files: command failed",
  ],
])(
  "a failing %s right before a removal skips only that worktree",
  async (_name, matches, reason) => {
    const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
    try {
      let prepared = false;
      let failed = false;
      const { calls, runner } = fakeRepos({
        payloads: { [repo]: fixture },
        fails: (_command, args) => {
          if (!prepared || failed || !matches(args)) return false;
          failed = true;
          return true;
        },
      });
      const actions = createActionService({
        wtPath: "/wt",
        runner,
        logPath: join(directory, "log"),
      });
      const plan = await actions.prepareRemoval([branchRow, detachedRow]);
      prepared = true;
      const result = await actions.executeRemoval(plan, {
        [branchRow.id]: { include: true },
        [detachedRow.id]: { include: true },
      });
      expect(result.items).toEqual([
        { id: branchRow.id, status: "skipped", error: reason },
        { id: detachedRow.id, status: "removed", branchOutcome: "deleted" },
      ]);
      expect(removed(calls)).toEqual([detachedRow.path]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("stopping mid-batch starts nothing new, including the next repo's listing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    const { calls, runner } = fakeRepos({ payloads: { [repo]: fixture, [repoB]: payloadB } });
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const input = [branchRow, branchRowB, detachedRow];
    const plan = await actions.prepareRemoval(input);
    const prepared = calls.length;
    const result = await actions.executeRemoval(
      plan,
      Object.fromEntries(input.map((row) => [row.id, { include: true }])),
      undefined,
      () => removed(calls).length > 0,
    );
    expect(result.items).toEqual([
      { id: branchRow.id, status: "removed", branchOutcome: "deleted" },
      { id: branchRowB.id, status: "skipped", error: "Cancelled" },
      { id: detachedRow.id, status: "skipped", error: "Cancelled" },
    ]);
    const batch = calls.slice(prepared);
    expect(wtLists(batch, repoB)).toBe(0);
    expect(batch.some((call) => call[2] === repoB || call[2] === detachedRow.path)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

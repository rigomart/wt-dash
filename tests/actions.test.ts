import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./fixtures/list-v2.json";
import { parseWorktrunk } from "../src/core/worktrunk";
import { createActionService } from "../src/core/actions";
import type { CommandRunner } from "../src/core/types";

const repo = "/Users/test/projects/sample";
const rows = parseWorktrunk(repo, JSON.stringify(fixture));
const branchRow = rows[0]!;
const detachedRow = rows[1]!;

function commandResult(stdout = "", exitCode = 0) {
  return { stdout, stderr: exitCode ? "command failed" : "", exitCode };
}

test("removes a safe worktree by path and records the branch outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("list")) return commandResult(args.includes("list.json-schema=2") ? JSON.stringify(fixture) : "[]");
    if (args.includes("status")) return commandResult();
    if (args.includes("remove")) return commandResult(JSON.stringify([{ kind: "worktree", branch: "feature/name", path: branchRow.path, branch_outcome: "deleted" }]));
    if (args.includes("prune")) return commandResult();
    return commandResult("Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/disk 100 10 90 10% /System/Volumes/Data\n");
  };
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "removals.log") });
    const plan = await actions.prepareRemoval([branchRow]);
    expect(plan.entries[0]?.blockedReason).toBeNull();
    const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
    expect(result.items).toEqual([{ id: branchRow.id, status: "removed", branchOutcome: "deleted" }]);
    expect(calls.some((call) => call[0] === "/wt" && call.includes("remove") && call.at(-1) === branchRow.path)).toBe(true);
    expect(calls.find((call) => call.includes("remove"))).toContain("--no-hooks");
    expect(calls.some((call) => call.includes("-f") || call.includes("-D") || call.includes("--reap"))).toBe(false);
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
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const runner: CommandRunner = async (_command, args) => {
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
    const first = actions.executeRemoval(await actions.prepareRemoval([branchRow]), { [branchRow.id]: { include: true } });
    const second = actions.executeRemoval(await actions.prepareRemoval([detachedRow]), { [detachedRow.id]: { include: true } });
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
  const runner: CommandRunner = async () => commandResult(
    "?? notes.md\n M src/app.ts\n!! .env\n!! data.sqlite\n!! node_modules/\n!! .turbo/\n");
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
    if (args.includes("remove")) { removes++; return commandResult(JSON.stringify({ kind: "worktree", path: dirtyRow.path, branch_outcome: "retained_unmerged" })); }
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
    if (args.includes("list")) return commandResult(JSON.stringify(++lists === 1 ? fixture : changed));
    if (args.includes("status")) return commandResult();
    if (args.includes("remove")) removes++;
    return commandResult();
  };
  const actions = createActionService({ wtPath: "/wt", runner, logPath: join(tmpdir(), "unused-action-log") });
  const plan = await actions.prepareRemoval([branchRow]);
  const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
  expect(result.items[0]?.status).toBe("skipped");
  expect(removes).toBe(0);
});

test("detached worktree removal passes its absolute path", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("list")) return commandResult(JSON.stringify(fixture));
    if (args.includes("status")) return commandResult();
    if (args.includes("remove")) return commandResult(JSON.stringify({ kind: "worktree", branch: null, path: detachedRow.path, branch_outcome: "not_attempted" }));
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
    if (args.includes("list")) return commandResult(JSON.stringify(fixture));
    if (args.includes("status")) return commandResult("!! .env\n!! node_modules/\n");
    if (args.includes("remove")) {
      removals.push(args);
      return commandResult(JSON.stringify({ kind: "worktree", path: branchRow.path, branch_outcome: "deleted" }));
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
  const actions = createActionService({ wtPath: "/wt", runner, logPath: join(tmpdir(), "unused-action-log") });
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
  const actions = createActionService({ wtPath: "/wt", runner, logPath: join(tmpdir(), "unused-action-log") });
  const plan = await actions.prepareRemoval([busyRow]);
  expect(plan.entries[0]?.blockedReason).toContain("rebase");
});

test("prune refuses to run when the dry-run record list changes", async () => {
  let checks = 0;
  let prunes = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("--dry-run")) return commandResult(++checks === 1 ? "prune old\n" : "prune other\n");
    if (args.includes("prune")) prunes++;
    return commandResult();
  };
  const actions = createActionService({ wtPath: "/wt", runner, logPath: join(tmpdir(), "unused-action-log") });
  const plan = await actions.preparePrune(repo);
  expect(plan.records).toEqual(["prune old"]);
  expect(actions.executePrune(plan)).rejects.toThrow("changed");
  expect(prunes).toBe(0);
});

test("reports an unverified result when Worktrunk succeeds but its output cannot be parsed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const runner: CommandRunner = async (_command, args) => {
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
    if (args.includes("list")) {
      if (++lists > 1) Object.assign(marked.items[1]!, { marker: "💬" });
      return commandResult(JSON.stringify(marked));
    }
    if (args.includes("remove")) return commandResult(JSON.stringify({ kind: "worktree", path: row.path, branch_outcome: "deleted" }));
    return commandResult();
  };
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([row]);
    expect(plan.entries[0]?.blockedReason).toBeNull();
    const result = await actions.executeRemoval(plan, { [row.id]: { include: true } });
    expect(result.items[0]?.status).toBe("removed");
    expect(lists).toBe(2);
    expect(calls.some(call => call[0] === "lsof" || call[0] === "ps" || call.includes("--get-regexp"))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["lock", "conflict", "unknown status"])("a fresh Git check blocks a %s appearing after confirmation", async blocker => {
  const changed: any = structuredClone(fixture);
  if (blocker === "lock") changed.items[1].worktree.locked = { reason: "manual lock" };
  if (blocker === "conflict") changed.items[1].worktree.changes.conflicted = true;
  if (blocker === "unknown status") delete changed.items[1].worktree.changes;
  let lists = 0;
  let removals = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("list")) return commandResult(JSON.stringify(++lists === 1 ? fixture : changed));
    if (args.includes("remove")) removals++;
    return commandResult();
  };
  const actions = createActionService({ wtPath: "/wt", runner, logPath: join(tmpdir(), "unused-action-log") });
  const plan = await actions.prepareRemoval([branchRow]);
  expect(plan.entries[0]?.blockedReason).toBeNull();
  const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
  expect(result.items[0]?.status).toBe("skipped");
  expect(removals).toBe(0);
});

test("new local files after confirmation prevent removal", async () => {
  let statuses = 0;
  let removals = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("list")) return commandResult(JSON.stringify(fixture));
    if (args.includes("status")) return commandResult(++statuses === 1 ? "" : "?? new-notes.md\n");
    if (args.includes("remove")) removals++;
    return commandResult();
  };
  const actions = createActionService({ wtPath: "/wt", runner, logPath: join(tmpdir(), "unused-action-log") });
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
  const runner: CommandRunner = async (_command, args) => args.includes("list") ? commandResult(JSON.stringify(locked)) : commandResult();
  const service = createActionService({ wtPath: "/wt", runner, logPath: join(tmpdir(), "unused-action-log") });
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

function twoRepoRunner(calls: string[][], listA: () => Promise<ReturnType<typeof commandResult>> = async () => commandResult(JSON.stringify(fixture))): CommandRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("list")) return args[1] === repo ? listA() : commandResult(JSON.stringify(payloadB));
    if (args.includes("remove")) return commandResult(JSON.stringify({ kind: "worktree", path: args.at(-1), branch_outcome: "deleted" }));
    return commandResult();
  };
}

test("preview lists each repo and reads its comparison base once", async () => {
  const calls: string[][] = [];
  const actions = createActionService({ wtPath: "/wt", runner: twoRepoRunner(calls), logPath: "/unused" });
  const plan = await actions.prepareRemoval([branchRow, detachedRow, branchRowB, detachedRowB]);
  expect(plan.entries.map((entry) => entry.blockedReason)).toEqual([null, null, null, null]);
  for (const target of [repo, repoB]) {
    expect(calls.filter((call) => call.includes("list") && call[2] === target)).toHaveLength(1);
    expect(calls.filter((call) => call.includes("rev-parse") && call[2] === target)).toHaveLength(1);
  }
  expect(calls.filter((call) => call.includes("status"))).toHaveLength(4);
});

test("preview keeps input order across repos listed in parallel", async () => {
  const calls: string[][] = [];
  const slowA = async () => { await Bun.sleep(20); return commandResult(JSON.stringify(fixture)); };
  const actions = createActionService({ wtPath: "/wt", runner: twoRepoRunner(calls, slowA), logPath: "/unused" });
  const input = [branchRow, branchRowB, detachedRow, detachedRowB];
  const plan = await actions.prepareRemoval(input);
  expect(plan.entries.map((entry) => entry.row.id)).toEqual(input.map((row) => row.id));
  const listB = calls.findIndex((call) => call.includes("list") && call[2] === repoB);
  const statusA = calls.findIndex((call) => call.includes("status") && call[2] === branchRow.path);
  expect(listB).toBeLessThan(statusA);
});

test.each([
  ["exits non-zero", async () => commandResult("", 1), "Error: wt list exited 1: command failed"],
  ["throws", async () => { throw new Error("spawn failed"); }, "Error: spawn failed"],
  ["returns an unknown schema", async () => commandResult(JSON.stringify({ ...fixture, schema: 3 })),
    "SchemaMismatchError: Worktrunk JSON schema changed: expected 2, received 3"],
] as const)("a listing that %s blocks only its own repo's rows", async (_name, listA, reason) => {
  const calls: string[][] = [];
  const actions = createActionService({ wtPath: "/wt", runner: twoRepoRunner(calls, listA), logPath: "/unused" });
  const plan = await actions.prepareRemoval([branchRow, branchRowB, detachedRow, detachedRowB]);
  const blocked = (row: typeof branchRow) => ({ row, blockedReason: reason, localFiles: [], ignoredFiles: [],
    disposableIgnored: 0, requiresDiscard: false, branchWillBeRetained: false });
  expect(plan.entries[0]).toEqual(blocked(branchRow));
  expect(plan.entries[2]).toEqual(blocked(detachedRow));
  const alone = createActionService({ wtPath: "/wt", runner: twoRepoRunner([]), logPath: "/unused" });
  expect([plan.entries[1], plan.entries[3]]).toEqual((await alone.prepareRemoval([branchRowB, detachedRowB])).entries);
  expect(calls.some((call) => call[0] === "git" && call[2] === repo)).toBe(false);
});

test("removal lists the repo again right before each removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const calls: string[][] = [];
  try {
    const actions = createActionService({ wtPath: "/wt", runner: twoRepoRunner(calls), logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([branchRow, detachedRow]);
    const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true }, [detachedRow.id]: { include: true } });
    expect(result.items.map((item) => item.status)).toEqual(["removed", "removed"]);
    const wt = calls.filter((call) => call[0] === "/wt").map((call) => call.includes("remove") ? `remove ${call.at(-1)}` : "list");
    expect(wt).toEqual(["list", "list", `remove ${branchRow.path}`, "list", `remove ${detachedRow.path}`]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function repoRows(path: string) {
  const payload = structuredClone(fixture);
  payload.items[0]!.worktree!.path = path;
  payload.items[1]!.worktree!.path = `${path}/.claude/worktrees/b`;
  payload.items[2]!.worktree!.path = `${path}-detached`;
  return { payload, rows: parseWorktrunk(path, JSON.stringify(payload)) };
}

/** Fake Git and Worktrunk across repos; with `hold`, each `wt remove` waits until the test releases its path. */
function parallelRunner(repos: Array<ReturnType<typeof repoRows>>, options: {
  hold?: boolean; remove?: (path: string) => ReturnType<typeof commandResult>; prune?: ReturnType<typeof commandResult>;
} = {}) {
  const events: string[] = [];
  const running = new Set<string>();
  let peak = 0;
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const gate = (path: string) => {
    if (!gates.has(path)) {
      let resolve!: () => void;
      gates.set(path, { promise: new Promise<void>((done) => { resolve = done; }), resolve });
    }
    return gates.get(path)!;
  };
  const waiters: Array<() => void> = [];
  const started = () => events.filter((event) => event.startsWith("start ")).map((event) => event.slice(6));
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("list")) {
      events.push(`list ${args[1]}`);
      return commandResult(JSON.stringify(repos.find((item) => item.rows[0]!.repoPath === args[1])!.payload));
    }
    if (args.includes("remove")) {
      const path = args.at(-1)!;
      running.add(path);
      peak = Math.max(peak, running.size);
      events.push(`start ${path}`);
      waiters.splice(0).forEach((wake) => wake());
      if (options.hold) await gate(path).promise;
      running.delete(path);
      events.push(`end ${path}`);
      return options.remove?.(path) ?? commandResult(JSON.stringify({ kind: "worktree", path, branch_outcome: "deleted" }));
    }
    if (args.includes("prune")) return options.prune ?? commandResult();
    return commandResult();
  };
  async function untilStarted(count: number): Promise<string[]> {
    while (started().length < count) await new Promise<void>((wake) => waiters.push(wake));
    return started();
  }
  return { runner, events, running, peak: () => peak, release: (path: string) => gate(path).resolve(), untilStarted };
}

async function withActions(runner: CommandRunner, body: (actions: ReturnType<typeof createActionService>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try { await body(createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") })); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const include = (rows: Array<{ id: string }>) => Object.fromEntries(rows.map((row) => [row.id, { include: true }]));
const repoP = repoRows("/Users/test/repos/p");
const repoQ = repoRows("/Users/test/repos/q");
const repoR = repoRows("/Users/test/repos/r");
const repoS = repoRows("/Users/test/repos/s");

test("removals in different repos overlap, at most three at once", async () => {
  const fake = parallelRunner([repoP, repoQ, repoR, repoS], { hold: true });
  await withActions(fake.runner, async (actions) => {
    const input = [repoP.rows[0]!, repoQ.rows[0]!, repoR.rows[0]!, repoS.rows[0]!];
    const run = actions.executeRemoval(await actions.prepareRemoval(input), include(input));
    expect(await fake.untilStarted(3)).toEqual(input.slice(0, 3).map((row) => row.path));
    expect(fake.running.size).toBe(3);
    fake.release(input[1]!.path);
    expect((await fake.untilStarted(4))[3]).toBe(input[3]!.path);
    for (const row of input) fake.release(row.path);
    expect((await run).items.map((item) => item.status)).toEqual(["removed", "removed", "removed", "removed"]);
    expect(fake.peak()).toBe(3);
  });
});

test("removals in one repo run one at a time in plan order, each right after its own listing", async () => {
  const fake = parallelRunner([repoP, repoQ], { hold: true });
  await withActions(fake.runner, async (actions) => {
    const [p1, p2] = repoP.rows as [typeof branchRow, typeof branchRow];
    const [q1, q2] = repoQ.rows as [typeof branchRow, typeof branchRow];
    const input = [p1, q1, p2, q2];
    const plan = await actions.prepareRemoval(input);
    fake.events.length = 0;
    const run = actions.executeRemoval(plan, include(input));
    expect(await fake.untilStarted(2)).toEqual([p1.path, q1.path]);
    fake.release(q1.path);
    expect((await fake.untilStarted(3))[2]).toBe(q2.path);
    expect(fake.running.has(p2.path)).toBe(false);
    for (const row of input) fake.release(row.path);
    expect((await run).items.map((item) => item.status)).toEqual(["removed", "removed", "removed", "removed"]);
    for (const [first, second] of [[p1, p2], [q1, q2]]) {
      expect(fake.events.filter((event) => event.includes(first!.repoPath))).toEqual([`list ${first!.repoPath}`,
        `start ${first!.path}`, `end ${first!.path}`, `list ${first!.repoPath}`, `start ${second!.path}`, `end ${second!.path}`]);
    }
  });
});

test("results and warnings keep plan order when a later repo finishes first", async () => {
  const fake = parallelRunner([repoP, repoQ], { hold: true, remove: () => commandResult("not JSON"), prune: commandResult("", 1) });
  await withActions(fake.runner, async (actions) => {
    const [p1, q1] = [repoP.rows[0]!, repoQ.rows[0]!];
    const finished: string[] = [];
    let laterDone!: () => void;
    const laterFinished = new Promise<void>((resolve) => { laterDone = resolve; });
    const run = actions.executeRemoval(await actions.prepareRemoval([p1, q1]), include([p1, q1]), (id, status) => {
      if (status === "removing") return;
      finished.push(id);
      if (id === q1.id) laterDone();
    });
    await fake.untilStarted(2);
    fake.release(q1.path);
    await laterFinished;
    fake.release(p1.path);
    const result = await run;
    expect(finished).toEqual([q1.id, p1.id]);
    expect(result.items.map((item) => [item.id, item.status])).toEqual([[p1.id, "unverified"], [q1.id, "unverified"]]);
    expect(result.warnings).toEqual([
      `Removal outcome for ${p1.path} could not be verified; check the refreshed list`,
      `Removal outcome for ${q1.path} could not be verified; check the refreshed list`,
      `Could not prune ${p1.repoPath}: command failed`,
      `Could not prune ${q1.repoPath}: command failed`,
    ]);
  });
});

test("stop lets running removals finish, starts nothing new, and cancels the rest", async () => {
  const fake = parallelRunner([repoP, repoQ, repoR, repoS], { hold: true });
  await withActions(fake.runner, async (actions) => {
    const input = [repoP.rows[0]!, repoP.rows[1]!, repoQ.rows[0]!, repoR.rows[0]!, repoS.rows[0]!];
    const terminal: string[] = [];
    let stop = false;
    const run = actions.executeRemoval(await actions.prepareRemoval(input), include(input),
      (id, status) => { if (status !== "removing") terminal.push(id); }, () => stop);
    expect(await fake.untilStarted(3)).toEqual([input[0]!.path, input[2]!.path, input[3]!.path]);
    stop = true;
    for (const row of input) fake.release(row.path);
    const result = await run;
    expect(result.items).toEqual([
      { id: input[0]!.id, status: "removed", branchOutcome: "deleted" },
      { id: input[1]!.id, status: "skipped", error: "Cancelled" },
      { id: input[2]!.id, status: "removed", branchOutcome: "deleted" },
      { id: input[3]!.id, status: "removed", branchOutcome: "deleted" },
      { id: input[4]!.id, status: "skipped", error: "Cancelled" },
    ]);
    expect(fake.events.filter((event) => event.startsWith("start "))).toHaveLength(3);
    expect([...terminal].sort()).toEqual(input.map((row) => row.id).sort());
  });
});

test("a failed removal in one repo leaves the other repo's removals alone", async () => {
  const fake = parallelRunner([repoP, repoQ], { remove: (path) => path === repoP.rows[0]!.path
    ? commandResult("", 1) : commandResult(JSON.stringify({ kind: "worktree", path, branch_outcome: "deleted" })) });
  await withActions(fake.runner, async (actions) => {
    const input = [repoP.rows[0]!, repoQ.rows[0]!, repoP.rows[1]!, repoQ.rows[1]!];
    const result = await actions.executeRemoval(await actions.prepareRemoval(input), include(input));
    expect(result.items.map((item) => item.status)).toEqual(["failed", "removed", "removed", "removed"]);
    expect(result.items[0]?.error).toBe("Error: wt remove exited 1: command failed");
    expect(result.warnings).toEqual([]);
  });
});

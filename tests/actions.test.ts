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

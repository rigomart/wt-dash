import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/list-v2.json";
import { parseWorktrunk } from "../../src/core/worktrunk/list";
import {
  branchRow,
  branchRowB,
  commandResult,
  detachedRow,
  detachedRowB,
  fakeRepos,
  noNewCommits,
  removed,
  repo,
  repoB,
  twoRepoRunner,
} from "./helpers";
import { createActionService } from "../../src/core/removal/service";
import type { CommandRunner } from "../../src/core/types";

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

test("preview keeps the measured size of each row", async () => {
  const actions = createActionService({
    wtPath: "/wt",
    runner: twoRepoRunner([]),
    logPath: "/unused",
  });
  const sized = { ...branchRow, sizeKiB: 2048, sizeMeasuredAt: "2026-01-01T00:00:00.000Z" };
  const plan = await actions.prepareRemoval([sized]);
  expect(plan.entries[0]?.blockedReason).toBeNull();
  expect(plan.entries[0]?.row).toMatchObject({
    sizeKiB: 2048,
    sizeMeasuredAt: "2026-01-01T00:00:00.000Z",
  });
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

test("a young worktree with no new commits is previewed as Review and removed only when chosen", async () => {
  const payload = noNewCommits();
  const createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const row = { ...parseWorktrunk(repo, JSON.stringify(payload))[0]!, createdAt };
  const { calls, runner } = fakeRepos({ payloads: { [repo]: payload } });
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    const actions = createActionService({
      wtPath: "/wt",
      runner,
      logPath: join(directory, "log"),
      readCreated: async () => createdAt,
    });
    const plan = await actions.prepareRemoval([row]);
    expect(plan.entries[0]).toMatchObject({
      blockedReason: null,
      row: { verdict: "Review", reason: "Created 2h ago, so it may still be in use." },
    });
    const result = await actions.executeRemoval(plan, { [row.id]: { include: true } });
    expect(result.items.map((item) => item.status)).toEqual(["removed"]);
    expect(removed(calls)).toEqual([row.path!]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/list-v2.json";
import { parseWorktrunk } from "../../src/core/worktrunk/list";
import {
  aged,
  branchOnly,
  branchRemoved,
  branchRow,
  commandResult,
  fakeRepos,
  noNewCommits,
  removed,
  repo,
  threeWorktrees,
  withBranch,
  worktreeState,
  wtLists,
} from "./helpers";
import { createActionService } from "../../src/core/removal/service";
import type { CommandRunner } from "../../src/core/types";

/** Worktrunk's state in Git config, as `git config --null --get-regexp` prints it. */
function markConfig(marks: Record<string, { marker: string; setAt: number }>): string {
  return Object.entries(marks)
    .map(
      ([branch, mark]) =>
        `worktrunk.state.${branch}.marker\n${JSON.stringify({ marker: mark.marker, set_at: Math.floor(mark.setAt / 1000) })}\0`,
    )
    .join("");
}

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

test.each([
  ["switching between agent marks keeps", "🤖", "💬", "removed"],
  ["an agent mark set after the preview invalidates", null, "🤖", "skipped"],
] as const)("%s the confirmation, without process checks", async (_name, before, after, status) => {
  const payload: any = structuredClone(fixture);
  const marks: Record<string, { marker: string; setAt: number }> = {};
  const mark = (marker: string | null) => {
    payload.items[1].marker = marker ?? undefined;
    if (marker) marks["feature/name"] = { marker, setAt: Date.now() - 60_000 };
    else delete marks["feature/name"];
  };
  mark(before);
  let lists = 0;
  const calls: string[][] = [];
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const state = worktreeState(args, payload);
    if (state) return state;
    if (args.includes("--get-regexp")) return commandResult(markConfig(marks));
    if (args.includes("list")) {
      if (++lists > 1) mark(after);
      return commandResult(JSON.stringify(payload));
    }
    if (args.includes("remove"))
      return commandResult(
        JSON.stringify({ kind: "worktree", path: branchRow.path, branch_outcome: "deleted" }),
      );
    return commandResult();
  };
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([{ ...branchRow, marker: before }]);
    expect(plan.entries[0]?.blockedReason).toBeNull();
    expect(plan.entries[0]?.row.verdict).toBe(before ? "Review" : "Safe");
    const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
    expect(result.items[0]?.status).toBe(status);
    expect(lists).toBe(2);
    expect(calls.some((call) => call[0] === "lsof" || call[0] === "ps")).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an agent mark set after the batch's listing still skips the removal", async () => {
  const marks: Record<string, { marker: string; setAt: number }> = {};
  const readsByPreviewAndBatchListing = 2;
  let reads = 0;
  let removals = 0;
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  const runner: CommandRunner = async (_command, args) => {
    const state = worktreeState(args, fixture);
    if (state) return state;
    if (args.includes("--get-regexp")) {
      if (++reads > readsByPreviewAndBatchListing)
        marks["feature/name"] = { marker: "🤖", setAt: Date.now() };
      return commandResult(markConfig(marks));
    }
    if (args.includes("list")) return commandResult(JSON.stringify(fixture));
    if (args.includes("remove")) removals++;
    return commandResult();
  };
  try {
    const actions = createActionService({ wtPath: "/wt", runner, logPath: join(directory, "log") });
    const plan = await actions.prepareRemoval([branchRow]);
    expect(plan.entries[0]?.row.verdict).toBe("Safe");
    const result = await actions.executeRemoval(plan, { [branchRow.id]: { include: true } });
    expect(result.items[0]).toMatchObject({
      status: "skipped",
      error: "an agent started work here; refresh and preview again",
    });
    expect(removals).toBe(0);
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
      gitDirs: { [target!.path!]: gitDir },
      onRemove: async (path) => {
        if (path !== first!.path) return;
        change.payload?.(payload.items[1]);
        if (change.status) statuses[target!.path!] = change.status;
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
    expect(removed(calls)).toEqual([first!.path!, last!.path!]);
    expect(wtLists(calls, repo)).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a worktree created again at the same path after the preview is skipped", async () => {
  const payload = noNewCommits();
  let createdAt = "2026-09-27T00:00:00Z";
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
    expect(plan.entries[0]).toMatchObject({ blockedReason: null, row: { verdict: "Safe" } });
    createdAt = new Date().toISOString();
    const result = await actions.executeRemoval(plan, { [row.id]: { include: true } });
    expect(result.items).toEqual([
      { id: row.id, status: "skipped", error: "it changed; refresh and preview again" },
    ]);
    expect(removed(calls)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a worktree created again at the same path after the repo's removals start is skipped, and unknown birth times are not a change (#22)", async () => {
  const payload = threeWorktrees();
  const [target, first, last] = parseWorktrunk(repo, JSON.stringify(payload));
  const created: Record<string, string> = { [target!.path!]: "2026-09-27T00:00:00Z" };
  const { calls, runner } = fakeRepos({
    payloads: { [repo]: payload },
    onRemove: (path) => {
      if (path === first!.path) created[target!.path!] = new Date().toISOString();
    },
  });
  const actions = createActionService({
    wtPath: "/wt",
    runner,
    logPath: "/dev/null",
    readCreated: async (path) => created[path] ?? null,
  });
  const input = [first!, { ...target!, createdAt: created[target!.path!]! }, last!];
  const plan = await actions.prepareRemoval(input);
  expect(plan.entries.map((entry) => entry.blockedReason)).toEqual([null, null, null]);
  const result = await actions.executeRemoval(
    plan,
    Object.fromEntries(input.map((row) => [row.id, { include: true }])),
  );
  expect(result.items).toEqual([
    { id: first!.id, status: "removed", branchOutcome: "deleted" },
    { id: target!.id, status: "skipped", error: "it changed; refresh and preview again" },
    { id: last!.id, status: "removed", branchOutcome: "deleted" },
  ]);
  expect(removed(calls)).toEqual([first!.path!, last!.path!]);
  expect(wtLists(calls, repo)).toBe(2);
});

test.each<[string, (payload: any, tips: Record<string, string | null>) => void, string]>([
  [
    "moved",
    (_payload, tips) => (tips["refs/heads/old"] = "newer"),
    "it changed; refresh and preview again",
  ],
  [
    "was deleted",
    (_payload, tips) => (tips["refs/heads/old"] = null),
    "it is missing or now has a worktree",
  ],
  [
    "gained a worktree",
    (payload) =>
      payload.items.push({
        branch: "old",
        head: { sha: "old-sha" },
        worktree: { path: "/Users/test/new-worktree", main: false },
      }),
    "it is missing or now has a worktree",
  ],
])(
  "a branch without a worktree that %s after the repo's removals start is skipped",
  async (_name, change, reason) => {
    const payload = withBranch("integrated");
    const row = branchOnly(payload);
    const tips: Record<string, string | null> = { "refs/heads/old": "old-sha" };
    const { calls, runner } = fakeRepos({
      payloads: { [repo]: payload },
      tips,
      removeOutput: (target) =>
        target === "old"
          ? branchRemoved()
          : JSON.stringify({ kind: "worktree", path: target, branch_outcome: "deleted" }),
      onRemove: (target) => {
        if (target === branchRow.path) change(payload, tips);
      },
    });
    const actions = createActionService({ wtPath: "/wt", runner, logPath: "/dev/null", ...aged });
    const plan = await actions.prepareRemoval([branchRow, row]);
    const result = await actions.executeRemoval(plan, {
      [branchRow.id]: { include: true },
      [row.id]: { include: true },
    });
    expect(result.items[1]).toEqual({ id: row.id, status: "skipped", error: reason });
    expect(removed(calls)).toEqual([branchRow.path!]);
  },
);

test("a branch that gained a worktree between preview and confirmation is skipped", async () => {
  const payload = withBranch("integrated");
  const row = branchOnly(payload);
  const { calls, runner } = fakeRepos({ payloads: { [repo]: payload } });
  const actions = createActionService({ wtPath: "/wt", runner, logPath: "/dev/null", ...aged });
  const plan = await actions.prepareRemoval([row]);
  const item = payload.items.at(-1);
  item.worktree = {
    path: "/Users/test/new-worktree",
    main: false,
    changes: fixture.items[1]!.worktree!.changes,
  };
  const result = await actions.executeRemoval(plan, { [row.id]: { include: true } });
  expect(result.items[0]).toMatchObject({
    status: "skipped",
    error: "it is missing or now has a worktree",
  });
  expect(removed(calls)).toEqual([]);
});

test("a branch named like a worktree's folder is not removed, since Worktrunk would remove the worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    const root = join(directory, "repo");
    await mkdir(join(root, "wt-x"), { recursive: true });
    const payload: any = structuredClone(fixture);
    payload.items[0].worktree.path = root;
    payload.items[1].worktree.path = join(root, "wt-x");
    payload.items.push({
      branch: "wt-x",
      head: { sha: "x-sha" },
      default_branch: { ahead: 0, behind: 0, integration: { reason: "same_commit" } },
      display: { state: "empty" },
    });
    const row = branchOnly(payload, root);
    const { calls, runner } = fakeRepos({
      payloads: { [root]: payload },
      tips: { "refs/heads/wt-x": "x-sha" },
    });
    const actions = createActionService({ wtPath: "/wt", runner, logPath: "/dev/null", ...aged });
    const result = await actions.executeRemoval(await actions.prepareRemoval([row]), {
      [row.id]: { include: true },
    });
    expect(result.items[0]).toMatchObject({
      status: "skipped",
      error:
        "a worktree folder has the same name, so Worktrunk would remove that instead; delete it with git branch",
    });
    expect(removed(calls)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

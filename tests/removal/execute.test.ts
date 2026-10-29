import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/list-v2.json";
import { parseWorktrunk } from "../../src/core/worktrunk/list";
import {
  aged,
  branchOnly,
  branchRemoved,
  branchRow,
  branchRowB,
  commandResult,
  detachedRow,
  fakeRepos,
  payloadB,
  removed,
  repo,
  repoB,
  threeWorktrees,
  twoRepoRunner,
  withBranch,
  worktreeState,
  wtLists,
} from "./helpers";
import { createActionService } from "../../src/core/removal/service";
import type { RemovalChoice } from "../../src/core/removal/types";
import type { CommandRunner, WorktreeRow } from "../../src/core/types";

function steps(calls: string[][]): string[] {
  return calls.flatMap((call) => {
    if (call[0] === "/wt") return [call.includes("remove") ? `remove ${call.at(-1)}` : "wt list"];
    if (call.includes("--porcelain")) return ["worktree list"];
    if (call.includes("--git-path")) return [`git operation ${call[2]}`];
    if (call.includes("status")) return [`status ${call[2]}`];
    return [];
  });
}

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
    expect(calls.find((call) => call.includes("remove"))?.at(-1)).toBe(detachedRow.path!);
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
    expect(removed(batch)).toEqual([branchRow.path!, detachedRow.path!, branchRowB.path!]);
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
  expect(removed(calls)).toEqual([first!.path!]);
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
    expect(removed(calls)).toEqual([detachedRow.path!]);
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
    expect(removed(calls)).toEqual([branchRowB.path!]);
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
      expect(removed(calls)).toEqual([detachedRow.path!]);
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

test("removes a merged branch without a worktree by name, checking no files and stopping no processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-action-"));
  try {
    const payload = withBranch("integrated");
    const row = branchOnly(payload);
    const { calls, runner } = fakeRepos({
      payloads: { [repo]: payload },
      tips: { "refs/heads/old": "old-sha" },
      removeOutput: () => branchRemoved(),
    });
    const actions = createActionService({
      wtPath: "/wt",
      runner,
      logPath: join(directory, "log"),
      ...aged,
    });
    const plan = await actions.prepareRemoval([row]);
    expect(plan.entries[0]).toMatchObject({
      blockedReason: null,
      requiresDiscard: false,
      branchWillBeRetained: false,
      row: { verdict: "Safe" },
    });
    const result = await actions.executeRemoval(plan, {
      [row.id]: { include: true, reapProcesses: true },
    });
    expect(result.items).toEqual([{ id: row.id, status: "removed", branchOutcome: "deleted" }]);
    expect(calls.find((call) => call.includes("remove"))).toEqual([
      "/wt",
      "-C",
      repo,
      "remove",
      "-y",
      "--no-hooks",
      "--foreground",
      "--format=json",
      "old",
    ]);
    expect(calls.some((call) => call.includes("status"))).toBe(false);
    expect(calls.some((call) => call.includes("prune"))).toBe(false);
    const log = JSON.parse((await readFile(join(directory, "log"), "utf8")).trim());
    expect(log).toMatchObject({
      branch: "old",
      path: null,
      branchOutcome: "deleted",
      pruned: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["ahead", "would_conflict", "orphan"])(
  "a branch without a worktree that is %s is removed only with forced deletion",
  async (state) => {
    const payload = withBranch(state);
    const row = branchOnly(payload);
    const { calls, runner } = fakeRepos({
      payloads: { [repo]: payload },
      tips: { "refs/heads/old": "old-sha" },
      removeOutput: () => branchRemoved(),
    });
    const actions = createActionService({ wtPath: "/wt", runner, logPath: "/dev/null", ...aged });
    const plan = await actions.prepareRemoval([row]);
    expect(plan.entries[0]).toMatchObject({ blockedReason: null, branchWillBeRetained: true });
    expect(
      (await actions.executeRemoval(plan, { [row.id]: { include: true } })).items[0],
    ).toMatchObject({ status: "skipped", error: "Deleting the unmerged branch was not confirmed" });
    expect(removed(calls)).toEqual([]);
    const forced = await actions.executeRemoval(await actions.prepareRemoval([row]), {
      [row.id]: { include: true, forceDeleteBranch: true },
    });
    expect(forced.items[0]?.status).toBe("removed");
    expect(calls.find((call) => call.includes("remove"))?.slice(-2)).toEqual(["-D", "old"]);
  },
);

test("a branch Worktrunk keeps counts as not removed", async () => {
  const payload = withBranch("integrated");
  const row = branchOnly(payload);
  const { runner } = fakeRepos({
    payloads: { [repo]: payload },
    tips: { "refs/heads/old": "old-sha" },
    removeOutput: () => branchRemoved("retained_unmerged"),
  });
  const actions = createActionService({ wtPath: "/wt", runner, logPath: "/dev/null", ...aged });
  const result = await actions.executeRemoval(await actions.prepareRemoval([row]), {
    [row.id]: { include: true },
  });
  expect(result.items[0]).toEqual({
    id: row.id,
    status: "failed",
    branchOutcome: "retained_unmerged",
    error: "Worktrunk kept the branch (retained unmerged)",
  });
});

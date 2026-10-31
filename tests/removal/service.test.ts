import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/list-v2.json";
import {
  branchRow,
  branchRowB,
  commandResult,
  detachedRow,
  repo,
  twoRepoRunner,
  worktreeState,
} from "./helpers";
import { createActionService } from "../../src/core/removal/service";
import type { CommandRunner } from "../../src/core/types";
import { named, record } from "../support/runners";

for (const olderFinishesFirst of [true, false]) {
  test(`#63: cancelled preview retry: latest removal request wins when older finishes ${olderFinishesFirst ? "first" : "last"}`, async () => {
    const recorder = record(twoRepoRunner([]));
    const actions = createActionService({
      wtPath: "/wt",
      runner: recorder.runner,
      logPath: "/dev/null",
    });
    const olderGate = recorder.gate(named("wt", "list"));
    const older = actions.prepareRemoval([branchRow]);
    await olderGate.reached;
    const newerGate = recorder.gate(named("wt", "list"));
    const newer = actions.prepareRemoval([branchRowB]);
    await newerGate.reached;
    try {
      if (olderFinishesFirst) {
        olderGate.release();
        await expect(actions.executeRemoval(await older, {})).rejects.toThrow(
          "Removal preview is stale",
        );
        newerGate.release();
      } else {
        newerGate.release();
        await newer;
        olderGate.release();
        await older;
      }
      const plan = await newer;
      await expect(actions.executeRemoval(await older, {})).rejects.toThrow(
        "Removal preview is stale",
      );
      await expect(actions.executeRemoval(plan, {})).resolves.toMatchObject({
        items: [{ id: branchRowB.id, status: "skipped", error: "Not confirmed" }],
      });
      await expect(actions.executeRemoval(plan, {})).rejects.toThrow("Removal preview is stale");
    } finally {
      recorder.releaseAll();
    }
  });

  test(`#63: cancelled preview retry: latest prune request wins when older finishes ${olderFinishesFirst ? "first" : "last"}`, async () => {
    const recorder = record(async () => commandResult("prune missing\n"));
    const actions = createActionService({
      wtPath: "/wt",
      runner: recorder.runner,
      logPath: "/dev/null",
    });
    const olderGate = recorder.gate(named("git", "prune"));
    const older = actions.preparePrune("/repo/older");
    await olderGate.reached;
    const newerGate = recorder.gate(named("git", "prune"));
    const newer = actions.preparePrune("/repo/newer");
    await newerGate.reached;
    try {
      if (olderFinishesFirst) {
        olderGate.release();
        await expect(actions.executePrune(await older)).rejects.toThrow("Prune preview is stale");
        newerGate.release();
      } else {
        newerGate.release();
        await newer;
        olderGate.release();
        await older;
      }
      const plan = await newer;
      await expect(actions.executePrune(await older)).rejects.toThrow("Prune preview is stale");
      await expect(actions.executePrune(plan)).resolves.toBeUndefined();
      await expect(actions.executePrune(plan)).rejects.toThrow("Prune preview is stale");
    } finally {
      recorder.releaseAll();
    }
  });
}

test("#63: a new removal request immediately invalidates a completed preview", async () => {
  const recorder = record(twoRepoRunner([]));
  const actions = createActionService({
    wtPath: "/wt",
    runner: recorder.runner,
    logPath: "/dev/null",
  });
  const completed = await actions.prepareRemoval([branchRow]);
  const gate = recorder.gate(named("wt", "list"));
  const pending = actions.prepareRemoval([branchRowB]);
  try {
    await gate.reached;
    await expect(actions.executeRemoval(completed, {})).rejects.toThrow("Removal preview is stale");
  } finally {
    recorder.releaseAll();
    await pending;
  }
});

test("#63: a failed newer prune request does not restore an older preview", async () => {
  const recorder = record(async () => commandResult("prune missing\n"));
  const actions = createActionService({
    wtPath: "/wt",
    runner: recorder.runner,
    logPath: "/dev/null",
  });
  const completed = await actions.preparePrune("/repo/completed");
  const gate = recorder.gate(named("git", "prune"));
  const older = actions.preparePrune("/repo/older");
  try {
    await gate.reached;
    const restore = recorder.override(
      (call) => call.args.includes("/repo/newer"),
      commandResult("", 1),
    );
    await expect(actions.preparePrune("/repo/newer")).rejects.toThrow("git worktree prune");
    restore();
    await expect(actions.executePrune(completed)).rejects.toThrow("Prune preview is stale");
    gate.release();
    await expect(actions.executePrune(await older)).rejects.toThrow("Prune preview is stale");
  } finally {
    recorder.releaseAll();
    await older;
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
    expect(removed).toEqual([branchRow.path!, detachedRow.path!]);
    await expect(actions.preparePrune(repo)).resolves.toMatchObject({ repoPath: repo });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

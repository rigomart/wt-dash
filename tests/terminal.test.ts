import { expect, test } from "bun:test";
import { runTerminal } from "../src/ui/terminal";
import type { ActionService, RemovalEntry } from "../src/core/actions";
import type { DashboardService, DashboardSnapshot, WorktreeRow } from "../src/core/types";

function row(id: string, sizeKiB: number, overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id, repoPath: "/repos/alpha", repoName: "alpha", path: `/repos/alpha/worktrees/${id}`,
    branch: id, headSha: "abcdef1234", committedAt: "2026-09-28T00:00:00Z", tool: "Claude",
    changes: { staged: false, modified: false, untracked: false, renamed: false, deleted: false, conflicted: false },
    upstreamAhead: 0, mainState: "integrated", lockReason: null, mainAhead: null, defaultBranch: "main", mainBase: "main", locked: false, prunable: false, operation: null,
    sizeKiB, sizeMeasuredAt: "2026-09-29T00:00:00Z", verdict: "Safe", reason: "Integrated into main",
    ...overrides,
  };
}

function fakeService(rows: WorktreeRow[]) {
  let snapshot: DashboardSnapshot = {
    generation: 1, rows,
    progress: { phase: "complete", reposTotal: 1, reposDone: 1, startedAt: "2026-09-29T00:00:00Z", completedAt: "2026-09-29T00:00:01Z" },
    errors: {}, fatalError: null,
  };
  let refreshes = 0;
  const listeners = new Set<(snapshot: DashboardSnapshot) => void>();
  const service: DashboardService = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener); }; },
    refresh: async () => { refreshes++; },
    refreshSize: async () => {},
    close: async () => {},
  };
  return {
    service,
    getRefreshes: () => refreshes,
    setRows: (nextRows: WorktreeRow[], phase: DashboardSnapshot["progress"]["phase"] = "complete") => {
      snapshot = { ...snapshot, rows: nextRows, progress: { ...snapshot.progress, phase } };
      for (const listener of listeners) listener(snapshot);
    },
  };
}

function entry(item: WorktreeRow, overrides: Partial<RemovalEntry> = {}): RemovalEntry {
  return {
    row: item, blockedReason: null, localFiles: [], ignoredFiles: [], disposableIgnored: 0,
    requiresDiscard: false, branchWillBeRetained: false, ...overrides,
  };
}

function fakeActions(entries: (rows: WorktreeRow[]) => RemovalEntry[], overrides: Partial<ActionService> = {}) {
  const executed: Array<Record<string, unknown>> = [];
  const actions: ActionService = {
    inspectFiles: async () => ({ localFiles: [], ignoredFiles: [], disposableIgnored: 0 }),
    prepareRemoval: async (rows) => ({ entries: entries(rows) }),
    executeRemoval: async (plan, choices) => {
      executed.push(choices);
      return {
        items: plan.entries.map((item) => ({ id: item.row.id, status: "removed" as const, branchOutcome: "deleted" })),
        freedKiB: 2048, warnings: [],
      };
    },
    preparePrune: async (repoPath) => ({ repoPath, records: [] }),
    executePrune: async () => {},
    ...overrides,
  };
  return { actions, executed };
}

function focused(frame: string): string {
  return frame.split("\n").find((line) => line.startsWith("▌")) ?? "";
}

async function start(width: number, height: number, rows: WorktreeRow[], actions?: ActionService) {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const setup = await createTestRenderer({ width, height });
  const fake = fakeService(rows);
  const running = runTerminal(fake.service, { renderer: setup.renderer, actions, home: "/repos" });
  const frame = async () => {
    // A lone Esc is only reported once the input parser rules out an escape sequence.
    await Bun.sleep(40);
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const stop = async () => {
    setup.mockInput.pressCtrlC();
    await running;
  };
  return { setup, fake, running, frame, stop };
}

test("rows sit under verdict sections with their reasons, and the first row opens a summary", async () => {
  const ui = await start(130, 30, [row("api", 2000), row("docs", 500, { verdict: "Review", mainState: "ahead", reason: "Main branch relation: ahead" })]);
  try {
    const frame = await ui.frame();
    expect(frame).toContain("2 worktrees · up to 2.4 MB");
    expect(frame).toContain("All 2");
    expect(frame).toContain("Safe 1");
    expect(frame).toContain("Review 1");
    expect(frame).toContain("✓ SAFE  1 worktree · 2.0 MB · can go");
    expect(frame).toContain("? REVIEW  1 worktree · 500 KB · needs a look");
    expect(frame.indexOf("SAFE")).toBeLessThan(frame.indexOf("REVIEW"));
    expect(frame).toContain("merged  Its content is already in main");
    expect(frame).toContain("unmerged commits  Some commits aren't in main");
    expect(focused(frame)).toContain("api");
    expect(frame).toContain("~/alpha/worktrees/api");
    expect(frame).toContain("Claude Code · last commit");
    expect(frame).toContain("? keys");
  } finally {
    await ui.stop();
  }
});

test("narrow terminals keep the focused path and the quit hint visible", async () => {
  const longPath = `/repos/alpha/worktrees/${"x".repeat(60)}END`;
  const ui = await start(42, 14, [row("api", 2000, { path: longPath })]);
  try {
    const frame = await ui.frame();
    expect(frame).toContain("api");
    expect(frame).toContain("END");
    expect(frame).toContain("q quit");
  } finally {
    await ui.stop();
  }
});

test("focus stays on the first row while a scan streams rows in, then follows the row the user picked", async () => {
  const ui = await start(130, 20, [row("small", 100)]);
  try {
    ui.fake.setRows([row("small", 100), row("big", 9000)], "scanning");
    expect(focused(await ui.frame())).toContain("big");
    ui.setup.mockInput.pressArrow("down");
    expect(focused(await ui.frame())).toContain("small");
    ui.fake.setRows([row("small", 99_000), row("big", 9000)]);
    expect(focused(await ui.frame())).toContain("small");
  } finally {
    await ui.stop();
  }
});

test("search filters as you type, matches repo names, and r rescans", async () => {
  const ui = await start(100, 16, [row("api", 2000), row("docs", 500, { repoName: "beta", repoPath: "/repos/beta", path: "/elsewhere/docs" })]);
  try {
    ui.setup.mockInput.pressKey("/");
    await ui.setup.mockInput.typeText("beta");
    let frame = await ui.frame();
    expect(frame).toContain("docs");
    expect(frame).not.toContain("api");
    expect(frame).toContain("1 of 2");
    ui.setup.mockInput.pressEnter();
    ui.setup.mockInput.pressKey("r");
    expect(ui.fake.getRefreshes()).toBeGreaterThan(1);
    ui.setup.mockInput.pressEscape();
    frame = await ui.frame();
    expect(frame).toContain("api");
  } finally {
    await ui.stop();
  }
});

test("number keys switch verdict tabs", async () => {
  const ui = await start(100, 16, [row("api", 2000), row("docs", 500, { verdict: "Review", mainState: "ahead" })]);
  try {
    ui.setup.mockInput.pressKey("3");
    const frame = await ui.frame();
    expect(frame).toContain("docs");
    expect(frame).not.toContain("SAFE");
    expect(frame).not.toContain("api");
  } finally {
    await ui.stop();
  }
});

test("q quits and destroys the renderer", async () => {
  const ui = await start(40, 12, [row("api", 2000)]);
  let destroyed = false;
  ui.setup.renderer.once("destroy", () => { destroyed = true; });
  ui.setup.mockInput.pressKey("q");
  await ui.running;
  expect(destroyed).toBe(true);
});

test("Ctrl-C quits during search", async () => {
  const ui = await start(40, 12, [row("api", 2000)]);
  ui.setup.mockInput.pressKey("/");
  ui.setup.mockInput.pressCtrlC();
  await Promise.race([ui.running, Bun.sleep(200).then(() => { throw new Error("Ctrl-C did not quit"); })]);
});

test("v groups by repo, Safe rows first in each repo, and movement follows the visible order", async () => {
  const ui = await start(130, 24, [
    row("a", 3000),
    row("b", 2000, { repoName: "beta", repoPath: "/repos/beta" }),
    row("c", 4000, { verdict: "Review", mainState: "ahead" }),
    row("d", 1000),
  ]);
  try {
    ui.setup.mockInput.pressKey("v");
    ui.setup.mockInput.pressArrow("down");
    const frame = await ui.frame();
    expect(frame).toContain("▸ alpha  3 worktrees");
    expect(frame).toContain("2 safe  1 review");
    expect(frame).toContain("▸ beta");
    expect(frame).not.toContain("✓ SAFE");
    expect(frame.indexOf(" d ")).toBeLessThan(frame.indexOf(" c "));
    expect(focused(frame)).toContain("d");
    ui.setup.mockInput.pressArrow("down");
    expect(focused(await ui.frame())).toContain("c");
  } finally {
    await ui.stop();
  }
});

test("expanded details scroll to reveal a long path and reason in a tiny terminal", async () => {
  const ui = await start(32, 12, [row("api", 2000, {
    path: `/repos/alpha/worktrees/${"x".repeat(140)}PATH_END`,
    locked: true, verdict: "Review",
    lockReason: `${"Needs careful review ".repeat(10)}REASON_END`,
  })]);
  try {
    ui.setup.mockInput.pressKey("i");
    let frames = await ui.frame();
    for (let index = 0; index < 30; index++) {
      ui.setup.mockInput.pressArrow("down");
      frames += await ui.frame();
    }
    expect(frames).toContain("PATH_END");
    expect(frames).toContain("REASON_END");
    expect(frames).toContain("measured");
    expect(frames).toContain("q quit");
  } finally {
    await ui.stop();
  }
});

test("selecting a locked worktree explains why instead of doing nothing", async () => {
  const { actions } = fakeActions((rows) => rows.map((item) => entry(item)));
  const ui = await start(130, 16, [row("api", 2000, { locked: true, verdict: "Review" })], actions);
  try {
    ui.setup.mockInput.pressKey(" ");
    expect(await ui.frame()).toContain("Can't select api: it's locked; unlock it first");
  } finally {
    await ui.stop();
  }
});

test("details pane lists uncommitted changes and summarizes ignored files quietly", async () => {
  const { actions } = fakeActions((rows) => rows.map((item) => entry(item)), {
    inspectFiles: async () => ({ localFiles: ["?? notes.md"], ignoredFiles: [".env", "data.sqlite"], disposableIgnored: 2 }),
  });
  const ui = await start(130, 30, [row("api", 2000)], actions);
  try {
    await Bun.sleep(200);
    const frame = await ui.frame();
    expect(frame).toContain("uncommitted  notes.md");
    expect(frame).toContain("ignored  .env  data.sqlite · 2 cache");
  } finally {
    await ui.stop();
  }
});

test("x then y removes in the background while the table stays on screen", async () => {
  const item = row("api", 2000);
  let finishRemoval!: () => void;
  const { actions, executed } = fakeActions((rows) => rows.map((selected) => entry(selected)), {
    executeRemoval: async (plan, choices, onProgress) => {
      executed.push(choices);
      onProgress?.(item.id, "removing");
      await new Promise<void>((resolve) => { finishRemoval = resolve; });
      onProgress?.(item.id, "removed");
      return { items: [{ id: item.id, status: "removed", branchOutcome: "deleted" }], freedKiB: 2048, warnings: [] };
    },
  });
  const ui = await start(130, 24, [item, row("docs", 500)], actions);
  try {
    ui.setup.mockInput.pressKey("x");
    let frame = await ui.frame();
    expect(frame).toContain("Remove 1 worktree · up to 2.0 MB?");
    expect(frame).toContain("Remove 1  y / enter");
    expect(frame).toContain("Cancel  esc");
    expect(frame).toContain("Nothing uncommitted");
    expect(executed).toHaveLength(0);
    ui.setup.mockInput.pressKey("y");
    frame = await ui.frame();
    expect(executed).toHaveLength(1);
    expect(frame).toContain("Removing 1 of 1: api");
    expect(frame).toContain("1 worktree · up to 500 KB");
    expect(frame).not.toContain("• api");
    expect(focused(frame)).toContain("docs");
    finishRemoval();
    frame = await ui.frame();
    expect(frame).toContain("Removed 1 worktree · freed 2.0 MB");
    expect(frame).not.toContain("Removing 1 of 1");
  } finally {
    await ui.stop();
  }
});

test("the confirm bar names uncommitted changes it will discard, and esc cancels", async () => {
  const item = row("api", 2000);
  const { actions, executed } = fakeActions((rows) => rows.map((selected) =>
    entry(selected, { localFiles: ["?? notes.md"], requiresDiscard: true })));
  const ui = await start(110, 24, [item], actions);
  try {
    ui.setup.mockInput.pressKey(" ");
    ui.setup.mockInput.pressKey("x");
    expect(await ui.frame()).toContain("Discards uncommitted changes in api");
    ui.setup.mockInput.pressEscape();
    expect(await ui.frame()).not.toContain("Discards uncommitted");
    ui.setup.mockInput.pressKey("x");
    await ui.frame();
    ui.setup.mockInput.pressKey("y");
    await ui.frame();
    expect(executed[0]).toEqual({ [item.id]: { include: true, discardChanges: true, forceDeleteBranch: false, reapProcesses: false } });
  } finally {
    await ui.stop();
  }
});

test("i shows the full details in place of the list, and i returns", async () => {
  const ui = await start(130, 30, [row("api", 2000)]);
  try {
    let frame = await ui.frame();
    expect(frame).toContain("i more");
    expect(frame).not.toContain("CREATED BY");
    ui.setup.mockInput.pressKey("i");
    frame = await ui.frame();
    expect(frame).toContain("CREATED BY");
    expect(frame).not.toContain("SAFE");
    ui.setup.mockInput.pressKey("i");
    expect(await ui.frame()).toContain("SAFE");
  } finally {
    await ui.stop();
  }
});

test("enter opens the dialog and a later enter confirms it, but a quick double press does not", async () => {
  const item = row("api", 2000);
  const { actions, executed } = fakeActions((rows) => rows.map((selected) => entry(selected)));
  const ui = await start(130, 24, [item], actions);
  try {
    expect(await ui.frame()).toContain("enter remove");
    ui.setup.mockInput.pressEnter();
    expect(await ui.frame()).toContain("Remove 1 worktree · up to 2.0 MB?");
    ui.setup.mockInput.pressEnter();
    expect(await ui.frame()).toContain("Remove 1 worktree · up to 2.0 MB?");
    expect(executed).toHaveLength(0);
    await Bun.sleep(400);
    ui.setup.mockInput.pressEnter();
    await ui.frame();
    expect(executed).toHaveLength(1);
  } finally {
    await ui.stop();
  }
});

test("? opens the key overlay and esc closes it", async () => {
  const ui = await start(110, 30, [row("api", 2000)]);
  try {
    ui.setup.mockInput.pressKey("?");
    expect(await ui.frame()).toContain("group by repo");
    ui.setup.mockInput.pressEscape();
    expect(await ui.frame()).not.toContain("group by repo");
  } finally {
    await ui.stop();
  }
});


test("a locked row shows Git's full lock reason when there is room, without CHECKS", async () => {
  const item = row("my-app", 2000, {
    verdict: "Review", mainState: "ahead", mainAhead: 3, mainBase: "origin/main", locked: true,
    lockReason: "claude session my-app (pid 24621 start Wed Sep 23 15:55:03 2026)",
  });
  const ui = await start(180, 60, [item]);
  try {
    const frame = await ui.frame();
    expect(focused(frame)).toContain(`locked  ${item.lockReason}`);
    expect(frame).not.toContain("CHECKS");
    expect(frame).not.toContain("+1");
    expect(frame).not.toContain("ended");
  } finally { await ui.stop(); }
});

test("a missing folder offers pruning and Enter opens its prune confirmation", async () => {
  const { actions, executed } = fakeActions(() => [], {
    preparePrune: async repoPath => ({ repoPath, records: ["prune missing record"] }),
  });
  const ui = await start(130, 30, [row("missing", 0, { prunable: true, verdict: "Broken", changes: null })], actions);
  try {
    const frame = await ui.frame();
    expect(frame).toContain("folder missing");
    expect(frame).toContain("enter prune");
    ui.setup.mockInput.pressEnter();
    expect(await ui.frame()).toContain("Prune 1 missing worktree record in alpha?");
    expect(executed).toHaveLength(0);
  } finally { await ui.stop(); }
});

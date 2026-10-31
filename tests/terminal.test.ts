import { expect, test } from "bun:test";
import { runTerminal } from "../src/ui/terminal";
import { createTheme } from "../src/ui/theme";
import type { ActionService, RemovalEntry } from "../src/core/removal/types";
import {
  ORPHANS,
  type DashboardService,
  type DashboardSnapshot,
  type WorktreeRow,
} from "../src/core/types";

function row(id: string, sizeKiB: number, overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id,
    repoPath: "/repos/alpha",
    repoName: "alpha",
    path: `/repos/alpha/worktrees/${id}`,
    branch: id,
    headSha: "abcdef1234",
    committedAt: "2026-09-28T00:00:00Z",
    createdAt: "2026-09-27T00:00:00Z",
    kind: "worktree",
    marker: null,
    markerSetAt: null,
    tool: "Claude",
    changes: {
      staged: false,
      modified: false,
      untracked: false,
      renamed: false,
      deleted: false,
      conflicted: false,
    },
    upstreamAhead: 0,
    mainState: "integrated",
    lockReason: null,
    mainAhead: null,
    mainBehind: null,
    mainDiff: null,
    subject: null,
    description: null,
    vars: null,
    defaultBranch: "main",
    mainBase: "main",
    locked: false,
    prunable: false,
    operation: null,
    sizeKiB,
    sizeMeasuredAt: "2026-09-29T00:00:00Z",
    verdict: "Safe",
    reason: "Integrated into main",
    ...overrides,
  };
}

function orphan(id: string, sizeKiB: number, overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return row(id, sizeKiB, {
    id: `${ORPHANS}\0${id}`,
    kind: "orphan",
    repoPath: ORPHANS,
    repoName: "Orphaned folders",
    path: `/repos/.codex/worktrees/${id}/app`,
    tool: "Codex",
    branch: null,
    headSha: null,
    committedAt: null,
    createdAt: null,
    changes: null,
    upstreamAhead: null,
    mainState: null,
    defaultBranch: null,
    mainBase: null,
    verdict: "Orphaned",
    reason: `Its repository at /repos/old/${id} no longer exists.`,
    orphan: {
      kind: "gitdirMissing",
      gitdir: `/repos/old/${id}/.git/worktrees/app`,
      repo: `/repos/old/${id}`,
      repoExists: false,
    },
    ...overrides,
  });
}

function fakeService(
  rows: WorktreeRow[],
  phase: DashboardSnapshot["progress"]["phase"] = "complete",
) {
  let snapshot: DashboardSnapshot = {
    generation: 1,
    repos: [],
    rows,
    progress: {
      phase,
      reposTotal: 1,
      reposDone: 1,
      startedAt: "2026-09-29T00:00:00Z",
      completedAt: "2026-09-29T00:00:01Z",
    },
    errors: {},
    fatalError: null,
    sizing: [],
    processes: {},
  };
  let refreshes = 0;
  const listeners = new Set<(snapshot: DashboardSnapshot) => void>();
  const service: DashboardService = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async () => {
      refreshes++;
    },
    refreshSize: async () => {},
    close: async () => {},
  };
  return {
    service,
    getRefreshes: () => refreshes,
    update: (next: Partial<DashboardSnapshot>) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener(snapshot);
    },
    setRows: (
      nextRows: WorktreeRow[],
      phase: DashboardSnapshot["progress"]["phase"] = "complete",
    ) => {
      snapshot = { ...snapshot, rows: nextRows, progress: { ...snapshot.progress, phase } };
      for (const listener of listeners) listener(snapshot);
    },
  };
}

function entry(item: WorktreeRow, overrides: Partial<RemovalEntry> = {}): RemovalEntry {
  return {
    row: item,
    blockedReason: null,
    localFiles: [],
    ignoredFiles: [],
    disposableIgnored: 0,
    requiresDiscard: false,
    branchWillBeRetained: false,
    ...overrides,
  };
}

function fakeActions(
  entries: (rows: WorktreeRow[]) => RemovalEntry[],
  overrides: Partial<ActionService> = {},
) {
  const executed: Array<Record<string, unknown>> = [];
  const actions: ActionService = {
    inspectFiles: async () => ({ localFiles: [], ignoredFiles: [], disposableIgnored: 0 }),
    prepareRemoval: async (rows) => ({ entries: entries(rows) }),
    executeRemoval: async (plan, choices) => {
      executed.push(choices);
      return {
        items: plan.entries.map((item) => ({
          id: item.row.id,
          status: "removed" as const,
          branchOutcome: "deleted",
        })),
        freedKiB: 2048,
        warnings: [],
      };
    },
    preparePrune: async (repoPath) => ({ repoPath, records: [] }),
    executePrune: async () => {},
    ...overrides,
  };
  return { actions, executed };
}

function withoutSidebar(frame: string): string {
  return frame
    .split("\n")
    .map((line) => (line.includes(" │ ") ? line.slice(line.indexOf(" │ ") + 3) : line))
    .join("\n");
}

function focused(frame: string): string {
  const lines = frame.split("\n");
  const row = lines.find((line) => line.includes("│ ▌"));
  return row
    ? row.slice(row.indexOf("│ ▌") + 2)
    : (lines.find((line) => line.startsWith("▌")) ?? "");
}

async function start(
  width: number,
  height: number,
  rows: WorktreeRow[],
  actions?: ActionService,
  phase?: DashboardSnapshot["progress"]["phase"],
) {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const setup = await createTestRenderer({ width, height });
  const fake = fakeService(rows, phase);
  const running = runTerminal(fake.service, { renderer: setup.renderer, actions, home: "/repos" });
  const frame = async () => {
    await Bun.sleep(40);
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  // OpenTUI reports a lone Esc only after a timer rules out an escape sequence, so wait for the key itself.
  const escape = () =>
    new Promise<void>((resolve) => {
      const seen = (key: { name: string }) => {
        if (key.name !== "escape") return;
        setup.renderer.keyInput.off("keypress", seen);
        resolve();
      };
      setup.renderer.keyInput.on("keypress", seen);
      setup.mockInput.pressEscape();
    });
  const stop = async () => {
    setup.mockInput.pressCtrlC();
    await running;
  };
  return { setup, fake, running, frame, escape, stop };
}

test("rows sit under verdict sections with their reasons, and the focused row's details sit under them", async () => {
  const ui = await start(170, 30, [
    row("api", 2000),
    row("docs", 500, {
      verdict: "Review",
      mainState: "ahead",
      reason: "Main branch relation: ahead",
    }),
  ]);
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
    expect(frame).toContain("api  ● Safe · merged");
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
  const ui = await start(100, 16, [
    row("api", 2000),
    row("docs", 500, { repoName: "beta", repoPath: "/repos/beta", path: "/elsewhere/docs" }),
  ]);
  try {
    ui.setup.mockInput.pressKey("/");
    await ui.setup.mockInput.typeText("beta");
    let frame = withoutSidebar(await ui.frame());
    expect(frame).toContain("docs");
    expect(frame).not.toContain("api");
    expect(frame).toContain("1 of 2");
    ui.setup.mockInput.pressEnter();
    ui.setup.mockInput.pressKey("r");
    expect(ui.fake.getRefreshes()).toBeGreaterThan(1);
    await ui.escape();
    frame = await ui.frame();
    expect(frame).toContain("api");
  } finally {
    await ui.stop();
  }
});

test("number keys switch verdict tabs", async () => {
  const ui = await start(100, 16, [
    row("api", 2000),
    row("docs", 500, { verdict: "Review", mainState: "ahead" }),
  ]);
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
  ui.setup.renderer.once("destroy", () => {
    destroyed = true;
  });
  ui.setup.mockInput.pressKey("q");
  await ui.running;
  expect(destroyed).toBe(true);
});

test("Ctrl-C quits during search", async () => {
  const ui = await start(40, 12, [row("api", 2000)]);
  ui.setup.mockInput.pressKey("/");
  ui.setup.mockInput.pressCtrlC();
  await Promise.race([
    ui.running,
    Bun.sleep(200).then(() => {
      throw new Error("Ctrl-C did not quit");
    }),
  ]);
});

test("v groups by repo, Safe rows first in each repo, and movement follows the visible order", async () => {
  const ui = await start(130, 24, [
    row("a", 3000),
    row("b", 2000, { repoName: "beta", repoPath: "/repos/beta" }),
    row("c", 4000, { verdict: "Review", mainState: "ahead" }),
    row("d", 1000),
  ]);
  try {
    ui.setup.mockInput.pressKey("g");
    ui.setup.mockInput.pressEnter();
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
  const ui = await start(32, 12, [
    row("api", 2000, {
      path: `/repos/alpha/worktrees/${"x".repeat(140)}PATH_END`,
      locked: true,
      verdict: "Review",
      lockReason: `${"Needs careful review ".repeat(10)}REASON_END`,
    }),
  ]);
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
    inspectFiles: async () => ({
      localFiles: ["?? notes.md"],
      ignoredFiles: [".env", "data.sqlite"],
      disposableIgnored: 2,
    }),
  });
  const ui = await start(130, 30, [row("api", 2000)], actions);
  try {
    await Bun.sleep(200);
    let frame = await ui.frame();
    expect(frame).toContain("uncommitted  notes.md");
    expect(frame).toContain("ignored  .env  data.sqlite · 2 cache");
    ui.setup.mockInput.pressKey("i");
    frame = await ui.frame();
    expect(frame).toContain("UNCOMMITTED   notes.md");
    expect(frame).toContain("IGNORED       .env  data.sqlite · 2 cache");
  } finally {
    await ui.stop();
  }
});

for (const activity of ["scanning", "sizing", "toast"] as const) {
  test(`focused file details load during ${activity} ticks (audit #4)`, async () => {
    const inspected: string[] = [];
    const item = row(
      "api",
      2000,
      activity === "toast"
        ? { locked: true }
        : activity === "sizing"
          ? { sizeKiB: null, sizeMeasuredAt: null }
          : {},
    );
    const { actions } = fakeActions((rows) => rows.map((item) => entry(item)), {
      inspectFiles: async (selected) => {
        inspected.push(selected.id);
        return { localFiles: ["?? notes.md"], ignoredFiles: [], disposableIgnored: 0 };
      },
    });
    const ui = await start(
      130,
      30,
      [item],
      actions,
      activity === "scanning" ? "scanning" : "complete",
    );
    try {
      if (activity === "scanning") ui.setup.mockInput.pressEnter();
      if (activity === "sizing") ui.fake.update({ sizing: [item.path!] });
      if (activity === "toast") ui.setup.mockInput.pressKey(" ");
      await Bun.sleep(400);
      const frame = await ui.frame();
      expect(inspected).toEqual([item.id]);
      expect(frame).toContain("uncommitted  notes.md");
      if (activity === "scanning") expect(frame).toContain("scanning");
      if (activity === "sizing") expect(frame).toContain("1 sizing");
      if (activity === "toast") expect(frame).toContain("Can't select api");
    } finally {
      await ui.stop();
    }
  });
}

test("focus changes restart the file debounce, including a quick return to the same row (audit #4)", async () => {
  const inspected: string[] = [];
  const { actions } = fakeActions((rows) => rows.map((item) => entry(item)), {
    inspectFiles: async (selected) => {
      inspected.push(selected.id);
      return { localFiles: [], ignoredFiles: [], disposableIgnored: 0 };
    },
  });
  const ui = await start(130, 30, [row("api", 2000), row("docs", 500)], actions);
  try {
    await Bun.sleep(90);
    ui.setup.mockInput.pressArrow("down");
    await Bun.sleep(90);
    expect(inspected).toEqual([]);
    ui.setup.mockInput.pressArrow("up");
    await Bun.sleep(90);
    expect(inspected).toEqual([]);
    await Bun.sleep(100);
    expect(inspected).toEqual(["api"]);
  } finally {
    await ui.stop();
  }
});

test("same-focus snapshot updates keep the pending file deadline (audit #4)", async () => {
  let inspected = 0;
  const { actions } = fakeActions((rows) => rows.map((item) => entry(item)), {
    inspectFiles: async () => {
      inspected++;
      return { localFiles: [], ignoredFiles: [], disposableIgnored: 0 };
    },
  });
  const ui = await start(130, 30, [row("api", 2000)], actions);
  const updates = setInterval(() => ui.fake.setRows([row("api", 2001)]), 50);
  try {
    await Bun.sleep(400);
    expect(inspected).toBe(1);
    expect(await ui.frame()).toContain("nothing uncommitted");
  } finally {
    clearInterval(updates);
    await ui.stop();
  }
});

test("a new generation restarts the file debounce and rejects the old report (audit #4)", async () => {
  const finishes: Array<(report: Awaited<ReturnType<ActionService["inspectFiles"]>>) => void> = [];
  const { actions } = fakeActions((rows) => rows.map((item) => entry(item)), {
    inspectFiles: () => new Promise((resolve) => finishes.push(resolve)),
  });
  const ui = await start(130, 30, [row("api", 2000)], actions);
  const report = (name: string) => ({
    localFiles: [`?? ${name}`],
    ignoredFiles: [],
    disposableIgnored: 0,
  });
  try {
    await Bun.sleep(200);
    expect(finishes).toHaveLength(1);
    ui.fake.update({ generation: 2 });
    await Bun.sleep(90);
    ui.fake.update({ generation: 3 });
    await Bun.sleep(90);
    expect(finishes).toHaveLength(1);
    await Bun.sleep(100);
    expect(finishes).toHaveLength(2);
    finishes[1]!(report("current.md"));
    expect(await ui.frame()).toContain("uncommitted  current.md");
    finishes[0]!(report("stale.md"));
    const frame = await ui.frame();
    expect(frame).toContain("uncommitted  current.md");
    expect(frame).not.toContain("stale.md");
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
      await new Promise<void>((resolve) => {
        finishRemoval = resolve;
      });
      onProgress?.(item.id, "removed");
      return {
        items: [{ id: item.id, status: "removed", branchOutcome: "deleted" }],
        freedKiB: 2048,
        warnings: [],
      };
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
    await Bun.sleep(400);
    expect(await ui.frame()).toContain("nothing uncommitted");
    finishRemoval();
    frame = await ui.frame();
    expect(frame).toContain("Removed 1 worktree · freed 2.0 MB");
    expect(frame).not.toContain("Removing 1 of 1");
  } finally {
    await ui.stop();
  }
});

test("the confirm bar warns about an agent that was recently active", async () => {
  const item = row("api", 2000, {
    marker: "🤖",
    markerSetAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  });
  const { actions } = fakeActions((rows) => rows.map((selected) => entry(selected)));
  const ui = await start(110, 24, [item], actions);
  try {
    ui.setup.mockInput.pressKey("x");
    expect(await ui.frame()).toContain("api: An agent was working here 20m ago.");
  } finally {
    await ui.stop();
  }
});

test("the confirm bar names uncommitted changes it will discard, and esc cancels", async () => {
  const item = row("api", 2000);
  const { actions, executed } = fakeActions((rows) =>
    rows.map((selected) => entry(selected, { localFiles: ["?? notes.md"], requiresDiscard: true })),
  );
  const ui = await start(110, 24, [item], actions);
  try {
    ui.setup.mockInput.pressKey(" ");
    ui.setup.mockInput.pressKey("x");
    expect(await ui.frame()).toContain("Discards uncommitted changes in api");
    await ui.escape();
    expect(await ui.frame()).not.toContain("Discards uncommitted");
    ui.setup.mockInput.pressKey("x");
    await ui.frame();
    ui.setup.mockInput.pressKey("y");
    await ui.frame();
    expect(executed[0]).toEqual({
      [item.id]: {
        include: true,
        discardChanges: true,
        forceDeleteBranch: false,
        reapProcesses: true,
      },
    });
  } finally {
    await ui.stop();
  }
});

test("the confirm dialog shows live sizes and says which are still sizing", async () => {
  const sized = row("api", 2000);
  const unsized = row("docs", 0, { sizeKiB: null, sizeMeasuredAt: null });
  const { actions } = fakeActions((rows) =>
    rows.map((selected) => entry({ ...selected, sizeKiB: null })),
  );
  const ui = await start(130, 24, [sized, unsized], actions);
  ui.fake.update({ sizing: [unsized.path!] });
  try {
    ui.setup.mockInput.pressKey("x");
    expect(await ui.frame()).toContain("Remove 1 worktree · up to 2.0 MB?");
    await ui.escape();
    ui.setup.mockInput.pressKey("j");
    ui.setup.mockInput.pressKey("x");
    const frame = await ui.frame();
    expect(frame).toContain("Remove 1 worktree · 1 sizing?");
    expect(frame).not.toContain("0 KB");
  } finally {
    await ui.stop();
  }
});

test("removal stops processes inside unless e leaves them running", async () => {
  const item = row("api", 2000);
  const { actions, executed } = fakeActions((rows) => rows.map((selected) => entry(selected)));
  const ui = await start(130, 24, [item], actions);
  try {
    ui.setup.mockInput.pressKey("x");
    expect(await ui.frame()).toContain("Stops processes running inside  e leave them");
    ui.setup.mockInput.pressKey("e");
    expect(await ui.frame()).toContain("Processes inside keep running  e stop them");
    await Bun.sleep(400);
    ui.setup.mockInput.pressKey("y");
    await ui.frame();
    expect(executed[0]).toMatchObject({ [item.id]: { reapProcesses: false } });
  } finally {
    await ui.stop();
  }
});

test("i shows the full details in place of the list, and i returns", async () => {
  const ui = await start(90, 30, [row("api", 2000)]);
  try {
    let frame = await ui.frame();
    expect(frame).toContain("SAFE");
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
    await ui.escape();
    expect(await ui.frame()).not.toContain("group by repo");
  } finally {
    await ui.stop();
  }
});

test("at 80x24 the key overlay fits every label whole, in two columns (#59)", async () => {
  const ui = await start(80, 24, [row("api", 2000)]);
  try {
    ui.setup.mockInput.pressKey("?");
    const frame = await ui.frame();
    for (const label of [
      "all Safe in view / project",
      "remove selected or focused",
      "dialog: unmerged branches",
      "dialog: leave processes",
      "Colors:",
    ])
      expect(frame).toContain(label);
    expect(frame).toMatch(/group by repo or verdict +y enter +confirm in the dialog/);
  } finally {
    await ui.stop();
  }
});

test("below 80 columns the key overlay keeps two columns, so every group still shows (#59)", async () => {
  const ui = await start(72, 24, [row("api", 2000)]);
  try {
    ui.setup.mockInput.pressKey("?");
    const frame = await ui.frame();
    for (const label of ["MOVE", "PROJECTS", "FIND", "CLEAN UP", "OTHER", "quit", "Colors:"])
      expect(frame).toContain(label);
  } finally {
    await ui.stop();
  }
});

test("a light terminal's reply to the background query turns the focus bar light (#59)", async () => {
  const ui = await start(110, 20, [row("api", 2000), row("docs", 500)]);
  const focusBg = () => {
    const line = ui.setup
      .captureSpans()
      .lines.find(({ spans }) => /^▌ +api /.test(spans.map(({ text }) => text).join("")));
    return line?.spans.find(({ text }) => text.includes("api"))?.bg.toInts();
  };
  try {
    await ui.frame();
    expect(focusBg()).toEqual(createTheme("dark").focusBg.toInts());
    ui.setup.renderer.stdin.emit(
      "data",
      Buffer.from("\x1b]10;rgb:0000/0000/0000\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\"),
    );
    await ui.frame();
    expect(focusBg()).toEqual(createTheme("light").focusBg.toInts());
  } finally {
    await ui.stop();
  }
});

test("a locked row shows Git's full lock reason when there is room, without CHECKS", async () => {
  const item = row("my-app", 2000, {
    verdict: "Review",
    mainState: "ahead",
    mainAhead: 3,
    mainBase: "origin/main",
    locked: true,
    lockReason: "claude session my-app (pid 24621 start Wed Sep 23 15:55:03 2026)",
  });
  const ui = await start(180, 60, [item]);
  try {
    const frame = await ui.frame();
    expect(focused(frame)).toContain(`locked  ${item.lockReason}`);
    expect(frame).not.toContain("CHECKS");
    expect(frame).not.toContain("+1");
    expect(frame).not.toContain("ended");
  } finally {
    await ui.stop();
  }
});

test("a missing folder offers pruning and Enter opens its prune confirmation", async () => {
  const { actions, executed } = fakeActions(() => [], {
    preparePrune: async (repoPath) => ({ repoPath, records: ["prune missing record"] }),
  });
  const ui = await start(
    130,
    30,
    [row("missing", 0, { prunable: true, verdict: "Broken", changes: null })],
    actions,
  );
  try {
    const frame = await ui.frame();
    expect(frame).toContain("folder missing");
    expect(frame).toContain("enter prune");
    ui.setup.mockInput.pressEnter();
    expect(await ui.frame()).toContain("Prune 1 missing worktree record in alpha?");
    expect(executed).toHaveLength(0);
  } finally {
    await ui.stop();
  }
});

test("below 100 columns, several projects open on a projects table, and enter shows one project's worktrees", async () => {
  const ui = await start(90, 20, [
    row("api", 2000),
    row("docs", 500, { verdict: "Review", mainState: "ahead" }),
    row("web", 3000, {
      repoName: "beta",
      repoPath: "/repos/beta",
      path: "/repos/beta/worktrees/web",
    }),
  ]);
  try {
    let frame = await ui.frame();
    expect(frame).toContain("2 projects · 3 worktrees");
    expect(frame).toContain("PROJECT");
    expect(frame).toContain("SAFE SIZE");
    expect(frame).toMatch(/All projects\s+3\s+2\s+1\s+·\s+·\s+·\s+4\.9 MB\s+5\.4 MB/);
    expect(focused(frame)).toMatch(/alpha\s+2\s+1\s+1\s+·\s+·\s+·\s+2\.0 MB\s+2\.4 MB/);
    expect(frame).toContain("enter open");
    ui.setup.mockInput.pressArrow("down");
    ui.setup.mockInput.pressEnter();
    frame = await ui.frame();
    expect(frame).toContain("wt-dash › beta");
    expect(focused(frame)).toContain("web");
    expect(frame).not.toContain("api");
    expect(frame).toContain("← projects");
  } finally {
    await ui.stop();
  }
});

test("at 100 columns and wider, projects sit in a sidebar and the list follows the focused one", async () => {
  const ui = await start(130, 24, [
    row("api", 2000),
    row("docs", 500, { verdict: "Review", mainState: "ahead" }),
    row("web", 3000, {
      repoName: "beta",
      repoPath: "/repos/beta",
      path: "/repos/beta/worktrees/web",
    }),
  ]);
  try {
    let frame = await ui.frame();
    expect(frame).toContain("PROJECTS");
    expect(frame).toMatch(/All projects 3\s+4\.9 MB │/);
    expect(focused(frame)).toMatch(/^▌ alpha 2\s+2\.0 MB │/);
    expect(frame).toContain("wt-dash › alpha");
    expect(frame).toContain("api");
    expect(frame).not.toContain("web");
    expect(frame).toContain("→ worktrees");
    ui.setup.mockInput.pressArrow("down");
    frame = await ui.frame();
    expect(frame).toContain("wt-dash › beta");
    expect(frame).toContain("web");
    expect(frame).not.toContain("api");
    ui.setup.mockInput.pressArrow("right");
    frame = await ui.frame();
    expect(focused(frame)).toContain("web");
    expect(frame).toContain("← projects");
    ui.setup.mockInput.pressArrow("left");
    expect(focused(await ui.frame())).toMatch(/^▌ beta 1/);
    ui.setup.mockInput.pressKey("g");
    ui.setup.mockInput.pressKey("\t");
    frame = await ui.frame();
    expect(frame).toContain("wt-dash › all projects");
    expect(frame).toContain("api");
    expect(frame).toContain("web");
  } finally {
    await ui.stop();
  }
});

test("a narrow header drops the project and worktree counts before the total size", async () => {
  const ui = await start(60, 14, [
    row("api", 2000),
    row("web", 3000, { repoName: "beta", repoPath: "/repos/beta", path: "/repos/beta/web" }),
  ]);
  try {
    const header = (await ui.frame()).split("\n")[0]!;
    expect(header).toContain("up to 4.9 MB");
    expect(header).toContain("r rescan");
    expect(header).not.toContain("projects");
  } finally {
    await ui.stop();
  }
});

for (const [width, layout] of [
  [90, "table"],
  [130, "sidebar"],
] as const) {
  test(`the projects ${layout} shows projects once their worktrees are counted, before they are listed`, async () => {
    const ui = await start(width, 20, [], undefined, "scanning");
    const progress = (reposTotal: number, reposDone: number) => ({
      ...ui.fake.service.getSnapshot().progress,
      phase: "scanning" as const,
      reposTotal,
      reposDone,
    });
    try {
      ui.fake.update({ progress: progress(0, 0) });
      let frame = await ui.frame();
      expect(frame).toContain("Finding repositories…");
      expect(frame).not.toContain("enter open");
      expect(frame).not.toContain("→ worktrees");
      ui.fake.update({
        repos: [
          { path: "/repos/alpha", linked: 2 },
          { path: "/repos/beta", linked: 1 },
        ],
        progress: progress(2, 0),
      });
      frame = await ui.frame();
      expect(focused(frame)).toContain("alpha");
      expect(frame).toContain("beta");
      if (layout === "sidebar") expect(withoutSidebar(frame)).toContain("Listing worktrees…");
      else expect(focused(frame)).toMatch(/alpha\s+2\s+…/);
      ui.fake.update({
        rows: [row("api", 2000), row("docs", 500, { verdict: "Review", mainState: "ahead" })],
        progress: progress(2, 1),
      });
      frame = await ui.frame();
      if (layout === "sidebar") expect(withoutSidebar(frame)).toContain("api");
      else expect(focused(frame)).toMatch(/alpha\s+2\s+1\s+1/);
      expect(frame).toContain("beta");
    } finally {
      await ui.stop();
    }
  });
}

function lineOf(frame: string, text: string): number {
  return frame.split("\n").findIndex((line) => line.includes(text));
}

function rowOf(frame: string, name: string): number {
  return frame.split("\n").findIndex((line) => line.slice(0, 12).includes(` ${name} `));
}

for (const width of [90, 150]) {
  test(`moving focus leaves every row where it was at ${width} columns`, async () => {
    const ui = await start(width, 24, [
      row("api", 3000, { path: `/repos/alpha/worktrees/${"long/".repeat(30)}api` }),
      row("docs", 2000),
      row("web", 1000),
    ]);
    try {
      const before = await ui.frame();
      ui.setup.mockInput.pressArrow("down");
      const after = await ui.frame();
      expect(focused(after)).toContain("docs");
      for (const name of ["api", "docs", "web"]) {
        expect(rowOf(before, name)).toBeGreaterThan(0);
        expect(rowOf(after, name)).toBe(rowOf(before, name));
      }
      expect(lineOf(after, "? keys")).toBe(lineOf(before, "? keys"));
    } finally {
      await ui.stop();
    }
  });
}

test("the strip under a narrow list keeps its height while files load", async () => {
  let finish!: () => void;
  const { actions } = fakeActions((rows) => rows.map((item) => entry(item)), {
    inspectFiles: () =>
      new Promise((resolve) => {
        finish = () => resolve({ localFiles: [], ignoredFiles: [], disposableIgnored: 0 });
      }),
  });
  const ui = await start(90, 24, [row("api", 2000), row("docs", 500)], actions);
  try {
    await Bun.sleep(200);
    const loading = await ui.frame();
    expect(loading).toContain("checking files…");
    finish();
    const loaded = await ui.frame();
    expect(loaded).toContain("nothing uncommitted");
    expect(lineOf(loaded, "nothing uncommitted")).toBe(lineOf(loading, "checking files…"));
    expect(lineOf(loaded, "? keys")).toBe(lineOf(loading, "? keys"));
  } finally {
    await ui.stop();
  }
});

test("messages use the status line and leave the key hints in place", async () => {
  const ui = await start(
    110,
    20,
    [row("api", 2000, { locked: true, verdict: "Review" })],
    fakeActions(() => []).actions,
  );
  try {
    const before = await ui.frame();
    ui.setup.mockInput.pressKey(" ");
    const after = await ui.frame();
    expect(after).toContain("Can't select api");
    expect(lineOf(after, "Can't select api")).toBe(lineOf(after, "? keys") - 1);
    expect(after).toContain("/ search");
    expect(rowOf(after, "api")).toBe(rowOf(before, "api"));
  } finally {
    await ui.stop();
  }
});

test("the sidebar describes the focused project under the projects", async () => {
  const ui = await start(140, 20, [
    row("api", 2000, { tool: "Codex" }),
    row("docs", 500, {
      verdict: "Review",
      mainState: "ahead",
      changes: {
        staged: false,
        modified: true,
        untracked: false,
        renamed: false,
        deleted: false,
        conflicted: false,
      },
    }),
    row("web", 3000, { repoName: "beta", repoPath: "/repos/beta", path: "/repos/beta/web" }),
  ]);
  try {
    const frame = await ui.frame();
    const card = frame.split("\n").map((line) => line.slice(0, line.indexOf(" │ ")).trimEnd());
    expect(card).toContain("  alpha");
    expect(card).toContain("  ~/alpha");
    expect(card).toContain("  2.0 MB safe of 2.4 MB");
    expect(card).toContain("  1 worktree uncommitted");
    expect(card).toContain("  Claude Code 1 · Codex 1");
    expect(card).toContain("  largest 2.0 MB · api");
    expect(withoutSidebar(frame)).not.toContain("SAFE TO FREE");
  } finally {
    await ui.stop();
  }
});

test("a branch without a worktree reads as a branch, with its stale agent mark in the details", async () => {
  let inspected = 0;
  const { actions } = fakeActions((rows) => rows.map((item) => entry(item)), {
    inspectFiles: async () => {
      inspected++;
      return { localFiles: [], ignoredFiles: [], disposableIgnored: 0 };
    },
  });
  const ui = await start(
    130,
    24,
    [
      row("old-feature", 0, {
        kind: "branch",
        path: null,
        changes: null,
        sizeKiB: null,
        marker: "🤖",
        markerSetAt: new Date(Date.now() - 28 * 86_400_000).toISOString(),
      }),
    ],
    actions,
  );
  try {
    await Bun.sleep(300);
    const frame = await ui.frame();
    expect(frame).toMatch(/old-feature .* branch\n/);
    expect(frame).toContain("1 branch · 0 KB");
    expect(frame).toContain("Branch without a worktree · created");
    expect(frame).toContain("Agent mark from 28d ago, likely stale.");
    expect(frame).not.toContain("checking files");
    expect(inspected).toBe(0);
  } finally {
    await ui.stop();
  }
});

test("orphans sit last in the sidebar and their own section, read by folder name, and never get a file check", async () => {
  let inspected = 0;
  const { actions } = fakeActions((rows) => rows.map((item) => entry(item)), {
    inspectFiles: async () => {
      inspected++;
      return { localFiles: [], ignoredFiles: [], disposableIgnored: 0 };
    },
  });
  const ui = await start(
    140,
    30,
    [
      row("api", 2000),
      row("web", 3000, { repoName: "beta", repoPath: "/repos/beta", path: "/repos/beta/web" }),
      orphan("abcd", 5000),
      orphan("ef01", 1000, {
        orphan: { kind: "emptyShell" },
        path: "/repos/.codex/worktrees/ef01",
      }),
    ],
    actions,
  );
  try {
    let frame = await ui.frame();
    const sidebar = frame.split("\n").map((line) => line.slice(0, line.indexOf(" │ ")).trimEnd());
    expect(
      sidebar.filter((line) => /^. (All projects|alpha|beta|Orphaned folders) \d/.test(line)),
    ).toEqual([
      expect.stringMatching(/^  All projects 4\s+4\.9 MB$/),
      expect.stringMatching(/^▌ alpha 1\s+2\.0 MB$/),
      expect.stringMatching(/^  beta 1\s+2\.9 MB$/),
      expect.stringMatching(/^  Orphaned folders 2$/),
    ]);
    ui.setup.mockInput.pressKey("g");
    frame = await ui.frame();
    expect(frame.split("\n")[0]).toContain("2 projects · 2 worktrees and 2 orphaned folders");
    expect(withoutSidebar(frame)).toContain(
      " All 4  Safe 2 · 4.9 MB  Review 0  Busy 0  Broken 0  Orphaned 2 ",
    );
    ui.setup.mockInput.pressKey("G");
    frame = await ui.frame();
    const card = frame.split("\n").map((line) => line.slice(0, line.indexOf(" │ ")).trimEnd());
    expect(card).toContain("  2 folders no repo knows");
    expect(card).toContain("  up to 5.9 MB");
    expect(card).toContain("  Codex 2");
    expect(card).toContain("  largest 4.9 MB · abcd/app");
    expect(card).not.toContain("  nothing uncommitted");
    expect(frame).toContain("wt-dash › Orphaned folders");
    expect(frame).toMatch(/○ ORPHANED {2}2 orphaned folders · 5\.9 MB · no repository knows it/);
    expect(frame).toMatch(
      /□ abcd\/app +repository gone {2}Its repository at ~\/old\/abcd no longer exi… +\? +4\.9 MB/,
    );
    expect(frame).toMatch(/ef01 +no worktree inside {2}Codex left this folder behind/);
    ui.setup.mockInput.pressArrow("right");
    await Bun.sleep(300);
    frame = await ui.frame();
    expect(focused(frame)).toContain("app");
    const strip = withoutSidebar(frame);
    expect(strip).toContain("abcd/app  ● Orphaned · repository gone");
    expect(strip).toContain("~/.codex/worktrees/abcd/app");
    expect(strip).toContain("Its repository at ~/old/abcd no longer exists.");
    expect(strip).toContain("Codex · 4.9 MB · measured");
    expect(strip).not.toContain("last commit");
    expect(strip).not.toContain("checking files");
    expect(strip).toContain("space select");
    expect(inspected).toBe(0);
    ui.setup.mockInput.pressKey("i");
    frame = withoutSidebar(await ui.frame());
    expect(frame).toContain("Its repository at ~/old/abcd no longer exists.");
    expect(frame).toMatch(/CREATED BY +Codex/);
    expect(frame).toMatch(/SIZE +4\.9 MB · measured/);
    expect(frame).not.toContain("Orphaned folders / app");
    expect(frame).not.toContain("LAST COMMIT");
    expect(frame).not.toContain("UPSTREAM");
    expect(frame).not.toContain("CHANGES");
    expect(frame).not.toContain("FILES");
  } finally {
    await ui.stop();
  }
});

test("removing an orphan says wt-dash deletes it itself, and offers e only with a worktree in the batch", async () => {
  const folder = orphan("abcd", 5000);
  const { actions, executed } = fakeActions((rows) => rows.map((item) => entry(item)));
  const ui = await start(
    130,
    24,
    [
      row("api", 2000),
      row("web", 3000, { repoName: "beta", repoPath: "/repos/beta", path: "/repos/beta/web" }),
      folder,
    ],
    actions,
  );
  try {
    ui.setup.mockInput.pressKey("G");
    ui.setup.mockInput.pressArrow("right");
    await ui.frame();
    ui.setup.mockInput.pressKey("x");
    let frame = await ui.frame();
    expect(frame).toContain("Remove 1 orphaned folder · up to 4.9 MB?");
    expect(frame).toContain(
      "No repository tracks abcd/app, so wt-dash deletes it itself, unchecked,",
    );
    expect(frame).not.toContain("Stops processes running inside");
    expect(frame).not.toContain("Nothing uncommitted");
    await ui.escape();
    ui.setup.mockInput.pressKey(" ");
    ui.setup.mockInput.pressKey("g");
    ui.setup.mockInput.pressKey("\t");
    ui.setup.mockInput.pressKey("g");
    ui.setup.mockInput.pressKey("\t");
    await ui.frame();
    ui.setup.mockInput.pressKey("g");
    ui.setup.mockInput.pressKey(" ");
    ui.setup.mockInput.pressKey("x");
    frame = await ui.frame();
    expect(frame).toMatch(/Remove 1 worktree and 1 orphaned folder · up to \d/);
    expect(frame).toContain(
      "No repository tracks abcd/app, so wt-dash deletes it itself, unchecked,",
    );
    expect(frame).toContain("Stops processes running inside");
    expect(
      frame,
      "clean note covers the worktree alone; the orphan's files were never checked",
    ).toContain("Nothing uncommitted in the worktrees.");
    ui.setup.mockInput.pressKey("y");
    frame = await ui.frame();
    expect(executed).toHaveLength(1);
    expect(Object.keys(executed[0]!)).toContain(folder.id);
    expect(frame).toContain("Removed 1 worktree and 1 orphaned folder");
  } finally {
    await ui.stop();
  }
});

test("at 80 columns the projects table fits a column per verdict, and the orphans' details hold no repository path", async () => {
  const ui = await start(80, 24, [
    row("api", 2000),
    row("web", 3000, { repoName: "beta", repoPath: "/repos/beta", path: "/repos/beta/web" }),
    orphan("abcd", 5000),
  ]);
  try {
    let frame = await ui.frame();
    const lines = frame.split("\n");
    expect(lines.find((line) => line.includes("PROJECT"))).toBe(
      "  PROJECT            WORKTREES  SAFE  REV  BUSY  BRK  ORPH  SAFE SIZE      TOTAL",
    );
    const names = lines
      .map((line) => line.match(/^. (All projects|alpha|beta|Orphaned folders) +\d/)?.[1])
      .filter(Boolean);
    expect(names).toEqual(["All projects", "alpha", "beta", "Orphaned folders"]);
    expect(frame).toMatch(/Orphaned folders +1 +· +· +· +· +1 +· +4\.9 MB/);
    ui.setup.mockInput.pressKey("G");
    frame = await ui.frame();
    expect(frame).toContain("Orphaned folders  1 folder no repo knows");
    expect(frame).toMatch(/SIZE +up to 4\.9 MB/);
    expect(frame).toMatch(/MADE BY +Codex 1/);
    expect(frame).toMatch(/LARGEST +abcd\/app · 4\.9 MB/);
    expect(frame).not.toContain("SAFE TO FREE");
    expect(frame).not.toContain("~/orphans");
  } finally {
    await ui.stop();
  }
});

test("the Orphaned tab is the sixth, shortened with the others on a narrow list, and in the key overlay", async () => {
  const ui = await start(60, 16, [orphan("abcd", 5000)]);
  try {
    ui.setup.mockInput.pressKey("\r");
    let frame = await ui.frame();
    expect(frame).toContain(" All 1  Safe 0  Rev 0  Busy 0  Brk 0  Orph 1 ");
    ui.setup.mockInput.pressKey("6");
    frame = await ui.frame();
    expect(frame).toContain("app");
    ui.setup.mockInput.pressKey("2");
    expect(await ui.frame()).toContain("No Safe worktrees. Press 1 to see all.");
    ui.setup.mockInput.pressKey("?");
    frame = await ui.frame();
    expect(frame).toContain("1-6");
  } finally {
    await ui.stop();
  }
});

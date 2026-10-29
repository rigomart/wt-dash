import { expect, test } from "bun:test";
import type { RemovalEntry } from "../src/core/actions";
import type { DashboardSnapshot, WorktreeRow } from "../src/core/types";
import {
  ALL_PROJECTS,
  CONFIRM_ARM_MS,
  initialState,
  listView,
  projectsView,
  update,
  type Context,
  type Key,
  type UiEvent,
  type UiState,
} from "../src/ui/model";

function row(id: string, sizeKiB: number, overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id,
    repoPath: "/repos/alpha",
    repoName: "alpha",
    path: `/repos/alpha/worktrees/${id}`,
    branch: id,
    headSha: "abcdef1",
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
    defaultBranch: "main",
    mainBase: "main",
    locked: false,
    prunable: false,
    operation: null,
    sizeKiB,
    sizeMeasuredAt: null,
    verdict: "Safe",
    reason: "Integrated",
    ...overrides,
  };
}

function context(rows: WorktreeRow[]): Context {
  const snapshot: DashboardSnapshot = {
    generation: 1,
    repos: [],
    rows,
    errors: {},
    fatalError: null,
    progress: {
      phase: "complete",
      reposTotal: 1,
      reposDone: 1,
      startedAt: null,
      completedAt: null,
    },
  };
  return { snapshot, now: 1_000, pageSize: 10, canAct: true, canExpand: true };
}

function press(state: UiState, ctx: Context, ...keys: Array<string | Partial<Key>>): UiState {
  for (const item of keys) {
    const key: Key =
      typeof item === "string"
        ? {
            name: item.length === 1 ? item.toLowerCase() : item,
            char: item.length === 1 ? item : "",
            ctrl: false,
          }
        : { name: "", char: "", ctrl: false, ...item };
    state = update(state, { type: "key", key }, ctx).state;
  }
  return state;
}

function openedWorktreeList(ctx: Context): UiState {
  const state = update(initialState(), { type: "snapshot" }, ctx).state;
  return state.screen.kind === "projects" ? press(state, ctx, "g", "return") : state;
}

function send(state: UiState, ctx: Context, event: UiEvent) {
  return update(state, event, ctx);
}

const entry = (item: WorktreeRow, overrides: Partial<RemovalEntry> = {}): RemovalEntry => ({
  row: item,
  blockedReason: null,
  localFiles: [],
  ignoredFiles: [],
  disposableIgnored: 0,
  requiresDiscard: false,
  branchWillBeRetained: false,
  ...overrides,
});

test("a selects every Safe row in view and pressing it again clears them", () => {
  const ctx = context([
    row("a", 10),
    row("b", 20),
    row("c", 30, { verdict: "Review", mainState: "ahead" }),
    row("d", 5, { verdict: "Safe", locked: true }),
  ]);
  let state = press(openedWorktreeList(ctx), ctx, "a");
  expect([...state.selected].sort()).toEqual(["a", "b"]);
  expect(state.toast?.text).toContain("Selected 2 Safe worktrees");
  state = press(state, ctx, "a");
  expect(state.selected.size).toBe(0);
});

test("esc undoes one thing at a time", () => {
  const ctx = context([row("a", 10), row("b", 20)]);
  let state = press(openedWorktreeList(ctx), ctx, " ", "2", "/", "b", { name: "return" });
  expect(state.search).toBe("b");
  state = press(state, ctx, { name: "escape" });
  expect(state.search).toBe("");
  expect(state.selected.size).toBe(1);
  state = press(state, ctx, { name: "escape" });
  expect(state.selected.size).toBe(0);
  expect(state.tab).toBe("Safe");
  state = press(state, ctx, { name: "escape" });
  expect(state.tab).toBe("All");
});

test("sort keys cycle with their natural direction and S reverses", () => {
  const ctx = context([row("a", 10), row("b", 20)]);
  let state = openedWorktreeList(ctx);
  expect(listView(state, ctx.snapshot).rows.map((item) => item.id)).toEqual(["b", "a"]);
  state = press(state, ctx, "S");
  expect(listView(state, ctx.snapshot).rows.map((item) => item.id)).toEqual(["a", "b"]);
  state = press(state, ctx, "s", "s");
  expect(state.sort).toBe("repo");
  expect(state.descending).toBe(false);
});

test("rows follow verdict sections, or repos with Safe rows first when grouped", () => {
  const ctx = context([
    row("big-review", 90, { verdict: "Review", mainState: "ahead" }),
    row("safe", 10),
    row("busy", 50, { verdict: "Busy", operation: "rebase" }),
    row("beta-safe", 70, { repoName: "beta", repoPath: "/repos/beta" }),
  ]);
  let state = openedWorktreeList(ctx);
  let view = listView(state, ctx.snapshot);
  expect(view.sections.map((section) => section.kind === "verdict" && section.verdict)).toEqual([
    "Safe",
    "Review",
    "Busy",
  ]);
  expect(view.rows.map((item) => item.id)).toEqual(["beta-safe", "safe", "big-review", "busy"]);
  expect(view.focus?.id).toBe("beta-safe");
  state = press(state, ctx, "v");
  view = listView(state, ctx.snapshot);
  expect(view.sections.map((section) => section.kind === "repo" && section.repoName)).toEqual([
    "alpha",
    "beta",
  ]);
  expect(view.rows.map((item) => item.id)).toEqual(["safe", "big-review", "busy", "beta-safe"]);
});

test("a plan that arrives after esc cancelled the check is ignored", () => {
  const ctx = context([row("a", 10)]);
  let result = send(openedWorktreeList(ctx), ctx, {
    type: "key",
    key: { name: "x", char: "x", ctrl: false },
  });
  expect(result.effects[0]).toMatchObject({ type: "prepareRemoval", rows: [{ id: "a" }] });
  const cancelled = press(result.state, ctx, { name: "escape" });
  result = send(cancelled, ctx, {
    type: "planReady",
    token: 1,
    plan: { entries: [entry(row("a", 10))] },
  });
  expect(result.state.confirm).toBeNull();
});

test("x then y removes the selection in the background with the choices the confirm bar named", () => {
  const rows = [
    row("clean", 10),
    row("dirty", 20),
    row("unmerged", 30, { verdict: "Review", mainState: "ahead" }),
    row("moved", 5),
  ];
  const ctx = context(rows);
  let state = press(openedWorktreeList(ctx), ctx, "a", " ", "x");
  const plan = {
    entries: [
      entry(rows[0]!),
      entry(rows[1]!, { localFiles: ["?? notes.md"], requiresDiscard: true }),
      entry(rows[2]!, { branchWillBeRetained: true }),
      entry(rows[3]!, { blockedReason: "it changed; refresh and preview again" }),
    ],
  };
  state = send(state, ctx, { type: "planReady", token: state.pending!.token, plan }).state;
  expect(state.confirm).toMatchObject({ kind: "remove", deleteUnmerged: false, reap: true });
  if (state.confirm?.kind !== "remove") throw new Error("expected a removal confirm");
  expect(state.confirm.ready.map((item) => item.row.id)).toEqual(["clean", "dirty", "unmerged"]);
  expect(state.confirm.blocked.map((item) => item.row.id)).toEqual(["moved"]);
  state = press(state, ctx, "D");
  const started = send(state, ctx, { type: "key", key: { name: "y", char: "y", ctrl: false } });
  expect(started.state.confirm).toBeNull();
  expect(started.state.jobs[0]!.order).toEqual(["clean", "dirty", "unmerged"]);
  // The skipped row stays selected so it can be retried after a rescan.
  expect([...started.state.selected]).toEqual(["moved"]);
  expect(started.effects).toEqual([
    {
      type: "executeRemoval",
      jobId: started.state.jobs[0]!.id,
      plan,
      choices: {
        clean: {
          include: true,
          discardChanges: false,
          forceDeleteBranch: false,
          reapProcesses: true,
        },
        dirty: {
          include: true,
          discardChanges: true,
          forceDeleteBranch: false,
          reapProcesses: true,
        },
        unmerged: {
          include: true,
          discardChanges: false,
          forceDeleteBranch: true,
          reapProcesses: true,
        },
        moved: {
          include: false,
          discardChanges: false,
          forceDeleteBranch: false,
          reapProcesses: false,
        },
      },
    },
  ]);
});

test("x on a blocked row explains why instead of checking it", () => {
  const ctx = context([row("locked", 10, { verdict: "Review", locked: true })]);
  const result = send(openedWorktreeList(ctx), ctx, {
    type: "key",
    key: { name: "x", char: "x", ctrl: false },
  });
  expect(result.effects).toEqual([]);
  expect(result.state.toast?.text).toContain("Can't remove locked: it's locked; unlock it first");
});

test("D explains that there is nothing extra to delete when every branch is merged", () => {
  const rows = [row("merged", 10)];
  const ctx = context(rows);
  let state = press(openedWorktreeList(ctx), ctx, "x");
  state = send(state, ctx, {
    type: "planReady",
    token: state.pending!.token,
    plan: { entries: [entry(rows[0]!)] },
  }).state;
  state = press(state, ctx, "D");
  expect(state.toast?.text).toContain("nothing extra to delete");
});

test("confirmed rows leave the list at once; failures come back with their reason and removed rows stay hidden until the next scan", () => {
  const rows = [
    row("a", 10),
    row("b", 20),
    row("c", 30, { verdict: "Review", mainState: "ahead" }),
  ];
  const ctx = context(rows);
  let state = press(openedWorktreeList(ctx), ctx, "a", "x");
  const plan = { entries: rows.slice(0, 2).map((item) => entry(item)) };
  state = send(state, ctx, { type: "planReady", token: state.pending!.token, plan }).state;
  state = press(state, ctx, "y");
  expect(listView(state, ctx.snapshot).rows.map((item) => item.id)).toEqual(["c"]);
  expect(listView(state, ctx.snapshot).focus?.id).toBe("c");
  state = send(state, ctx, { type: "progress", id: "b", status: "removing" }).state;
  expect(state.jobs[0]!.status.b).toBe("removing");
  state = send(state, ctx, { type: "progress", id: "a", status: "failed" }).state;
  expect(listView(state, ctx.snapshot).rows.map((item) => item.id)).toEqual(["a", "c"]);
  const done = send(state, ctx, {
    type: "removalDone",
    jobId: state.jobs[0]!.id,
    result: {
      freedKiB: 25,
      warnings: [],
      items: [
        { id: "b", status: "removed", branchOutcome: "deleted" },
        { id: "a", status: "failed", error: "wt remove exited 1: busy" },
      ],
    },
  });
  expect(done.effects).toEqual([{ type: "refresh", repos: ["/repos/alpha"] }]);
  state = done.state;
  expect(state.jobs).toEqual([]);
  expect(state.toast?.text).toContain("Removed 1 of 2");
  expect(state.failures.a).toContain("busy");
  expect(listView(state, ctx.snapshot).rows.map((item) => item.id)).toEqual(["a", "c"]);
  const rescanned = { ...ctx, snapshot: { ...ctx.snapshot, generation: 2 } };
  state = send(state, rescanned, { type: "snapshot" }).state;
  expect(state.gone.size).toBe(0);
});

test("Ctrl-C during a removal stops after the current worktree and then quits", () => {
  const rows = [row("a", 10)];
  const ctx = context(rows);
  let state = press(openedWorktreeList(ctx), ctx, "x");
  state = send(state, ctx, {
    type: "planReady",
    token: state.pending!.token,
    plan: { entries: [entry(rows[0]!)] },
  }).state;
  state = press(state, ctx, "y");
  const stopped = send(state, ctx, { type: "key", key: { name: "c", char: "", ctrl: true } });
  expect(stopped.effects).toEqual([]);
  expect(stopped.state.jobs[0]!.stopping).toBe(true);
  const done = send(stopped.state, ctx, {
    type: "removalDone",
    jobId: stopped.state.jobs[0]!.id,
    result: { items: [], freedKiB: null, warnings: [] },
  });
  expect(done.effects.map((effect) => effect.type)).toEqual(["refresh", "quit"]);
});

test("a second removal can be confirmed while the first runs, and each batch reports when it ends", () => {
  const rows = [row("a", 10), row("b", 20)];
  const ctx = context(rows);
  let state = press(openedWorktreeList(ctx), ctx, "x");
  state = send(state, ctx, {
    type: "planReady",
    token: state.pending!.token,
    plan: { entries: [entry(rows[1]!)] },
  }).state;
  state = press(state, ctx, "y");
  expect(listView(state, ctx.snapshot).focus?.id).toBe("a");
  const checking = send(state, ctx, { type: "key", key: { name: "x", char: "x", ctrl: false } });
  expect(checking.effects[0]).toMatchObject({ type: "prepareRemoval", rows: [{ id: "a" }] });
  state = send(checking.state, ctx, {
    type: "planReady",
    token: checking.state.pending!.token,
    plan: { entries: [entry(rows[0]!)] },
  }).state;
  const queued = send(state, ctx, { type: "key", key: { name: "y", char: "y", ctrl: false } });
  expect(queued.state.toast?.text).toBe("Queued 1 worktree after the current removal");
  const [first, second] = queued.state.jobs;
  expect(queued.effects).toMatchObject([{ type: "executeRemoval", jobId: second!.id }]);
  expect(listView(queued.state, ctx.snapshot).rows).toEqual([]);
  state = send(queued.state, ctx, {
    type: "removalDone",
    jobId: first!.id,
    result: { freedKiB: null, warnings: [], items: [{ id: "b", status: "removed" }] },
  }).state;
  expect(state.jobs).toEqual([second]);
  state = send(state, ctx, {
    type: "removalDone",
    jobId: second!.id,
    result: { freedKiB: null, warnings: [], items: [{ id: "a", status: "removed" }] },
  }).state;
  expect(state.jobs).toEqual([]);
});

test("enter confirms the dialog only once it has been on screen briefly", () => {
  const rows = [row("a", 10)];
  const ctx = context(rows);
  let state = press(openedWorktreeList(ctx), ctx, { name: "return" });
  state = send(state, ctx, {
    type: "planReady",
    token: state.pending!.token,
    plan: { entries: [entry(rows[0]!)] },
  }).state;
  const early = send(
    state,
    { ...ctx, now: ctx.now + CONFIRM_ARM_MS - 1 },
    { type: "key", key: { name: "return", char: "\r", ctrl: false } },
  );
  expect(early.effects).toEqual([]);
  expect(early.state.confirm).not.toBeNull();
  const armed = send(
    state,
    { ...ctx, now: ctx.now + CONFIRM_ARM_MS },
    { type: "key", key: { name: "return", char: "\r", ctrl: false } },
  );
  expect(armed.effects).toMatchObject([{ type: "executeRemoval" }]);
});

test("enter on a Broken row prunes its repository instead of removing", () => {
  const ctx = context([row("gone", 10, { verdict: "Broken", prunable: true })]);
  const result = send(openedWorktreeList(ctx), ctx, {
    type: "key",
    key: { name: "return", char: "\r", ctrl: false },
  });
  expect(result.effects).toEqual([{ type: "preparePrune", token: 1, repoPath: "/repos/alpha" }]);
});

test("toasts expire on tick", () => {
  const ctx = context([row("a", 10)]);
  const state = press(openedWorktreeList(ctx), { ...ctx, canExpand: false }, "i");
  expect(state.toast).not.toBeNull();
  const later = send(state, { ...ctx, now: ctx.now + 60_000 }, { type: "tick" });
  expect(later.state.toast).toBeNull();
});

const beta = (id: string, sizeKiB: number, overrides: Partial<WorktreeRow> = {}) =>
  row(id, sizeKiB, {
    repoName: "beta",
    repoPath: "/repos/beta",
    path: `/repos/beta/worktrees/${id}`,
    ...overrides,
  });

test("several projects start on the projects screen; enter opens one and esc comes back to it", () => {
  const ctx = context([
    row("a", 10),
    row("b", 20, { verdict: "Review", mainState: "ahead" }),
    beta("c", 30),
  ]);
  let state = send(initialState(), ctx, { type: "snapshot" }).state;
  expect(state.screen).toEqual({ kind: "projects" });
  const view = projectsView(state, ctx.snapshot);
  expect(view.projects.map((project) => [project.repoName, project.counts])).toEqual([
    ["alpha", { Safe: 1, Review: 1, Busy: 0, Broken: 0 }],
    ["beta", { Safe: 1, Review: 0, Busy: 0, Broken: 0 }],
  ]);
  expect(view.projects[0]).toMatchObject({ totalKiB: 30, safeKiB: 10 });
  state = press(state, ctx, "j", { name: "return" });
  expect(state.screen).toEqual({ kind: "project", repoPath: "/repos/beta" });
  expect(listView(state, ctx.snapshot).rows.map((item) => item.id)).toEqual(["c"]);
  state = press(state, ctx, { name: "escape" });
  expect(state.screen).toEqual({ kind: "projects" });
  expect(projectsView(state, ctx.snapshot).focus?.repoName).toBe("beta");
});

test("a scan that finds one project opens it, unless the user has already pressed a key", () => {
  const ctx = context([row("a", 10)]);
  ctx.snapshot = {
    ...ctx.snapshot,
    repos: [
      { path: "/repos/alpha", linked: 1 },
      { path: "/repos/quiet", linked: 0 },
    ],
  };
  expect(send(initialState(), ctx, { type: "snapshot" }).state.screen).toEqual({
    kind: "project",
    repoPath: "/repos/alpha",
  });
  const pressed = press(initialState(), ctx, "?", { name: "escape" });
  expect(send(pressed, ctx, { type: "snapshot" }).state.screen).toEqual({ kind: "projects" });
});

test("projects with linked worktrees show while their scan is pending, and empty repos are only counted", () => {
  const ctx = context([]);
  ctx.snapshot = {
    ...ctx.snapshot,
    repos: [
      { path: "/repos/alpha", linked: 3 },
      { path: "/repos/beta", linked: 2 },
      { path: "/repos/quiet", linked: 0 },
    ],
    progress: { ...ctx.snapshot.progress, phase: "scanning" },
  };
  const view = projectsView(initialState(), ctx.snapshot);
  expect(
    view.projects.map((project) => [project.repoName, project.pending, project.linked]),
  ).toEqual([
    ["alpha", true, 3],
    ["beta", true, 2],
  ]);
  expect(view.empty).toBe(1);
});

test("a on the projects screen selects that project's Safe worktrees and x removes them", () => {
  const ctx = context([row("a", 10), row("b", 20), beta("c", 30)]);
  let state = send(initialState(), ctx, { type: "snapshot" }).state;
  expect(press(state, ctx, "x").toast?.text).toContain("Nothing selected");
  state = press(state, ctx, "a");
  expect([...state.selected].sort()).toEqual(["a", "b"]);
  expect(state.toast?.text).toBe("Selected 2 Safe worktrees in alpha · up to 30 KB");
  const result = send(state, ctx, { type: "key", key: { name: "x", char: "x", ctrl: false } });
  expect(result.effects[0]).toMatchObject({
    type: "prepareRemoval",
    rows: [{ id: "a" }, { id: "b" }],
  });
});

test("All projects comes first, previews every worktree, and a on it selects Safe ones in every project", () => {
  const ctx = context([
    row("a", 10),
    row("b", 20, { verdict: "Review", mainState: "ahead" }),
    beta("c", 30),
  ]);
  let state = send(initialState(), ctx, { type: "snapshot" }).state;
  const view = projectsView(state, ctx.snapshot);
  expect(view.entries.map((project) => project.repoName)).toEqual([
    "All projects",
    "alpha",
    "beta",
  ]);
  expect(view.entries[0]).toMatchObject({ totalKiB: 60, safeKiB: 40 });
  expect(view.focus?.repoName).toBe("alpha");
  expect(
    listView(state, ctx.snapshot)
      .rows.map((item) => item.id)
      .sort(),
  ).toEqual(["a", "b"]);
  expect(listView(state, ctx.snapshot).focus).toBeNull();
  state = press(state, ctx, "k");
  expect(state.projectFocus).toBe(ALL_PROJECTS);
  expect(
    listView(state, ctx.snapshot)
      .rows.map((item) => item.id)
      .sort(),
  ).toEqual(["a", "b", "c"]);
  state = press(state, ctx, "a");
  expect([...state.selected].sort()).toEqual(["a", "c"]);
  expect(state.toast?.text).toBe("Selected 2 Safe worktrees in every project · up to 40 KB");
  state = press(state, ctx, { name: "return" });
  expect(state.screen).toEqual({ kind: "all" });
});

test("left or tab in a list goes back to the projects, keeping the project it came from", () => {
  const ctx = context([row("a", 10), beta("c", 30)]);
  let state = send(initialState(), ctx, { type: "snapshot" }).state;
  state = press(state, ctx, "j", { name: "right" }, "2");
  expect(state.screen).toEqual({ kind: "project", repoPath: "/repos/beta" });
  state = press(state, ctx, { name: "left" });
  expect(state.screen).toEqual({ kind: "projects" });
  expect(state.tab).toBe("Safe");
  expect(projectsView(state, ctx.snapshot).focus?.repoName).toBe("beta");
  state = press(state, ctx, "g", { name: "tab" });
  expect(state.screen).toEqual({ kind: "all" });
  state = press(state, ctx, { name: "tab" });
  expect(state.screen).toEqual({ kind: "projects" });
  expect(state.projectFocus).toBe(ALL_PROJECTS);
});

test("[ and ] step between projects, and / searches every project", () => {
  const ctx = context([row("a", 10), beta("c", 30)]);
  let state = press(send(initialState(), ctx, { type: "snapshot" }).state, ctx, { name: "return" });
  expect(state.screen).toEqual({ kind: "project", repoPath: "/repos/alpha" });
  state = press(state, ctx, "]");
  expect(state.screen).toEqual({ kind: "project", repoPath: "/repos/beta" });
  state = press(state, ctx, "]");
  expect(state.screen).toEqual({ kind: "project", repoPath: "/repos/beta" });
  state = press(state, ctx, "[", { name: "escape" }, "/", "b", "e", "t", "a");
  expect(state.screen).toEqual({ kind: "all" });
  expect(listView(state, ctx.snapshot).rows.map((item) => item.id)).toEqual(["c"]);
});

test("projects are ordered by how many worktrees they have, then by name", () => {
  const ctx = context([
    row("a", 10),
    beta("b", 10),
    beta("c", 10),
    row("d", 10, { repoName: "gamma", repoPath: "/repos/gamma", path: "/repos/gamma/d" }),
  ]);
  const view = projectsView(initialState(), ctx.snapshot);
  expect(view.projects.map((project) => project.repoName)).toEqual(["beta", "alpha", "gamma"]);
});

test("branches without a worktree are selectable but not counted as worktrees or sized", () => {
  const leftover = row("old", 0, {
    kind: "branch",
    path: null,
    changes: null,
    sizeKiB: null,
    tool: "Other",
  });
  const ctx = context([row("a", 10), leftover]);
  const project = projectsView(initialState(), ctx.snapshot).projects[0]!;
  expect([project.rows.length, project.worktrees, project.unsized, project.counts.Safe]).toEqual([
    2, 1, 0, 2,
  ]);
  let state = press(openedWorktreeList(ctx), ctx, "a");
  expect([...state.selected].sort()).toEqual(["a", "old"]);
  expect(state.toast?.text).toBe("Selected 1 Safe worktree and 1 branch · up to 10 KB");
  state = press(state, ctx, "j", "R");
  expect(state.toast?.text).toBe("A branch without a worktree has no folder to measure");
});

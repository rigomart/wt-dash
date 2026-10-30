import { expect, test } from "bun:test";
import { beta, context, openedWorktreeList, orphan, press, row } from "./support/update";
import { listView, projectsView, repoCount, soleProject } from "../src/ui/selectors";
import { ORPHANS } from "../src/core/types";
import { initialState } from "../src/ui/state";

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

test("#24: only a worktree with no size whose measurement is running counts as sizing", () => {
  const gone = row("gone", 0, { verdict: "Broken", prunable: true, sizeKiB: null });
  const failed = row("failed", 0, { sizeKiB: null });
  const lockedGone = row("locked-gone", 0, { locked: true, sizeKiB: null });
  const measuring = row("measuring", 0, { prunable: true, sizeKiB: null });
  const remeasured = row("remeasured", 10);
  const ctx = context(
    [row("a", 10), gone, failed, lockedGone, measuring, remeasured],
    [measuring.path!, remeasured.path!],
  );
  const project = projectsView(initialState(), ctx.snapshot).projects[0]!;
  expect([project.worktrees, project.unsized]).toEqual([6, 1]);
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

test("orphans form a pseudo-project after every repository, counted in All projects but not as a project", () => {
  const ctx = context([
    row("a", 10),
    beta("b", 20),
    beta("c", 30, { verdict: "Review", mainState: "ahead" }),
    orphan("x", 100),
    orphan("y", 200),
    orphan("z", 300),
  ]);
  const view = projectsView(initialState(), ctx.snapshot);
  expect(view.entries.map((project) => project.repoName)).toEqual([
    "All projects",
    "beta",
    "alpha",
    "Orphaned folders",
  ]);
  expect(repoCount(view)).toBe(2);
  const orphans = view.projects.at(-1)!;
  expect(orphans).toMatchObject({ repoPath: ORPHANS, worktrees: 3, totalKiB: 600, safeKiB: 0 });
  expect(orphans.counts).toEqual({ Safe: 0, Review: 0, Busy: 0, Broken: 0, Orphaned: 3 });
  expect(view.entries[0]!.counts.Orphaned).toBe(3);
  expect(view.entries[0]).toMatchObject({ worktrees: 6, totalKiB: 660 });
});

test("orphans get the last tab and the last section, or the last group by repo", () => {
  const ctx = context([row("a", 10), beta("b", 20), orphan("x", 999)]);
  let state = openedWorktreeList(ctx);
  expect(state.screen).toEqual({ kind: "all" });
  let view = listView(state, ctx.snapshot);
  expect(view.counts).toEqual({ All: 3, Safe: 2, Review: 0, Busy: 0, Broken: 0, Orphaned: 1 });
  expect(view.sections.map((section) => section.kind === "verdict" && section.verdict)).toEqual([
    "Safe",
    "Orphaned",
  ]);
  state = press(state, ctx, "v");
  view = listView(state, ctx.snapshot);
  expect(view.sections.map((section) => section.kind === "repo" && section.repoName)).toEqual([
    "beta",
    "alpha",
    "Orphaned folders",
  ]);
});

test("orphans don't count as a project when deciding whether to open the only one", () => {
  const ctx = context([row("a", 10), orphan("x", 10)]);
  expect(soleProject(ctx.snapshot)).toBe("/repos/alpha");
  const repos = { ...ctx.snapshot, repos: [{ path: "/repos/alpha", linked: 1 }] };
  expect(soleProject(repos)).toBe("/repos/alpha");
  expect(soleProject(context([orphan("x", 10)]).snapshot)).toBeNull();
});

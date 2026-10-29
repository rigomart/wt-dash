import { expect, test } from "bun:test";
import { beta, context, openedWorktreeList, press, row } from "./support/update";
import { listView, projectsView } from "../src/ui/selectors";
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

test("#24: a worktree whose folder is missing is not counted as sizing", () => {
  const gone = row("gone", 0, { verdict: "Broken", prunable: true, sizeKiB: null });
  const measuring = row("measuring", 0, { sizeKiB: null });
  const ctx = context([row("a", 10), gone, measuring]);
  const project = projectsView(initialState(), ctx.snapshot).projects[0]!;
  expect([project.worktrees, project.unsized]).toEqual([3, 1]);
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

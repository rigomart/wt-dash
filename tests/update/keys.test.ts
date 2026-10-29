import { expect, test } from "bun:test";
import { beta, context, openedWorktreeList, orphan, press, row, send } from "../support/update";
import { listView, projectsView } from "../../src/ui/selectors";
import { ALL_PROJECTS, initialState } from "../../src/ui/state";

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
    ["alpha", { Safe: 1, Review: 1, Busy: 0, Broken: 0, Orphaned: 0 }],
    ["beta", { Safe: 1, Review: 0, Busy: 0, Broken: 0, Orphaned: 0 }],
  ]);
  expect(view.projects[0]).toMatchObject({ totalKiB: 30, safeKiB: 10 });
  state = press(state, ctx, "j", { name: "return" });
  expect(state.screen).toEqual({ kind: "project", repoPath: "/repos/beta" });
  expect(listView(state, ctx.snapshot).rows.map((item) => item.id)).toEqual(["c"]);
  state = press(state, ctx, { name: "escape" });
  expect(state.screen).toEqual({ kind: "projects" });
  expect(projectsView(state, ctx.snapshot).focus?.repoName).toBe("beta");
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

test("6 shows only the orphans, and esc returns to every row", () => {
  const ctx = context([row("a", 10), beta("b", 20), orphan("x", 30)]);
  let state = press(openedWorktreeList(ctx), ctx, "6");
  expect(state.tab).toBe("Orphaned");
  expect(listView(state, ctx.snapshot).rows.map((item) => item.id)).toEqual([orphan("x", 30).id]);
  state = press(state, ctx, { name: "escape" });
  expect(state.tab).toBe("All");
});

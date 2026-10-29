import { expect, test } from "bun:test";
import { beta, context, openedWorktreeList, press, row, send } from "../support/update";
import { initialState } from "../../src/ui/state";

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

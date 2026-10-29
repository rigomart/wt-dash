import { expect, test } from "bun:test";
import { context, entry, openedWorktreeList, press, row, send } from "../support/update";
import { initialState } from "../../src/ui/state";

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

test("toasts expire on tick", () => {
  const ctx = context([row("a", 10)]);
  const state = press(openedWorktreeList(ctx), { ...ctx, canExpand: false }, "i");
  expect(state.toast).not.toBeNull();
  const later = send(state, { ...ctx, now: ctx.now + 60_000 }, { type: "tick" });
  expect(later.state.toast).toBeNull();
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

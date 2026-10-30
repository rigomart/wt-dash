import { expect, test } from "bun:test";
import {
  beta,
  context,
  entry,
  openedWorktreeList,
  orphan,
  press,
  row,
  send,
} from "../support/update";
import { ORPHANS } from "../../src/core/types";
import { listView } from "../../src/ui/selectors";
import { CONFIRM_ARM_MS } from "../../src/ui/state";

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

test("space selects an orphan, a leaves it out, and its removal refreshes the orphans", () => {
  const folder = orphan("x", 50);
  const ctx = context([row("a", 10), beta("b", 20, { verdict: "Review" }), folder]);
  let state = press(openedWorktreeList(ctx), ctx, "a");
  expect([...state.selected]).toEqual(["a"]);
  state = press(state, ctx, "G", " ");
  expect([...state.selected].sort()).toEqual(["a", folder.id].sort());
  const result = send(state, ctx, { type: "key", key: { name: "x", char: "x", ctrl: false } });
  expect(result.effects[0]).toMatchObject({ type: "prepareRemoval" });
  expect(result.state.pending?.label).toBe("Checking 1 worktree and 1 orphaned folder…");
  const plan = { entries: [entry(row("a", 10)), entry(folder)] };
  state = send(result.state, ctx, {
    type: "planReady",
    token: result.state.pending!.token,
    plan,
  }).state;
  const started = send(state, ctx, { type: "key", key: { name: "y", char: "y", ctrl: false } });
  const job = started.state.jobs[0]!;
  expect(job.order).toEqual(["a", folder.id]);
  const done = send(started.state, ctx, {
    type: "removalDone",
    jobId: job.id,
    result: {
      items: [
        { id: "a", status: "removed", branchOutcome: "deleted" },
        { id: folder.id, status: "removed", branchOutcome: "not_attempted" },
      ],
      freedKiB: 60,
      warnings: [],
    },
  });
  expect(done.state.toast?.text).toBe("Removed 1 worktree and 1 orphaned folder · freed 60 KB");
  expect(done.effects).toEqual([{ type: "refresh", repos: ["/repos/alpha", ORPHANS] }]);
});

test("enter on a focused orphan opens its removal, not a prune", () => {
  const folder = orphan("x", 50);
  const ctx = context([folder]);
  const result = send(openedWorktreeList(ctx), ctx, {
    type: "key",
    key: { name: "return", char: "\r", ctrl: false },
  });
  expect(result.effects).toEqual([{ type: "prepareRemoval", token: 1, rows: [folder] }]);
});

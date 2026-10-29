import type { RemovalChoice } from "../../core/removal/types";
import type { WorktreeRow } from "../../core/types";
import { branchLabel, countLabel, rowsLabel } from "../format";
import { listView, projectsView, type ListView } from "../selectors";
import {
  ALL_PROJECTS,
  CONFIRM_ARM_MS,
  DESCENDING_BY_DEFAULT,
  SORT_KEYS,
  TABS,
  type Confirm,
  type Context,
  type Job,
  type Key,
  type Result,
  type RunStatus,
  type Screen,
  type UiState,
} from "../state";
import { quitRequest, startPrune, startRemoval, stopJobs } from "./removal";
import { same, toast } from "./result";
import { selectAllSafe, toggleSelect } from "./selection";

export function onKey(state: UiState, key: Key, ctx: Context): Result {
  if (!state.keyPressed) state = { ...state, keyPressed: true };
  if (key.ctrl && key.name === "c") return quitRequest(state, ctx);
  if (state.help) {
    if (key.name === "escape" || key.char === "?") return same({ ...state, help: false });
    if (key.char === "q") return quitRequest(state, ctx);
    return same(state);
  }
  if (state.confirm) return onConfirmKey(state, state.confirm, key, ctx);
  if (state.screen.kind === "projects") return onProjectsKey(state, key, ctx);
  return onListKey(state, key, ctx);
}

export function openScreen(state: UiState, screen: Screen): UiState {
  return {
    ...state,
    screen,
    projectFocus:
      screen.kind === "project"
        ? screen.repoPath
        : screen.kind === "all"
          ? ALL_PROJECTS
          : state.projectFocus,
    focusId: null,
    moved: false,
    expanded: false,
    detailTop: 0,
  };
}

function onProjectsKey(state: UiState, key: Key, ctx: Context): Result {
  const view = projectsView(state, ctx.snapshot);
  const focus = view.focus;
  const moveTo = (target: number | "first" | "last"): UiState => {
    if (!view.entries.length) return state;
    const index = Math.max(0, view.entries.indexOf(focus!));
    const last = view.entries.length - 1;
    const next =
      target === "first"
        ? 0
        : target === "last"
          ? last
          : Math.max(0, Math.min(last, index + target));
    return { ...state, projectFocus: view.entries[next]!.repoPath };
  };
  if (key.char === "q") return quitRequest(state, ctx);
  if (key.char === "?") return same({ ...state, help: true });
  if (isUp(key)) return same(moveTo(-1));
  if (isDown(key)) return same(moveTo(1));
  if (key.name === "pageup") return same(moveTo(-Math.max(1, ctx.pageSize - 1)));
  if (key.name === "pagedown") return same(moveTo(Math.max(1, ctx.pageSize - 1)));
  if (key.name === "home" || key.char === "g") return same(moveTo("first"));
  if (key.name === "end" || key.char === "G") return same(moveTo("last"));
  if (isEnter(key) || key.name === "right" || key.char === "l" || key.name === "tab") {
    if (!focus) return same(state);
    return same(
      openScreen(
        state,
        focus.repoPath === ALL_PROJECTS
          ? { kind: "all" }
          : { kind: "project", repoPath: focus.repoPath },
      ),
    );
  }
  if (key.char === "/") return same({ ...openScreen(state, { kind: "all" }), searching: true });
  if (key.char === "a") {
    if (!focus) return same(state);
    const where = focus.repoPath === ALL_PROJECTS ? "every project" : focus.repoName;
    return same(selectAllSafe(state, focus.rows, ctx, where));
  }
  if (key.char === "x") {
    if (!state.selected.size)
      return same(
        toast(state, ctx, "Nothing selected. Press a to select a project's Safe worktrees"),
      );
    return startRemoval(state, null, ctx);
  }
  if (key.char === "r") return { state, effects: [{ type: "refresh" }] };
  if (key.name === "escape") return same(clearStep(state, ctx));
  return same(state);
}

function stepProject(state: UiState, ctx: Context, step: number): UiState {
  const screen = state.screen;
  if (screen.kind !== "project") return state;
  const { projects } = projectsView(state, ctx.snapshot);
  const index = projects.findIndex((project) => project.repoPath === screen.repoPath);
  const target = projects[index + step];
  return target ? openScreen(state, { kind: "project", repoPath: target.repoPath }) : state;
}

const isUp = (key: Key) => key.name === "up" || key.char === "k";
const isDown = (key: Key) => key.name === "down" || key.char === "j";
const isEnter = (key: Key) => key.name === "return" || key.name === "enter";

function move(state: UiState, view: ListView, target: number | "first" | "last"): UiState {
  if (!view.rows.length) return state;
  const index = Math.max(
    0,
    view.rows.findIndex((row) => row.id === view.focus?.id),
  );
  const last = view.rows.length - 1;
  const next =
    target === "first" ? 0 : target === "last" ? last : Math.max(0, Math.min(last, index + target));
  return { ...state, focusId: view.rows[next]!.id, moved: true, detailTop: 0 };
}

function onConfirmKey(state: UiState, confirm: Confirm, key: Key, ctx: Context): Result {
  if (key.name === "escape" || key.char === "n") return same({ ...state, confirm: null });
  if (key.char === "q") return quitRequest(state, ctx);
  const confirmed =
    key.char === "y" || (isEnter(key) && ctx.now - confirm.openedAt >= CONFIRM_ARM_MS);
  if (confirm.kind === "prune") {
    if (!confirmed) return same(state);
    return {
      state: { ...state, confirm: null, pruning: true },
      effects: [{ type: "executePrune", plan: confirm.plan }],
    };
  }
  if (key.char === "D") {
    if (!confirm.ready.some((entry) => entry.branchWillBeRetained)) {
      return same(
        toast(state, ctx, "Every branch here is merged or detached; nothing extra to delete"),
      );
    }
    return same({ ...state, confirm: { ...confirm, deleteUnmerged: !confirm.deleteUnmerged } });
  }
  if (key.char === "e") return same({ ...state, confirm: { ...confirm, reap: !confirm.reap } });
  if (!confirmed) return same(state);
  const choices: Record<string, RemovalChoice> = {};
  for (const entry of confirm.plan.entries) {
    const ready = !entry.blockedReason;
    choices[entry.row.id] = {
      include: ready,
      discardChanges: ready && entry.requiresDiscard,
      forceDeleteBranch: ready && confirm.deleteUnmerged && entry.branchWillBeRetained,
      reapProcesses: ready && confirm.reap,
    };
  }
  const order = confirm.ready.map((entry) => entry.row.id);
  const queued = confirm.ready.map((entry) => entry.row);
  const failures = { ...state.failures };
  for (const id of order) delete failures[id];
  const token = state.token + 1;
  const waitsForRunningBatch = state.jobs.length > 0;
  const job: Job = {
    id: token,
    plan: confirm.plan,
    order,
    stopping: false,
    status: Object.fromEntries(order.map((id) => [id, "waiting" as RunStatus])),
  };
  const next: UiState = {
    ...state,
    token,
    confirm: null,
    jobs: [...state.jobs, job],
    failures,
    selected: new Set([...state.selected].filter((id) => !order.includes(id))),
  };
  const focused = keepFocusNear(next, state, ctx);
  return {
    state: waitsForRunningBatch
      ? toast(focused, ctx, `Queued ${rowsLabel(queued)} after the current removal`, "info", 3000)
      : focused,
    effects: [{ type: "executeRemoval", jobId: job.id, plan: confirm.plan, choices }],
  };
}

function keepFocusNear(next: UiState, before: UiState, ctx: Context): UiState {
  const old = listView(before, ctx.snapshot);
  if (!old.focus) return next;
  const remaining = new Set(listView(next, ctx.snapshot).rows.map((row) => row.id));
  if (remaining.has(old.focus.id)) return { ...next, focusId: old.focus.id, moved: true };
  const index = old.rows.indexOf(old.focus);
  const target =
    old.rows.slice(index + 1).find((row) => remaining.has(row.id)) ??
    old.rows
      .slice(0, index)
      .reverse()
      .find((row) => remaining.has(row.id));
  return target ? { ...next, focusId: target.id, moved: true, detailTop: 0 } : next;
}

function onListKey(state: UiState, key: Key, ctx: Context): Result {
  const view = listView(state, ctx.snapshot);
  const focus = view.focus;
  if (state.searching) {
    if (key.name === "escape") return same({ ...state, search: "", searching: false });
    if (isEnter(key)) return same({ ...state, searching: false });
    if (key.name === "backspace") return same({ ...state, search: state.search.slice(0, -1) });
    if (key.ctrl && key.name === "u") return same({ ...state, search: "" });
    if (key.name === "up") return same(move(state, view, -1));
    if (key.name === "down") return same(move(state, view, 1));
    if (!key.ctrl && key.char.length === 1 && key.char >= " ")
      return same({ ...state, search: state.search + key.char });
    return same(state);
  }
  if (state.expanded) {
    if (isUp(key)) return same({ ...state, detailTop: Math.max(0, state.detailTop - 1) });
    if (isDown(key)) return same({ ...state, detailTop: state.detailTop + 1 });
    if (key.char === "i" || key.name === "escape")
      return same({ ...state, expanded: false, detailTop: 0 });
  }
  if (key.char === "q") return quitRequest(state, ctx);
  if (key.char === "?") return same({ ...state, help: true });
  if (key.char === "/") return same({ ...state, searching: true });
  if (isUp(key)) return same(move(state, view, -1));
  if (isDown(key)) return same(move(state, view, 1));
  if (key.name === "pageup") return same(move(state, view, -Math.max(1, ctx.pageSize - 1)));
  if (key.name === "pagedown") return same(move(state, view, Math.max(1, ctx.pageSize - 1)));
  if (key.name === "home" || key.char === "g") return same(move(state, view, "first"));
  if (key.name === "end" || key.char === "G") return same(move(state, view, "last"));
  if (/^[1-5]$/.test(key.char)) return same({ ...state, tab: TABS[Number(key.char) - 1]! });
  if (key.name === "left" || key.char === "h" || key.name === "tab")
    return same(openScreen(state, { kind: "projects" }));
  if (key.char === "s") {
    const sort = SORT_KEYS[(SORT_KEYS.indexOf(state.sort) + 1) % SORT_KEYS.length]!;
    return same({ ...state, sort, descending: DESCENDING_BY_DEFAULT[sort] });
  }
  if (key.char === "S") return same({ ...state, descending: !state.descending });
  if (key.char === "v") {
    if (state.screen.kind !== "all")
      return same(
        toast(state, ctx, "Grouping by repo works in the all-projects view", "info", 2500),
      );
    return same({ ...state, grouped: !state.grouped });
  }
  if (key.char === "[") return same(stepProject(state, ctx, -1));
  if (key.char === "]") return same(stepProject(state, ctx, 1));
  if (key.char === "i") {
    if (!ctx.canExpand)
      return same(toast(state, ctx, "All details are already on screen", "info", 2500));
    return same({ ...state, expanded: true, detailTop: 0 });
  }
  if (key.char === "r") return { state, effects: [{ type: "refresh" }] };
  if (key.char === "R") {
    if (!focus) return same(state);
    if (focus.kind === "branch")
      return same(toast(state, ctx, "A branch without a worktree has no folder to measure"));
    return {
      state: toast(state, ctx, `Measuring ${branchLabel(focus)}…`, "info", 2500),
      effects: [{ type: "remeasure", id: focus.id }],
    };
  }
  if (key.name === "escape") return same(clearStep(state, ctx));
  if (key.char === " " || key.name === "space") return same(toggleSelect(state, focus, ctx));
  if (key.char === "a") return same(selectAllSafe(state, view.rows, ctx));
  if (isEnter(key) || key.char === "x") return startAction(state, focus, ctx);
  return same(state);
}

/** Enter acts: remove the selection or the focused row, or prune the record of a focused Broken row. */
function startAction(state: UiState, focus: WorktreeRow | null, ctx: Context): Result {
  if (!state.selected.size && focus?.verdict === "Broken") return startPrune(state, focus, ctx);
  return startRemoval(state, focus, ctx);
}

function clearStep(state: UiState, ctx: Context): UiState {
  if (state.pending) return toast({ ...state, pending: null }, ctx, "Cancelled");
  if (state.search) return { ...state, search: "" };
  if (state.expanded) return { ...state, expanded: false };
  if (state.selected.size)
    return toast(
      { ...state, selected: new Set() },
      ctx,
      `Cleared ${countLabel(state.selected.size, "selection")}`,
    );
  if (state.tab !== "All") return { ...state, tab: "All" };
  if (state.screen.kind !== "projects") return openScreen(state, { kind: "projects" });
  if (state.jobs.some((job) => !job.stopping)) {
    return toast(stopJobs(state), ctx, "Stopping after the current worktree", "warn", 60_000);
  }
  return state;
}

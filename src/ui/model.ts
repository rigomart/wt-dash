import {
  removalBlockReason,
  type FileReport,
  type PrunePlan,
  type RemovalChoice,
  type RemovalEntry,
  type RemovalPlan,
  type RemovalResult,
} from "../core/actions";
import { groupByRepo, selectRows } from "../core/view";
import type { DashboardSnapshot, Verdict, WorktreeRow } from "../core/types";
import { branchLabel, countLabel, rowsLabel, sizeLabel } from "./format";

export type Tab = "All" | "Safe" | "Review" | "Busy" | "Broken";
export const TABS: Tab[] = ["All", "Safe", "Review", "Busy", "Broken"];
/** Sorts rows within each section. */
export type SortKey = "size" | "age" | "repo";
const SORT_KEYS: SortKey[] = ["size", "age", "repo"];
const DESCENDING_BY_DEFAULT: Record<SortKey, boolean> = { size: true, age: true, repo: false };
export const VERDICTS: Verdict[] = ["Safe", "Review", "Busy", "Broken"];

export type Screen = { kind: "projects" } | { kind: "project"; repoPath: string } | { kind: "all" };
/** The `projectFocus` of the "All projects" entry. */
export const ALL_PROJECTS = "*";

export type Tone = "info" | "ok" | "warn" | "error";
export interface Toast {
  text: string;
  tone: Tone;
  until: number;
}
export type RunStatus = "waiting" | "removing" | "removed" | "failed" | "skipped" | "unverified";
export type FileState =
  | { kind: "loading" }
  | { kind: "ready"; report: FileReport }
  | { kind: "error"; message: string };

export type Confirm = { openedAt: number } & (
  | {
      kind: "remove";
      plan: RemovalPlan;
      ready: RemovalEntry[];
      blocked: RemovalEntry[];
      deleteUnmerged: boolean;
      reap: boolean;
    }
  | { kind: "prune"; plan: PrunePlan }
);

/** Milliseconds the dialog must be open before enter confirms it. */
export const CONFIRM_ARM_MS = 400;

/** A confirmed removal batch. */
export interface Job {
  id: number;
  plan: RemovalPlan;
  order: string[];
  status: Record<string, RunStatus>;
  stopping: boolean;
}

export interface UiState {
  screen: Screen;
  projectFocus: string | null;
  keyPressed: boolean;
  scanned: boolean;
  tab: Tab;
  search: string;
  searching: boolean;
  sort: SortKey;
  descending: boolean;
  grouped: boolean;
  focusId: string | null;
  /** False until the user moves; while false, focus stays on the first row as a scan streams in. */
  moved: boolean;
  expanded: boolean;
  detailTop: number;
  help: boolean;
  selected: ReadonlySet<string>;
  toast: Toast | null;
  pending: { kind: "removal" | "prune"; token: number; label: string } | null;
  token: number;
  confirm: Confirm | null;
  /** Confirmed batches in run order; the first is running. */
  jobs: Job[];
  quitAfterJobs: boolean;
  pruning: boolean;
  /** Rows removed by finished jobs, hidden until the next completed scan. */
  gone: ReadonlySet<string>;
  goneSince: number;
  /** Why the last attempt to remove a row did not remove it. */
  failures: Readonly<Record<string, string>>;
  generation: number;
  files: Readonly<Record<string, FileState>>;
  frame: number;
}

export interface Key {
  name: string;
  char: string;
  ctrl: boolean;
}

export type UiEvent =
  | { type: "key"; key: Key }
  | { type: "snapshot" }
  | { type: "tick" }
  | { type: "planReady"; token: number; plan: RemovalPlan }
  | { type: "planFailed"; token: number; error: string }
  | { type: "progress"; id: string; status: RunStatus }
  | { type: "removalDone"; jobId: number; result: RemovalResult }
  | { type: "removalFailed"; jobId: number; error: string }
  | { type: "pruneReady"; token: number; plan: PrunePlan }
  | { type: "pruneFailed"; token: number | null; error: string }
  | { type: "pruneDone"; plan: PrunePlan }
  | { type: "files"; id: string; generation: number; state: FileState };

export type Effect =
  | { type: "quit" }
  | { type: "refresh"; repos?: string[] }
  | { type: "remeasure"; id: string }
  | { type: "prepareRemoval"; token: number; rows: WorktreeRow[] }
  | {
      type: "executeRemoval";
      jobId: number;
      plan: RemovalPlan;
      choices: Record<string, RemovalChoice>;
    }
  | { type: "preparePrune"; token: number; repoPath: string }
  | { type: "executePrune"; plan: PrunePlan };

export interface Context {
  snapshot: DashboardSnapshot;
  now: number;
  /** Rows visible at once, used for page up/down. */
  pageSize: number;
  canAct: boolean;
  /** False when no row is focused, so there is nothing to expand. */
  canExpand: boolean;
}

export interface Result {
  state: UiState;
  effects: Effect[];
}

export function initialState(): UiState {
  return {
    screen: { kind: "projects" },
    projectFocus: null,
    keyPressed: false,
    scanned: false,
    tab: "All",
    search: "",
    searching: false,
    sort: "size",
    descending: true,
    grouped: false,
    focusId: null,
    moved: false,
    expanded: false,
    detailTop: 0,
    help: false,
    selected: new Set(),
    toast: null,
    pending: null,
    token: 0,
    confirm: null,
    jobs: [],
    quitAfterJobs: false,
    pruning: false,
    gone: new Set(),
    goneSince: -1,
    failures: {},
    generation: -1,
    files: {},
    frame: 0,
  };
}

export function tabOf(verdict: Verdict): Exclude<Tab, "All"> {
  return verdict;
}

/** A heading and its rows: one per verdict, or one per repo when grouped. */
export type Section =
  | { kind: "verdict"; verdict: Verdict; rows: WorktreeRow[] }
  | { kind: "repo"; repoName: string; repoPath: string; rows: WorktreeRow[] };

export interface ListView {
  /** Every visible row in screen order, which is also the order focus moves in. */
  rows: WorktreeRow[];
  sections: Section[];
  counts: Record<Tab, number>;
  /** Known size of the Safe rows that match the search. */
  safeKiB: number;
  focus: WorktreeRow | null;
}

export interface Project {
  repoPath: string;
  repoName: string;
  /** Worktrees and branches without a worktree. */
  rows: WorktreeRow[];
  /** Rows that are worktrees; only these have a size. */
  worktrees: number;
  counts: Record<Verdict, number>;
  totalKiB: number;
  safeKiB: number;
  /** Worktrees not measured yet. */
  unsized: number;
  linked: number | null;
  pending: boolean;
  error: string | null;
}

export interface ProjectsView {
  projects: Project[];
  /** "All projects" followed by every project, in the order focus moves through them. */
  entries: Project[];
  empty: number;
  focus: Project | null;
}

function projectPaths(snapshot: DashboardSnapshot): string[] {
  const paths = new Set(snapshot.rows.map((row) => row.repoPath));
  for (const repo of snapshot.repos) if (repo.linked) paths.add(repo.path);
  for (const path of Object.keys(snapshot.errors)) paths.add(path);
  return [...paths];
}

function summarize(
  repoPath: string,
  name: string,
  rows: WorktreeRow[],
  rest: Pick<Project, "linked" | "pending" | "error">,
): Project {
  const counts: Record<Verdict, number> = { Safe: 0, Review: 0, Busy: 0, Broken: 0 };
  let worktrees = 0;
  let totalKiB = 0;
  let safeKiB = 0;
  let unsized = 0;
  for (const row of rows) {
    counts[row.verdict]++;
    if (row.kind === "branch") continue;
    worktrees++;
    if (row.sizeKiB === null) unsized++;
    totalKiB += row.sizeKiB ?? 0;
    if (row.verdict === "Safe") safeKiB += row.sizeKiB ?? 0;
  }
  return { repoPath, repoName: name, rows, worktrees, counts, totalKiB, safeKiB, unsized, ...rest };
}

export function projectsView(state: UiState, snapshot: DashboardSnapshot): ProjectsView {
  const linked = new Map(snapshot.repos.map((repo) => [repo.path, repo.linked]));
  const listed = new Set(snapshot.rows.map((row) => row.repoPath));
  const rows = visibleRows(state, snapshot);
  const projects = projectPaths(snapshot)
    .map((repoPath): Project => {
      const own = rows.filter((row) => row.repoPath === repoPath);
      const error = snapshot.errors[repoPath] ?? null;
      return summarize(repoPath, own[0]?.repoName ?? repoName(repoPath), own, {
        linked: linked.get(repoPath) ?? null,
        pending: !listed.has(repoPath) && !error && snapshot.progress.phase === "scanning",
        error,
      });
    })
    .sort(
      (a, b) =>
        worktreeCount(b) - worktreeCount(a) ||
        a.repoName.localeCompare(b.repoName) ||
        a.repoPath.localeCompare(b.repoPath),
    );
  const shown = new Set(projects.map((project) => project.repoPath));
  const all = summarize(ALL_PROJECTS, "All projects", rows, {
    linked: projects.reduce((sum, project) => sum + worktreeCount(project), 0),
    pending: projects.some((project) => project.pending),
    error: null,
  });
  const entries = projects.length ? [all, ...projects] : [];
  return {
    projects,
    entries,
    empty: snapshot.repos.filter((repo) => !shown.has(repo.path)).length,
    focus:
      entries.find((project) => project.repoPath === state.projectFocus) ?? projects[0] ?? null,
  };
}

export function worktreeCount(project: Project): number {
  return project.pending ? (project.linked ?? 0) : project.worktrees;
}

function soleProject(snapshot: DashboardSnapshot): string | null {
  if (snapshot.repos.length === 1) return snapshot.repos[0]!.path;
  const settled =
    snapshot.progress.phase === "complete" ||
    (snapshot.repos.length > 0 && snapshot.repos.every((repo) => repo.linked !== null));
  const paths = projectPaths(snapshot);
  return settled && paths.length === 1 ? paths[0]! : null;
}

/** Snapshot rows minus those queued, being removed, or already removed. */
export function visibleRows(state: UiState, snapshot: DashboardSnapshot): WorktreeRow[] {
  return snapshot.rows.filter((row) => !state.gone.has(row.id) && !leaving(state, row.id));
}

function leaving(state: UiState, id: string): boolean {
  const status = jobStatus(state, id);
  return status === "waiting" || status === "removing" || status === "removed";
}

/** What the worktree list shows: the open screen, or a preview of the focused project. */
export function listScreen(state: UiState, snapshot: DashboardSnapshot): Screen {
  if (state.screen.kind !== "projects") return state.screen;
  const focus = projectsView(state, snapshot).focus;
  return !focus || focus.repoPath === ALL_PROJECTS
    ? { kind: "all" }
    : { kind: "project", repoPath: focus.repoPath };
}

export function scopedRows(state: UiState, snapshot: DashboardSnapshot): WorktreeRow[] {
  const rows = visibleRows(state, snapshot);
  const screen = listScreen(state, snapshot);
  return screen.kind === "project" ? rows.filter((row) => row.repoPath === screen.repoPath) : rows;
}

export function isGrouped(state: UiState, snapshot: DashboardSnapshot): boolean {
  return state.grouped && listScreen(state, snapshot).kind === "all";
}

export function listView(state: UiState, snapshot: DashboardSnapshot): ListView {
  const matching = selectRows(scopedRows(state, snapshot), {
    search: state.search,
    sort: { key: state.sort, direction: state.descending ? "desc" : "asc" },
  });
  const counts: Record<Tab, number> = {
    All: matching.length,
    Safe: 0,
    Review: 0,
    Busy: 0,
    Broken: 0,
  };
  let safeKiB = 0;
  for (const row of matching) {
    counts[tabOf(row.verdict)]++;
    if (tabOf(row.verdict) === "Safe") safeKiB += row.sizeKiB ?? 0;
  }
  const filtered =
    state.tab === "All" ? matching : matching.filter((row) => tabOf(row.verdict) === state.tab);
  const rank = (row: WorktreeRow) => VERDICTS.indexOf(row.verdict);
  const sections: Section[] = isGrouped(state, snapshot)
    ? groupByRepo(filtered).map((group) => ({
        kind: "repo",
        ...group,
        rows: [...group.rows].sort((a, b) => rank(a) - rank(b)),
      }))
    : VERDICTS.map((verdict): Section => ({
        kind: "verdict",
        verdict,
        rows: filtered.filter((row) => row.verdict === verdict),
      })).filter((section) => section.rows.length);
  const rows = sections.flatMap((section) => section.rows);
  const focus =
    state.screen.kind === "projects"
      ? null
      : (state.moved && rows.find((row) => row.id === state.focusId)) || rows[0] || null;
  return { rows, sections, counts, safeKiB, focus };
}

export function jobStatus(state: UiState, id: string): RunStatus | undefined {
  return state.jobs.find((job) => id in job.status)?.status[id];
}

export function inJob(state: UiState, id: string): boolean {
  return jobStatus(state, id) !== undefined;
}

/** True once the first scan has counted every repo's worktrees. */
export function projectsReady(state: UiState, snapshot: DashboardSnapshot): boolean {
  return state.scanned || snapshot.progress.reposTotal > 0;
}

export function spinning(state: UiState, snapshot: DashboardSnapshot): boolean {
  return (
    snapshot.progress.phase === "scanning" ||
    state.pending !== null ||
    state.jobs.length > 0 ||
    state.pruning
  );
}

const same = (state: UiState): Result => ({ state, effects: [] });
const quit = (state: UiState): Result => ({ state, effects: [{ type: "quit" }] });

function toast(
  state: UiState,
  ctx: Context,
  text: string,
  tone: Tone = "info",
  ms = 4000,
): UiState {
  return { ...state, toast: { text, tone, until: ctx.now + ms } };
}

export function update(state: UiState, event: UiEvent, ctx: Context): Result {
  switch (event.type) {
    case "key":
      return onKey(state, event.key, ctx);
    case "tick": {
      let next = state;
      if (state.toast && ctx.now >= state.toast.until) next = { ...next, toast: null };
      if (spinning(state, ctx.snapshot)) next = { ...next, frame: state.frame + 1 };
      return same(next);
    }
    case "snapshot": {
      let next = state;
      const phase = ctx.snapshot.progress.phase;
      if (!state.scanned && (phase === "complete" || phase === "error"))
        next = { ...next, scanned: true };
      if (ctx.snapshot.generation !== state.generation)
        next = { ...next, generation: ctx.snapshot.generation, files: {} };
      if (ctx.snapshot.progress.phase === "complete") {
        const ids = new Set(ctx.snapshot.rows.map((row) => row.id));
        if ([...state.selected].some((id) => !ids.has(id)))
          next = { ...next, selected: new Set([...state.selected].filter((id) => ids.has(id))) };
        if (state.gone.size && ctx.snapshot.generation > state.goneSince)
          next = { ...next, gone: new Set() };
      }
      if (next.screen.kind === "projects" && !next.keyPressed) {
        const sole = soleProject(ctx.snapshot);
        if (sole) next = openScreen(next, { kind: "project", repoPath: sole });
      }
      return same(next);
    }
    case "files":
      if (event.generation !== state.generation) return same(state);
      return same({ ...state, files: { ...state.files, [event.id]: event.state } });
    case "planReady": {
      if (state.pending?.kind !== "removal" || state.pending.token !== event.token)
        return same(state);
      const ready = event.plan.entries.filter((entry) => !entry.blockedReason);
      const blocked = event.plan.entries.filter((entry) => entry.blockedReason);
      if (!ready.length) {
        const first = blocked[0];
        return same(
          toast(
            { ...state, pending: null },
            ctx,
            first
              ? `Can't remove ${branchLabel(first.row)}: ${first.blockedReason}`
              : "Nothing to remove",
            "warn",
            8000,
          ),
        );
      }
      return same({
        ...state,
        pending: null,
        toast: null,
        help: false,
        confirm: {
          kind: "remove",
          openedAt: ctx.now,
          plan: event.plan,
          ready,
          blocked,
          deleteUnmerged: false,
          reap: true,
        },
      });
    }
    case "planFailed":
      if (state.pending?.token !== event.token) return same(state);
      return same(
        toast(
          { ...state, pending: null },
          ctx,
          `Couldn't check the selection: ${event.error}`,
          "error",
          8000,
        ),
      );
    case "progress": {
      const job = state.jobs.find((item) => event.id in item.status);
      if (!job) return same(state);
      const next = { ...job, status: { ...job.status, [event.id]: event.status } };
      return same({ ...state, jobs: state.jobs.map((item) => (item === job ? next : item)) });
    }
    case "removalDone":
      return finishJob(state, event.jobId, event.result, null, ctx);
    case "removalFailed":
      return finishJob(state, event.jobId, null, event.error, ctx);
    case "pruneReady":
      if (state.pending?.kind !== "prune" || state.pending.token !== event.token)
        return same(state);
      if (!event.plan.records.length) {
        return same(
          toast(
            { ...state, pending: null },
            ctx,
            `Nothing to prune in ${repoName(event.plan.repoPath)}`,
          ),
        );
      }
      return same({
        ...state,
        pending: null,
        toast: null,
        help: false,
        confirm: { kind: "prune", openedAt: ctx.now, plan: event.plan },
      });
    case "pruneFailed":
      if (event.token !== null && state.pending?.token !== event.token) return same(state);
      return same(
        toast(
          { ...state, pending: null, pruning: false },
          ctx,
          `Prune failed: ${event.error}`,
          "error",
          8000,
        ),
      );
    case "pruneDone":
      return {
        state: toast(
          { ...state, pruning: false },
          ctx,
          `Pruned ${countLabel(event.plan.records.length, "record")} in ${repoName(event.plan.repoPath)}`,
          "ok",
        ),
        effects: [{ type: "refresh", repos: [event.plan.repoPath] }],
      };
  }
}

const repoName = (path: string) => path.split("/").at(-1) ?? path;

function finishJob(
  state: UiState,
  jobId: number,
  result: RemovalResult | null,
  error: string | null,
  ctx: Context,
): Result {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return same(state);
  const failures = { ...state.failures };
  const gone = new Set(state.gone);
  const removed: WorktreeRow[] = [];
  let freed = 0;
  const problems: string[] = [];
  for (const item of result?.items ?? []) {
    if (!job.order.includes(item.id)) continue;
    const row = job.plan.entries.find((entry) => entry.row.id === item.id)!.row;
    if (item.status === "removed") {
      removed.push(row);
      freed += row.sizeKiB ?? 0;
      gone.add(item.id);
      delete failures[item.id];
    } else {
      failures[item.id] = item.error ?? item.status;
      problems.push(branchLabel(row));
    }
  }
  if (error) for (const id of job.order) if (!gone.has(id)) failures[id] = error;
  const measured = result?.freedKiB;
  const space =
    measured !== null && measured !== undefined
      ? `freed ${sizeLabel(Math.max(0, measured))}`
      : `up to ${sizeLabel(freed)} freed`;
  let summary: string;
  let tone: Tone;
  if (error) {
    summary = `Removal stopped: ${error}`;
    tone = "error";
  } else if (!problems.length) {
    summary = `Removed ${rowsLabel(removed)} · ${space}`;
    tone = "ok";
  } else {
    summary = `Removed ${removed.length} of ${job.order.length} · ${problems.length === 1 ? problems[0] : `${problems.length} worktrees`} not removed, see details`;
    tone = "warn";
  }
  const repos = [
    ...new Set(
      job.plan.entries
        .filter((entry) => job.order.includes(entry.row.id))
        .map((entry) => entry.row.repoPath),
    ),
  ];
  const effects: Effect[] = [{ type: "refresh", repos }];
  const jobs = state.jobs.filter((item) => item !== job);
  if (!jobs.length && state.quitAfterJobs) effects.push({ type: "quit" });
  const next = { ...state, jobs, gone, goneSince: ctx.snapshot.generation, failures };
  return { state: toast(next, ctx, summary, tone, 10_000), effects };
}

function onKey(state: UiState, key: Key, ctx: Context): Result {
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

function openScreen(state: UiState, screen: Screen): UiState {
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

/** Quitting never interrupts a running `wt remove`; it waits for the current worktree. */
function quitRequest(state: UiState, ctx: Context): Result {
  if (state.pruning) return same(toast(state, ctx, "Still pruning; try again in a moment", "warn"));
  if (state.jobs.length) {
    return same(
      toast(
        { ...stopJobs(state), quitAfterJobs: true },
        ctx,
        "Quitting after the current worktree is removed",
        "warn",
        60_000,
      ),
    );
  }
  return quit(state);
}

function stopJobs(state: UiState): UiState {
  return { ...state, jobs: state.jobs.map((job) => ({ ...job, stopping: true })) };
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

function selectBlock(state: UiState, row: WorktreeRow): string | null {
  if (inJob(state, row.id)) return "it is already being removed";
  const reason = removalBlockReason(row);
  return reason;
}

function toggleSelect(state: UiState, focus: WorktreeRow | null, ctx: Context): UiState {
  if (!ctx.canAct) return toast(state, ctx, "Removal is not available in this session");
  if (!focus) return state;
  const block = selectBlock(state, focus);
  if (block) return toast(state, ctx, `Can't select ${branchLabel(focus)}: ${block}`, "warn", 6000);
  const selected = new Set(state.selected);
  if (selected.has(focus.id)) selected.delete(focus.id);
  else selected.add(focus.id);
  return { ...state, selected };
}

function selectAllSafe(
  state: UiState,
  rows: WorktreeRow[],
  ctx: Context,
  project?: string,
): UiState {
  if (!ctx.canAct) return toast(state, ctx, "Removal is not available in this session");
  const where = project ? ` in ${project}` : "";
  const safe = rows.filter((row) => row.verdict === "Safe" && !selectBlock(state, row));
  if (!safe.length) return toast(state, ctx, `No Safe worktrees${where || " in this view"}`);
  const selected = new Set(state.selected);
  if (safe.every((row) => selected.has(row.id))) {
    for (const row of safe) selected.delete(row.id);
    return toast({ ...state, selected }, ctx, `Cleared ${rowsLabel(safe, "Safe")}${where}`);
  }
  for (const row of safe) selected.add(row.id);
  const kib = safe.reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
  return toast(
    { ...state, selected },
    ctx,
    `Selected ${rowsLabel(safe, "Safe")}${where} · up to ${sizeLabel(kib)}`,
    "ok",
  );
}

/** x removes the selection, or the focused row when nothing is selected. */
function startRemoval(state: UiState, focus: WorktreeRow | null, ctx: Context): Result {
  if (!ctx.canAct) return same(toast(state, ctx, "Removal is not available in this session"));
  if (state.pending) return same(state);
  let rows = ctx.snapshot.rows.filter((row) => state.selected.has(row.id));
  if (!rows.length) {
    if (!focus) return same(state);
    const block = selectBlock(state, focus);
    if (block)
      return same(toast(state, ctx, `Can't remove ${branchLabel(focus)}: ${block}`, "warn", 6000));
    rows = [focus];
  }
  const token = state.token + 1;
  return {
    state: {
      ...state,
      token,
      toast: null,
      pending: {
        kind: "removal",
        token,
        label: `Checking ${rowsLabel(rows)}…`,
      },
    },
    effects: [{ type: "prepareRemoval", token, rows }],
  };
}

function startPrune(state: UiState, focus: WorktreeRow | null, ctx: Context): Result {
  if (!ctx.canAct || !focus) return same(state);
  if (state.pending || state.pruning) return same(state);
  if (state.jobs.length)
    return same(toast(state, ctx, "A removal is still running; prune when it finishes"));
  const token = state.token + 1;
  return {
    state: {
      ...state,
      token,
      toast: null,
      pending: { kind: "prune", token, label: `Checking ${focus.repoName} for missing worktrees…` },
    },
    effects: [{ type: "preparePrune", token, repoPath: focus.repoPath }],
  };
}

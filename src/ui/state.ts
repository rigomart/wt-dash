import type {
  FileReport,
  PrunePlan,
  RemovalChoice,
  RemovalEntry,
  RemovalPlan,
  RemovalResult,
} from "../core/removal/types";
import type { DashboardSnapshot, Verdict, WorktreeRow } from "../core/types";

export type Tab = "All" | "Safe" | "Review" | "Busy" | "Broken" | "Orphaned";
export const TABS: Tab[] = ["All", "Safe", "Review", "Busy", "Broken", "Orphaned"];
/** Sorts rows within each section. */
export type SortKey = "size" | "age" | "repo";
export const SORT_KEYS: SortKey[] = ["size", "age", "repo"];
export const DESCENDING_BY_DEFAULT: Record<SortKey, boolean> = {
  size: true,
  age: true,
  repo: false,
};
export const VERDICTS: Verdict[] = ["Safe", "Review", "Busy", "Broken", "Orphaned"];

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

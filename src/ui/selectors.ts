import { groupByRepo, isSizing, selectRows } from "../core/view";
import { ORPHANS, type DashboardSnapshot, type Verdict, type WorktreeRow } from "../core/types";
import {
  ALL_PROJECTS,
  VERDICTS,
  type RunStatus,
  type Screen,
  type Tab,
  type UiState,
} from "./state";

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
  /** Worktrees, branches without a worktree, and orphans. */
  rows: WorktreeRow[];
  /** Rows with a folder, worktrees and orphans; only these have a size. */
  worktrees: number;
  counts: Record<Verdict, number>;
  totalKiB: number;
  safeKiB: number;
  /** Worktrees whose size is being measured and not known yet. */
  unsized: number;
  linked: number | null;
  pending: boolean;
  error: string | null;
}

export interface ProjectsView {
  /** Every project, then the orphans' pseudo-project, if any orphan is in view. */
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
  snapshot: DashboardSnapshot,
  repoPath: string,
  name: string,
  rows: WorktreeRow[],
  rest: Pick<Project, "linked" | "pending" | "error">,
): Project {
  const counts: Record<Verdict, number> = { Safe: 0, Review: 0, Busy: 0, Broken: 0, Orphaned: 0 };
  let worktrees = 0;
  let totalKiB = 0;
  let safeKiB = 0;
  let unsized = 0;
  for (const row of rows) {
    counts[row.verdict]++;
    if (row.kind === "branch") continue;
    worktrees++;
    if (isSizing(snapshot, row)) unsized++;
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
      return summarize(snapshot, repoPath, own[0]?.repoName ?? repoName(repoPath), own, {
        linked: linked.get(repoPath) ?? null,
        pending: !listed.has(repoPath) && !error && snapshot.progress.phase === "scanning",
        error,
      });
    })
    .sort(
      (a, b) =>
        Number(a.repoPath === ORPHANS) - Number(b.repoPath === ORPHANS) ||
        worktreeCount(b) - worktreeCount(a) ||
        a.repoName.localeCompare(b.repoName) ||
        a.repoPath.localeCompare(b.repoPath),
    );
  const shown = new Set(projects.map((project) => project.repoPath));
  const all = summarize(snapshot, ALL_PROJECTS, "All projects", rows, {
    linked: projects.reduce((sum, project) => sum + worktreeCount(project), 0),
    pending: projects.some((project) => project.pending),
    error: null,
  });
  const entries = projects.length ? [all, ...projects] : [];
  return {
    projects,
    entries,
    empty: snapshot.repos.filter((repo) => repo.path !== ORPHANS && !shown.has(repo.path)).length,
    focus:
      entries.find((project) => project.repoPath === state.projectFocus) ?? projects[0] ?? null,
  };
}

/** Projects that are repositories, leaving out the orphans' pseudo-project. */
export function repoCount(view: ProjectsView): number {
  return view.projects.filter((project) => project.repoPath !== ORPHANS).length;
}

export function worktreeCount(project: Project): number {
  return project.pending ? (project.linked ?? 0) : project.worktrees;
}

/** The one repository to open directly; orphans don't count as a project here. */
export function soleProject(snapshot: DashboardSnapshot): string | null {
  const repos = snapshot.repos.filter((repo) => repo.path !== ORPHANS);
  if (repos.length === 1) return repos[0]!.path;
  const settled =
    snapshot.progress.phase === "complete" ||
    (repos.length > 0 && repos.every((repo) => repo.linked !== null));
  const paths = projectPaths(snapshot).filter((path) => path !== ORPHANS);
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
    Orphaned: 0,
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

export const repoName = (path: string) =>
  path === ORPHANS ? "Orphaned folders" : (path.split("/").at(-1) ?? path);

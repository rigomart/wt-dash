export type Verdict = "Busy" | "Broken" | "Orphaned" | "Review" | "Safe";
export type ToolName = "Claude" | "Codex" | "t3" | "Other";

export interface ChangeFlags {
  staged: boolean;
  modified: boolean;
  untracked: boolean;
  renamed: boolean;
  deleted: boolean;
  conflicted: boolean | null;
}

export interface LineCounts {
  added: number;
  deleted: number;
}

/**
 * A linked worktree, a local branch left behind without one, or an orphan: a folder in an agent's
 * worktree location that no repository knows.
 */
export type RowKind = "worktree" | "branch" | "orphan";

/** The `repoPath` of every orphan row. Real repo paths are absolute, so it cannot collide with one. */
export const ORPHANS = "orphans";

/** Why no repository knows an orphan folder. */
export type OrphanCause =
  /**
   * Its `.git` file names a Git record that no longer exists. `repo` is the repository that held the record,
   * or null when the record's path doesn't say; `repoExists` is whether that repository's folder still exists.
   */
  | { kind: "gitdirMissing"; gitdir: string; repo: string | null; repoExists: boolean }
  /** A Codex `<id>` folder holding only `.codex-worktree-name`, with no worktree inside. */
  | { kind: "emptyShell" };

export interface WorktreeFacts {
  id: string;
  kind: RowKind;
  repoPath: string;
  repoName: string;
  /** The worktree folder; null for a branch without a worktree. */
  path: string | null;
  branch: string | null;
  headSha: string | null;
  committedAt: string | null;
  /**
   * When Git created the worktree, or, for a branch without one, its oldest reflog entry or else when its
   * ref was last written. Null when it could not be read.
   */
  createdAt: string | null;
  /** Worktrunk's marker for the branch, such as an agent plugin's 🤖 or 💬. */
  marker: string | null;
  /** When the marker was set, or null when Worktrunk's state didn't say. */
  markerSetAt: string | null;
  tool: ToolName;
  changes: ChangeFlags | null;
  upstreamAhead: number | null;
  mainState: string | null;
  integrationReason?: string | null;
  lockReason: string | null;
  mainAhead: number | null;
  mainBehind: number | null;
  /** Lines the branch changes since it left the default branch, or null when Worktrunk didn't say. */
  mainDiff: LineCounts | null;
  /** The subject line of the HEAD commit. */
  subject: string | null;
  /** The branch's Git description, from `git branch --edit-description`. */
  description: string | null;
  /** Per-branch notes set with `wt config state vars set`, or null when there are none. */
  vars: Record<string, string> | null;
  defaultBranch: string | null;
  mainBase: string | null;
  locked: boolean;
  prunable: boolean;
  operation: string | null;
  /** Set only on an orphan row. */
  orphan?: OrphanCause;
}

export interface WorktreeRow extends WorktreeFacts {
  sizeKiB: number | null;
  sizeMeasuredAt: string | null;
  verdict: Verdict;
  reason: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal,
  environment?: Record<string, string>,
) => Promise<CommandResult>;

/** Folder mtimes taken just before `du` ran. */
export interface SizeSignature {
  mtimeMs: number;
  nodeModulesMtimeMs: number | null;
}

export interface SizeEntry {
  sizeKiB: number;
  measuredAt: string;
  /** Missing on entries saved before signatures existed; those count as stale. */
  signature?: SizeSignature;
}

export interface SizeService {
  load(): Promise<void>;
  get(path: string): SizeEntry | null;
  measure(path: string): Promise<SizeEntry | null>;
  /** Measures only when the saved size is stale, joining a stale check already running for the path; resolves to null when it is still fresh or the measurement fails. `first` puts it ahead of every measurement still waiting. */
  measureIfStale(path: string, first?: boolean): Promise<SizeEntry | null>;
  close(): Promise<void>;
}

/** A discovered repository, known before Worktrunk lists it. */
export interface RepoInfo {
  path: string;
  /** Linked worktrees Git records for the repo, or null when its records could not be read. */
  linked: number | null;
}

export interface DashboardSnapshot {
  generation: number;
  repos: RepoInfo[];
  rows: WorktreeRow[];
  progress: {
    phase: "idle" | "scanning" | "complete" | "error";
    reposTotal: number;
    reposDone: number;
    startedAt: string | null;
    completedAt: string | null;
  };
  errors: Record<string, string>;
  fatalError: string | null;
  /** Worktree folders whose size is being measured right now. */
  sizing: string[];
}

export interface DashboardService {
  getSnapshot(): DashboardSnapshot;
  subscribe(listener: (snapshot: DashboardSnapshot) => void): () => void;
  /** Rescan every repository, or only `repos` when given. Current rows stay visible until replaced. */
  refresh(repos?: string[]): Promise<void>;
  /** Does nothing for a branch without a worktree, which has no folder to measure. */
  refreshSize(worktreeId: string): Promise<void>;
  close(): Promise<void>;
}

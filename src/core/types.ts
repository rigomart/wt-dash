export type Verdict = "Busy" | "Broken" | "Review" | "Safe";
export type ToolName = "Claude" | "Codex" | "t3" | "Other";

export interface ChangeFlags {
  staged: boolean;
  modified: boolean;
  untracked: boolean;
  renamed: boolean;
  deleted: boolean;
  conflicted: boolean | null;
}

export interface WorktreeFacts {
  id: string;
  repoPath: string;
  repoName: string;
  path: string;
  branch: string | null;
  headSha: string | null;
  committedAt: string | null;
  tool: ToolName;
  changes: ChangeFlags | null;
  upstreamAhead: number | null;
  mainState: string | null;
  integrationReason?: string | null;
  lockReason: string | null;
  mainAhead: number | null;
  defaultBranch: string | null;
  mainBase: string | null;
  locked: boolean;
  prunable: boolean;
  operation: string | null;
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

export interface SizeEntry {
  sizeKiB: number;
  measuredAt: string;
}

export interface SizeService {
  load(): Promise<void>;
  get(path: string): SizeEntry | null;
  measure(path: string): Promise<SizeEntry | null>;
  close(): Promise<void>;
}

export interface DashboardSnapshot {
  generation: number;
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
}

export interface DashboardService {
  getSnapshot(): DashboardSnapshot;
  subscribe(listener: (snapshot: DashboardSnapshot) => void): () => void;
  /** Rescan every repository, or only `repos` when given. Current rows stay visible until replaced. */
  refresh(repos?: string[]): Promise<void>;
  refreshSize(worktreeId: string): Promise<void>;
  close(): Promise<void>;
}

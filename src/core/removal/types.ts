import type { CommandRunner, WorktreeRow } from "../types";

export interface RemovalChoice {
  include: boolean;
  discardChanges?: boolean;
  forceDeleteBranch?: boolean;
  reapProcesses?: boolean;
}
export interface FileReport {
  /** `git status --porcelain` lines for uncommitted and untracked changes. */
  localFiles: string[];
  /** Ignored paths, for information only; Worktrunk removes them without `-f`. */
  ignoredFiles: string[];
  disposableIgnored: number;
}
export interface RemovalEntry extends FileReport {
  row: WorktreeRow;
  blockedReason: string | null;
  requiresDiscard: boolean;
  branchWillBeRetained: boolean;
}
export interface RemovalPlan {
  entries: RemovalEntry[];
}
export interface RemovalResult {
  items: Array<{
    id: string;
    status: "removed" | "failed" | "skipped" | "unverified";
    branchOutcome?: string;
    error?: string;
  }>;
  freedKiB: number | null;
  warnings: string[];
}
export interface PrunePlan {
  repoPath: string;
  records: string[];
}
export type RemovalProgress = (
  id: string,
  status: "removing" | "removed" | "failed" | "skipped" | "unverified",
) => void;
export interface ActionService {
  inspectFiles(row: WorktreeRow): Promise<FileReport>;
  prepareRemoval(rows: WorktreeRow[]): Promise<RemovalPlan>;
  /** Batches confirmed while another is running wait for it, then run in order. */
  executeRemoval(
    plan: RemovalPlan,
    choices: Record<string, RemovalChoice>,
    onProgress?: RemovalProgress,
    shouldStop?: () => boolean,
  ): Promise<RemovalResult>;
  preparePrune(repoPath: string): Promise<PrunePlan>;
  executePrune(plan: PrunePlan): Promise<void>;
}
export interface ActionOptions {
  wtPath: string;
  runner: CommandRunner;
  logPath: string;
  readCreated?: (worktree: string) => Promise<string | null>;
  readBranchCreated?: (repo: string, branch: string) => Promise<string | null>;
}

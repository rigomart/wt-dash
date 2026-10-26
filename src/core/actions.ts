import { assess } from "./assess";
import { readComparisonBase } from "./base";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseWorktrunk } from "./worktrunk";
import type { CommandRunner, WorktreeRow } from "./types";

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
export interface RemovalPlan { entries: RemovalEntry[] }
export interface RemovalResult {
  items: Array<{ id: string; status: "removed" | "failed" | "skipped" | "unverified"; branchOutcome?: string; error?: string }>;
  freedKiB: number | null;
  warnings: string[];
}
export interface PrunePlan { repoPath: string; records: string[] }
export type RemovalProgress = (id: string, status: "removing" | "removed" | "failed" | "skipped" | "unverified") => void;
export interface ActionService {
  inspectFiles(row: WorktreeRow): Promise<FileReport>;
  prepareRemoval(rows: WorktreeRow[]): Promise<RemovalPlan>;
  /** Batches confirmed while another is running wait for it, then run in order. */
  executeRemoval(plan: RemovalPlan, choices: Record<string, RemovalChoice>,
    onProgress?: RemovalProgress, shouldStop?: () => boolean): Promise<RemovalResult>;
  preparePrune(repoPath: string): Promise<PrunePlan>;
  executePrune(plan: PrunePlan): Promise<void>;
}

function stamp(row: WorktreeRow): string {
  return JSON.stringify([row.id, row.repoPath, row.path, row.branch, row.headSha, row.changes,
    row.upstreamAhead, row.mainState, row.mainAhead, row.defaultBranch, row.integrationReason, row.locked, row.lockReason, row.operation, row.prunable]);
}
export function removalBlockReason(row: WorktreeRow): string | null {
  return assess(row).removalBlockReason;
}
const disposablePath = /(^|\/)(node_modules|\.next|\.turbo|\.vite|\.cache|dist|build|target|coverage)\/?$|(^|\/)\.DS_Store$|\.tsbuildinfo$/;

function statusFiles(stdout: string): FileReport {
  const report: FileReport = { localFiles: [], ignoredFiles: [], disposableIgnored: 0 };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (!line.startsWith("!! ")) report.localFiles.push(line);
    else if (disposablePath.test(line.slice(3))) report.disposableIgnored++;
    else report.ignoredFiles.push(line.slice(3));
  }
  return report;
}
// Only changes Git tracks or sees as untracked decide whether a preview is still valid;
// ignored files churn with every build and never need confirmation.
function filesStamp(entry: RemovalEntry): string {
  return JSON.stringify(entry.localFiles);
}
function failure(name: string, result: { exitCode: number; stderr: string }): Error {
  return new Error(`${name} exited ${result.exitCode}: ${result.stderr.trim() || "no error details"}`);
}
function availableKiB(stdout: string): number | null {
  const line = stdout.trim().split("\n")[1];
  if (!line) return null;
  const value = Number(line.trim().split(/\s+/)[3]);
  return Number.isFinite(value) ? value : null;
}

export function createActionService(options: {
  wtPath: string;
  runner: CommandRunner;
  logPath: string;
}): ActionService {
  let removalPlan: RemovalPlan | null = null;
  let prunePlan: PrunePlan | null = null;
  let pruning = false;
  let queue: Promise<unknown> = Promise.resolve();
  let removals = 0;

  async function readFiles(row: WorktreeRow): Promise<FileReport> {
    const status = await options.runner("git", ["-C", row.path, "status", "--porcelain=v1", "--ignored", "--untracked-files=normal"]);
    if (status.exitCode !== 0) throw new Error(`Could not inspect local files: ${status.stderr.trim() || "git status failed"}`);
    return statusFiles(status.stdout);
  }
  async function checkRow(row: WorktreeRow): Promise<RemovalEntry> {
    const listing = await options.runner(options.wtPath, ["-C", row.repoPath, "--config-set", "list.json-schema=2", "list", "--format=json"]);
    if (listing.exitCode !== 0) throw failure("wt list", listing);
    let fresh = parseWorktrunk(row.repoPath, listing.stdout).find((item) => item.path === row.path);
    if (fresh) {
      const base = await readComparisonBase(row.repoPath, fresh.defaultBranch, options.runner);
      fresh = { ...fresh, mainBase: base };
    }
    const blockedReason = !fresh ? "it is missing or is the main worktree"
      : stamp(fresh) !== stamp(row) ? "it changed; refresh and preview again" : null;
    const entry: RemovalEntry = { row: fresh ?? row, blockedReason, localFiles: [], ignoredFiles: [],
      disposableIgnored: 0, requiresDiscard: false,
      branchWillBeRetained: row.branch !== null && !["empty", "integrated", "same_commit"].includes(row.mainState ?? "") };
    if (blockedReason) return entry;
    const assessment = assess(fresh!);
    entry.row = { ...fresh!, verdict: assessment.verdict, reason: assessment.reason };
    entry.blockedReason = assessment.removalBlockReason;
    if (entry.blockedReason) return entry;
    try { Object.assign(entry, await readFiles(fresh!)); }
    catch (error) {
      entry.blockedReason = error instanceof Error ? error.message : String(error);
      return entry;
    }
    const changes = fresh!.changes;
    entry.requiresDiscard = entry.localFiles.length > 0 ||
      !!changes && (changes.staged || changes.modified || changes.untracked || changes.renamed || changes.deleted);
    return entry;
  }
  async function diskSpace(): Promise<number | null> {
    try {
      const result = await options.runner("df", ["-k", "/System/Volumes/Data"]);
      return result.exitCode === 0 ? availableKiB(result.stdout) : null;
    } catch { return null; }
  }
  async function log(value: object) {
    await mkdir(dirname(options.logPath), { recursive: true });
    await appendFile(options.logPath, JSON.stringify(value) + "\n");
  }
  async function dryPrune(repoPath: string): Promise<string[]> {
    const result = await options.runner("git", ["-C", repoPath, "worktree", "prune", "--dry-run", "--expire=now", "--verbose"]);
    if (result.exitCode !== 0) throw failure("git worktree prune", result);
    return (result.stdout + "\n" + result.stderr).split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async function removeBatch(plan: RemovalPlan, choices: Record<string, RemovalChoice>,
    onProgress?: RemovalProgress, shouldStop?: () => boolean): Promise<RemovalResult> {
    const items: RemovalResult["items"] = [];
    const warnings: string[] = [];
    const succeededRepos = new Set<string>();
    const before = await diskSpace();
    for (const entry of plan.entries) {
      const { row } = entry;
      const choice = choices[row.id];
      const skip = (error: string) => {
        items.push({ id: row.id, status: "skipped", error });
        onProgress?.(row.id, "skipped");
      };
      if (shouldStop?.()) { skip("Cancelled"); continue; }
      if (entry.blockedReason || !choice?.include) { skip(entry.blockedReason ?? "Not confirmed"); continue; }
      if (entry.requiresDiscard && !choice.discardChanges) { skip("Discarding local files was not confirmed"); continue; }
      if (choice.forceDeleteBranch && !entry.branchWillBeRetained) { skip("Forced branch deletion does not apply"); continue; }
      let current: RemovalEntry;
      try { current = await checkRow(row); }
      catch (error) { skip(String(error)); continue; }
      if (current.blockedReason || filesStamp(current) !== filesStamp(entry)) {
        skip(current.blockedReason ?? "Local files changed since preview");
        continue;
      }
      const flags = [choice.discardChanges && entry.requiresDiscard ? "-f" : null,
        choice.forceDeleteBranch ? "-D" : null,
        choice.reapProcesses ? "--reap" : null].filter((flag): flag is string => flag !== null);
      onProgress?.(row.id, "removing");
      let exitCode = -1;
      let branchOutcome: string | undefined;
      let error: string | undefined;
      try {
        const result = await options.runner(options.wtPath,
          ["-C", row.repoPath, "remove", "-y", "--no-hooks", "--foreground", "--format=json", ...flags, row.path]);
        exitCode = result.exitCode;
        if (result.exitCode !== 0) throw failure("wt remove", result);
        const parsed = JSON.parse(result.stdout.trim()) as unknown;
        const values = Array.isArray(parsed) ? parsed : [parsed];
        const value = values.find((item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && item.kind === "worktree" && item.path === row.path);
        if (!value || typeof value.branch_outcome !== "string") {
          throw new Error("Unexpected Worktrunk removal result");
        }
        branchOutcome = value.branch_outcome;
        items.push({ id: row.id, status: "removed", branchOutcome });
        succeededRepos.add(row.repoPath);
        onProgress?.(row.id, "removed");
      } catch (cause) {
        error = String(cause);
        const status = exitCode === 0 ? "unverified" : "failed";
        items.push({ id: row.id, status, error });
        onProgress?.(row.id, status);
        if (status === "unverified") {
          warnings.push(`Removal outcome for ${row.path} could not be verified; check the refreshed list`);
          succeededRepos.add(row.repoPath);
        }
      }
      try {
        await log({ timestamp: new Date().toISOString(), repo: row.repoPath, branch: row.branch,
          path: row.path, flags, exitCode, branchOutcome: branchOutcome ?? null, error: error ?? null });
      } catch (cause) { warnings.push(`Could not write removal log for ${row.path}: ${String(cause)}`); }
    }
    for (const repo of succeededRepos) {
      try {
        const result = await options.runner("git", ["-C", repo, "worktree", "prune"]);
        if (result.exitCode !== 0) warnings.push(`Could not prune ${repo}: ${result.stderr.trim()}`);
      } catch (error) { warnings.push(`Could not prune ${repo}: ${String(error)}`); }
    }
    const after = await diskSpace();
    return { items, freedKiB: before === null || after === null ? null : after - before, warnings };
  }

  return {
    inspectFiles: readFiles,
    async prepareRemoval(rows) {
      if (pruning) throw new Error("Cleanup is running");
      if (!rows.length) throw new Error("Select at least one worktree");
      const entries: RemovalEntry[] = [];
      for (const row of rows) {
        try { entries.push(await checkRow(row)); }
        catch (error) {
          entries.push({ row, blockedReason: String(error), localFiles: [], ignoredFiles: [],
            disposableIgnored: 0, requiresDiscard: false, branchWillBeRetained: false });
        }
      }
      removalPlan = { entries };
      return removalPlan;
    },
    async executeRemoval(plan, choices, onProgress, shouldStop) {
      if (pruning) throw new Error("Cleanup is running");
      if (plan !== removalPlan) throw new Error("Removal preview is stale");
      removalPlan = null;
      removals++;
      const run = queue.then(() => removeBatch(plan, choices, onProgress, shouldStop));
      queue = run.catch(() => {});
      try { return await run; } finally { removals--; }
    },
    async preparePrune(repoPath) {
      if (pruning || removals) throw new Error("Cleanup is running");
      prunePlan = { repoPath, records: await dryPrune(repoPath) };
      return prunePlan;
    },
    async executePrune(plan) {
      if (pruning || removals) throw new Error("Cleanup is running");
      if (plan !== prunePlan) throw new Error("Prune preview is stale");
      pruning = true;
      prunePlan = null;
      try {
        const current = await dryPrune(plan.repoPath);
        if (JSON.stringify(current) !== JSON.stringify(plan.records)) throw new Error("Prunable records changed; preview again");
        if (!current.length) return;
        const result = await options.runner("git", ["-C", plan.repoPath, "worktree", "prune", "--expire=now", "--verbose"]);
        if (result.exitCode !== 0) throw failure("git worktree prune", result);
      } finally { pruning = false; }
    },
  };
}

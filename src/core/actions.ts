import { assess, recentAgentMark } from "./assess";
import { appendFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { enrichRows, listArgs, readMarks } from "./listing";
import { parseWorktrunk } from "./worktrunk";
import type { CommandRunner, WorktreeFacts, WorktreeRow } from "./types";

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

function stamp(row: WorktreeRow): string {
  const agentActive = recentAgentMark(row) !== null;
  return JSON.stringify([
    row.id,
    row.repoPath,
    row.path,
    row.branch,
    row.headSha,
    row.createdAt,
    row.changes,
    row.upstreamAhead,
    row.mainState,
    row.mainAhead,
    row.defaultBranch,
    row.integrationReason,
    row.locked,
    row.lockReason,
    row.operation,
    row.prunable,
    agentActive,
  ]);
}
type WorktreeState = Pick<
  WorktreeFacts,
  "headSha" | "branch" | "locked" | "lockReason" | "prunable" | "operation"
> & { path: string };
function stateStamp(state: Omit<WorktreeState, "path">): string {
  return JSON.stringify([
    state.headSha,
    state.branch,
    state.locked,
    state.lockReason,
    state.prunable,
    state.operation,
  ]);
}
/** Branch names have no refs/heads/ prefix, as Worktrunk reports them. */
function parseWorktreeList(stdout: string): Array<Omit<WorktreeState, "operation">> {
  const worktrees: Array<Omit<WorktreeState, "operation">> = [];
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? null : line.slice(space + 1);
    if (key === "worktree" && value)
      worktrees.push({
        path: value,
        headSha: null,
        branch: null,
        locked: false,
        lockReason: null,
        prunable: false,
      });
    const current = worktrees.at(-1);
    if (!current) continue;
    if (key === "HEAD") current.headSha = value;
    else if (key === "branch") current.branch = value?.replace(/^refs\/heads\//, "") ?? null;
    else if (key === "locked") {
      current.locked = true;
      current.lockReason = value;
    } else if (key === "prunable") current.prunable = true;
  }
  return worktrees;
}
/** Operation names match Worktrunk's. */
const operationMarkers = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry_pick"],
  ["REVERT_HEAD", "revert"],
  // A multi-commit cherry-pick or revert can stop with only sequencer/ left, without
  // CHERRY_PICK_HEAD or REVERT_HEAD; its todo names which one.
  ["sequencer", "cherry_pick"],
  ["BISECT_LOG", "bisect"],
] as const;
async function sequencerOperation(directory: string): Promise<string> {
  const todo = await readFile(join(directory, "todo"), "utf8").catch(() => "");
  const command = todo
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"))
    ?.split(/\s+/)[0];
  return command === "revert" || command === "r" ? "revert" : "cherry_pick";
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** readComparisonBase compares against the default branch or its upstream, so both are read. */
function verdictRefs(row: WorktreeRow): string[] {
  const refs = row.defaultBranch
    ? [`refs/heads/${row.defaultBranch}`, `${row.defaultBranch}@{upstream}`]
    : [];
  if (row.branch) refs.push(`${row.branch}@{upstream}`);
  return refs;
}
interface RepoSnapshot {
  listing: WorktreeRow[];
  tips: Map<string, string | null>;
}
export function removalBlockReason(row: WorktreeRow): string | null {
  return assess(row).removalBlockReason;
}
const disposablePath =
  /(^|\/)(node_modules|\.next|\.turbo|\.vite|\.cache|dist|build|target|coverage)\/?$|(^|\/)\.DS_Store$|\.tsbuildinfo$/;

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
function filesStamp(files: FileReport): string {
  return JSON.stringify(files.localFiles);
}
function failure(name: string, result: { exitCode: number; stderr: string }): Error {
  return new Error(
    `${name} exited ${result.exitCode}: ${result.stderr.trim() || "no error details"}`,
  );
}
/** macOS keeps user data on the APFS data volume, not the root volume. */
const dataVolume = process.platform === "darwin" ? "/System/Volumes/Data" : homedir();
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
  readCreated?: (worktree: string) => Promise<string | null>;
  readBranchCreated?: (repo: string, branch: string) => Promise<string | null>;
}): ActionService {
  let removalPlan: RemovalPlan | null = null;
  let prunePlan: PrunePlan | null = null;
  let pruning = false;
  let queue: Promise<unknown> = Promise.resolve();
  let removals = 0;

  async function readFiles(row: WorktreeRow): Promise<FileReport> {
    if (row.path === null) throw new Error("A branch without a worktree has no files");
    const status = await options.runner("git", [
      "-C",
      row.path,
      "status",
      "--porcelain=v1",
      "--ignored",
      "--untracked-files=normal",
    ]);
    if (status.exitCode !== 0)
      throw new Error(
        `Could not inspect local files: ${status.stderr.trim() || "git status failed"}`,
      );
    return statusFiles(status.stdout);
  }
  async function listRepo(repoPath: string, wanted: WorktreeRow[]): Promise<WorktreeRow[]> {
    const listing = await options.runner(options.wtPath, listArgs(repoPath));
    if (listing.exitCode !== 0) throw failure("wt list", listing);
    const rows = parseWorktrunk(repoPath, listing.stdout);
    if (!rows.some((item) => wanted.some((row) => row.id === item.id))) return rows;
    return enrichRows(repoPath, rows, options.runner, {
      readCreated: options.readCreated,
      readBranchCreated: options.readBranchCreated,
    });
  }
  function matchListing(row: WorktreeRow, listing: WorktreeRow[]): RemovalEntry {
    const fresh = listing.find((item) => item.id === row.id);
    const blockedReason = !fresh
      ? row.kind === "branch"
        ? "it is missing or now has a worktree"
        : "it is missing or is the main worktree"
      : stamp(fresh) !== stamp(row)
        ? "it changed; refresh and preview again"
        : null;
    const entry: RemovalEntry = {
      row: fresh ?? row,
      blockedReason,
      localFiles: [],
      ignoredFiles: [],
      disposableIgnored: 0,
      requiresDiscard: false,
      branchWillBeRetained:
        row.branch !== null &&
        !["empty", "integrated", "same_commit"].includes(row.mainState ?? ""),
    };
    if (blockedReason) return entry;
    const assessment = assess(fresh!);
    entry.row = { ...fresh!, verdict: assessment.verdict, reason: assessment.reason };
    entry.blockedReason = assessment.removalBlockReason;
    return entry;
  }
  async function checkAgainst(row: WorktreeRow, listing: WorktreeRow[]): Promise<RemovalEntry> {
    const entry = matchListing(row, listing);
    if (entry.blockedReason || entry.row.kind === "branch") return entry;
    try {
      Object.assign(entry, await readFiles(entry.row));
    } catch (error) {
      entry.blockedReason = error instanceof Error ? error.message : String(error);
      return entry;
    }
    const changes = entry.row.changes;
    entry.requiresDiscard =
      entry.localFiles.length > 0 ||
      (!!changes &&
        (changes.staged ||
          changes.modified ||
          changes.untracked ||
          changes.renamed ||
          changes.deleted));
    return entry;
  }
  async function diskSpace(): Promise<number | null> {
    try {
      const result = await options.runner("df", ["-k", dataVolume]);
      return result.exitCode === 0 ? availableKiB(result.stdout) : null;
    } catch {
      return null;
    }
  }
  async function log(value: object) {
    await mkdir(dirname(options.logPath), { recursive: true });
    await appendFile(options.logPath, JSON.stringify(value) + "\n");
  }
  async function dryPrune(repoPath: string): Promise<string[]> {
    const result = await options.runner("git", [
      "-C",
      repoPath,
      "worktree",
      "prune",
      "--dry-run",
      "--expire=now",
      "--verbose",
    ]);
    if (result.exitCode !== 0) throw failure("git worktree prune", result);
    return (result.stdout + "\n" + result.stderr)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** `rev-parse --verify -q` exits 1 with no output for a missing ref. */
  async function readTip(repoPath: string, ref: string): Promise<string | null> {
    const result = await options.runner("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      "-q",
      ref,
    ]);
    if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim()) return null;
    if (result.exitCode !== 0) throw failure("git rev-parse", result);
    return result.stdout.trim();
  }
  async function readTips(repoPath: string, refs: string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(refs)];
    const tips = await Promise.all(unique.map((ref) => readTip(repoPath, ref)));
    return new Map(unique.map((ref, index) => [ref, tips[index]!]));
  }
  async function snapshotRepo(repoPath: string, rows: WorktreeRow[]): Promise<RepoSnapshot> {
    // Tips first: a ref that moves while the listing runs then shows up as moved later.
    const tips = await readTips(repoPath, rows.flatMap(verdictRefs));
    const listing = await listRepo(repoPath, rows);
    return { listing, tips };
  }
  async function readOperation(path: string): Promise<string | null> {
    const result = await options.runner("git", [
      "-C",
      path,
      "rev-parse",
      ...operationMarkers.flatMap(([marker]) => ["--git-path", marker]),
    ]);
    if (result.exitCode !== 0) throw failure("git rev-parse", result);
    const markerPaths = result.stdout.split("\n").filter(Boolean);
    if (markerPaths.length !== operationMarkers.length)
      throw new Error("git rev-parse did not report the Git operation markers");
    for (const [index, [marker, operation]] of operationMarkers.entries()) {
      const markerPath = resolve(path, markerPaths[index]!);
      if (!(await exists(markerPath))) continue;
      return marker === "sequencer" ? sequencerOperation(markerPath) : operation;
    }
    return null;
  }
  async function listWorktrees(repoPath: string): Promise<ReturnType<typeof parseWorktreeList>> {
    const list = await options.runner("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
    if (list.exitCode !== 0) throw failure("git worktree list", list);
    return parseWorktreeList(list.stdout);
  }
  /** Merge, upstream and integration state are not read here; removeBatch re-lists when a ref they depend on moves. */
  async function recheckWorktree(
    entry: RemovalEntry,
    confirmed: WorktreeRow,
  ): Promise<string | null> {
    // Git lists the main worktree first.
    const state = (await listWorktrees(entry.row.repoPath))
      .slice(1)
      .find((item) => item.path === entry.row.path);
    if (!state) return "it is missing or is the main worktree";
    const fresh: WorktreeRow = {
      ...confirmed,
      ...state,
      operation: state.prunable ? null : await readOperation(state.path),
    };
    const blocked = assess(fresh).removalBlockReason;
    if (blocked) return blocked;
    if (stateStamp(fresh) !== stateStamp(entry.row)) return "it changed; refresh and preview again";
    let files: FileReport;
    try {
      files = await readFiles(fresh);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return filesStamp(files) !== filesStamp(entry) ? "Local files changed since preview" : null;
  }
  async function recheckMark(row: WorktreeRow): Promise<string | null> {
    if (!row.branch || recentAgentMark(row)) return null;
    const mark = (await readMarks(row.repoPath, options.runner)).get(row.branch);
    if (!mark) return null;
    return recentAgentMark({ ...row, marker: mark.marker, markerSetAt: mark.setAt })
      ? "an agent started work here; refresh and preview again"
      : null;
  }
  async function recheckBranch(row: WorktreeRow): Promise<string | null> {
    const branch = row.branch!;
    const worktrees = await listWorktrees(row.repoPath);
    if (worktrees.some((item) => item.branch === branch))
      return "it is missing or now has a worktree";
    // `wt remove <name>` removes the worktree whose folder is <name>, if there is one, before it looks for a branch.
    const asPath = resolve(row.repoPath, branch);
    const real = (path: string) => realpath(path).catch(() => path);
    const named = new Set([asPath, await real(asPath)]);
    for (const item of worktrees) {
      if (named.has(item.path) || named.has(await real(item.path)))
        return "a worktree folder has the same name, so Worktrunk would remove that instead; delete it with git branch";
    }
    const tip = await readTip(row.repoPath, `refs/heads/${branch}`);
    if (tip === null) return "it is missing or now has a worktree";
    return tip !== row.headSha ? "it changed; refresh and preview again" : null;
  }

  async function removeBatch(
    plan: RemovalPlan,
    choices: Record<string, RemovalChoice>,
    onProgress?: RemovalProgress,
    shouldStop?: () => boolean,
  ): Promise<RemovalResult> {
    const items: RemovalResult["items"] = [];
    const entryWarnings: string[][] = plan.entries.map(() => []);
    const pruneWarnings: string[] = [];
    const succeededRepos = new Set<string>();
    const before = await diskSpace();
    const repos = [...new Set(plan.entries.map((entry) => entry.row.repoPath))];
    for (const repo of repos) {
      const indexes = plan.entries.flatMap((entry, index) =>
        entry.row.repoPath === repo ? [index] : [],
      );
      const repoRows = indexes.map((index) => plan.entries[index]!.row);
      let snapshot: Promise<RepoSnapshot> | undefined;
      for (const index of indexes) {
        const entry = plan.entries[index]!;
        const { row } = entry;
        const choice = choices[row.id];
        const warnings = entryWarnings[index]!;
        const skip = (error: string) => {
          items[index] = { id: row.id, status: "skipped", error };
          onProgress?.(row.id, "skipped");
        };
        if (shouldStop?.()) {
          skip("Cancelled");
          continue;
        }
        if (entry.blockedReason || !choice?.include) {
          skip(entry.blockedReason ?? "Not confirmed");
          continue;
        }
        if (entry.requiresDiscard && !choice.discardChanges) {
          skip("Discarding local files was not confirmed");
          continue;
        }
        if (choice.forceDeleteBranch && !entry.branchWillBeRetained) {
          skip("Forced branch deletion does not apply");
          continue;
        }
        // Removing an unmerged branch without a worktree does nothing unless it is force-deleted.
        if (row.kind === "branch" && entry.branchWillBeRetained && !choice.forceDeleteBranch) {
          skip("Deleting the unmerged branch was not confirmed");
          continue;
        }
        let blockedReason: string | null;
        try {
          snapshot ??= snapshotRepo(repo, repoRows);
          let repoState = await snapshot;
          const refs = verdictRefs(row);
          const tips = await readTips(repo, refs);
          if (refs.some((ref) => tips.get(ref) !== repoState.tips.get(ref))) {
            repoState = await snapshotRepo(repo, repoRows);
            snapshot = Promise.resolve(repoState);
          }
          const current = matchListing(row, repoState.listing);
          blockedReason =
            current.blockedReason ??
            (await recheckMark(row)) ??
            (row.kind === "branch"
              ? await recheckBranch(row)
              : await recheckWorktree(entry, current.row));
        } catch (error) {
          skip(String(error));
          continue;
        }
        if (blockedReason) {
          skip(blockedReason);
          continue;
        }
        const flags = [
          choice.discardChanges && entry.requiresDiscard ? "-f" : null,
          choice.forceDeleteBranch ? "-D" : null,
          choice.reapProcesses && row.kind === "worktree" ? "--reap" : null,
        ].filter((flag): flag is string => flag !== null);
        const target = row.path ?? row.branch!;
        const label = row.path ?? `branch ${row.branch}`;
        onProgress?.(row.id, "removing");
        let exitCode = -1;
        let branchOutcome: string | undefined;
        let pruned: boolean | undefined;
        let error: string | undefined;
        try {
          const result = await options.runner(options.wtPath, [
            "-C",
            row.repoPath,
            "remove",
            "-y",
            "--no-hooks",
            "--foreground",
            "--format=json",
            ...flags,
            target,
          ]);
          exitCode = result.exitCode;
          if (result.exitCode !== 0) throw failure("wt remove", result);
          const parsed = JSON.parse(result.stdout.trim()) as unknown;
          const values = Array.isArray(parsed) ? parsed : [parsed];
          const value = values.find(
            (item): item is Record<string, unknown> =>
              typeof item === "object" &&
              item !== null &&
              (row.kind === "branch"
                ? item.kind === "branch_only" && item.branch === row.branch
                : item.kind === "worktree" && item.path === row.path),
          );
          if (!value || typeof value.branch_outcome !== "string") {
            throw new Error("Unexpected Worktrunk removal result");
          }
          branchOutcome = value.branch_outcome;
          if (typeof value.pruned === "boolean") pruned = value.pruned;
          if (row.kind === "branch" && branchOutcome !== "deleted") {
            error = `Worktrunk kept the branch (${branchOutcome.replaceAll("_", " ")})`;
            items[index] = { id: row.id, status: "failed", branchOutcome, error };
            onProgress?.(row.id, "failed");
          } else {
            items[index] = { id: row.id, status: "removed", branchOutcome };
            if (row.kind === "worktree") succeededRepos.add(row.repoPath);
            onProgress?.(row.id, "removed");
          }
        } catch (cause) {
          error = String(cause);
          const status = exitCode === 0 ? "unverified" : "failed";
          items[index] = { id: row.id, status, error };
          onProgress?.(row.id, status);
          if (status === "unverified") {
            warnings.push(
              `Removal outcome for ${label} could not be verified; check the refreshed list`,
            );
            if (row.kind === "worktree") succeededRepos.add(row.repoPath);
          }
        }
        try {
          await log({
            timestamp: new Date().toISOString(),
            repo: row.repoPath,
            branch: row.branch,
            path: row.path,
            flags,
            exitCode,
            branchOutcome: branchOutcome ?? null,
            ...(pruned === undefined ? {} : { pruned }),
            error: error ?? null,
          });
        } catch (cause) {
          warnings.push(`Could not write removal log for ${label}: ${String(cause)}`);
        }
      }
    }
    for (const repo of succeededRepos) {
      try {
        const result = await options.runner("git", ["-C", repo, "worktree", "prune"]);
        if (result.exitCode !== 0)
          pruneWarnings.push(`Could not prune ${repo}: ${result.stderr.trim()}`);
      } catch (error) {
        pruneWarnings.push(`Could not prune ${repo}: ${String(error)}`);
      }
    }
    const after = await diskSpace();
    return {
      items,
      freedKiB: before === null || after === null ? null : after - before,
      warnings: [...entryWarnings.flat(), ...pruneWarnings],
    };
  }

  return {
    inspectFiles: readFiles,
    async prepareRemoval(rows) {
      if (pruning) throw new Error("Cleanup is running");
      if (!rows.length) throw new Error("Select at least one worktree");
      const entries: RemovalEntry[] = [];
      const repos = [...new Set(rows.map((row) => row.repoPath))];
      let nextRepo = 0;
      async function worker(): Promise<void> {
        while (nextRepo < repos.length) {
          const repo = repos[nextRepo++]!;
          const indexes = rows.flatMap((row, index) => (row.repoPath === repo ? [index] : []));
          const listing = listRepo(
            repo,
            indexes.map((index) => rows[index]!),
          );
          for (const index of indexes) {
            const row = rows[index]!;
            try {
              entries[index] = await checkAgainst(row, await listing);
            } catch (error) {
              entries[index] = {
                row,
                blockedReason: String(error),
                localFiles: [],
                ignoredFiles: [],
                disposableIgnored: 0,
                requiresDiscard: false,
                branchWillBeRetained: false,
              };
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, repos.length) }, () => worker()));
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
      try {
        return await run;
      } finally {
        removals--;
      }
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
        if (JSON.stringify(current) !== JSON.stringify(plan.records))
          throw new Error("Prunable records changed; preview again");
        if (!current.length) return;
        const result = await options.runner("git", [
          "-C",
          plan.repoPath,
          "worktree",
          "prune",
          "--expire=now",
          "--verbose",
        ]);
        if (result.exitCode !== 0) throw failure("git worktree prune", result);
      } finally {
        pruning = false;
      }
    },
  };
}

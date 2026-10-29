import { assess, recentAgentMark } from "../assess";
import { readFiles } from "../git/status";
import type { WorktreeState } from "../git/worktrees";
import { failure } from "../process";
import { enrichRows } from "../scan/enrich";
import type { CommandRunner, WorktreeRow } from "../types";
import { listArgs, parseWorktrunk } from "../worktrunk/list";
import type { ActionOptions, FileReport, RemovalEntry, RemovalPlan } from "./types";

export function stamp(row: WorktreeRow): string {
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
export function stateStamp(state: Omit<WorktreeState, "path">): string {
  return JSON.stringify([
    state.headSha,
    state.branch,
    state.locked,
    state.lockReason,
    state.prunable,
    state.operation,
  ]);
}
/** readComparisonBase compares against the default branch or its upstream, so both are read. */
export function verdictRefs(row: WorktreeRow): string[] {
  const refs = row.defaultBranch
    ? [`refs/heads/${row.defaultBranch}`, `${row.defaultBranch}@{upstream}`]
    : [];
  if (row.branch) refs.push(`${row.branch}@{upstream}`);
  return refs;
}
// Only changes Git tracks or sees as untracked decide whether a preview is still valid;
// ignored files churn with every build and never need confirmation.
export function filesStamp(files: FileReport): string {
  return JSON.stringify(files.localFiles);
}

export async function listRepo(
  repoPath: string,
  wanted: WorktreeRow[],
  options: Omit<ActionOptions, "logPath">,
): Promise<WorktreeRow[]> {
  const listing = await options.runner(options.wtPath, listArgs(repoPath));
  if (listing.exitCode !== 0) throw failure("wt list", listing);
  const rows = parseWorktrunk(repoPath, listing.stdout);
  if (!rows.some((item) => wanted.some((row) => row.id === item.id))) return rows;
  return enrichRows(repoPath, rows, options.runner, {
    readCreated: options.readCreated,
    readBranchCreated: options.readBranchCreated,
  });
}
export function matchListing(row: WorktreeRow, listing: WorktreeRow[]): RemovalEntry {
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
      row.branch !== null && !["empty", "integrated", "same_commit"].includes(row.mainState ?? ""),
  };
  if (blockedReason) return entry;
  const assessment = assess(fresh!);
  entry.row = {
    ...fresh!,
    sizeKiB: row.sizeKiB,
    sizeMeasuredAt: row.sizeMeasuredAt,
    verdict: assessment.verdict,
    reason: assessment.reason,
  };
  entry.blockedReason = assessment.removalBlockReason;
  return entry;
}
export async function checkAgainst(
  row: WorktreeRow,
  listing: WorktreeRow[],
  runner: CommandRunner,
): Promise<RemovalEntry> {
  const entry = matchListing(row, listing);
  if (entry.blockedReason || entry.row.kind === "branch") return entry;
  try {
    Object.assign(entry, await readFiles(entry.row, runner));
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

export async function planRemoval(
  rows: WorktreeRow[],
  options: Omit<ActionOptions, "logPath">,
): Promise<RemovalPlan> {
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
        options,
      );
      for (const index of indexes) {
        const row = rows[index]!;
        try {
          entries[index] = await checkAgainst(row, await listing, options.runner);
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
  return { entries };
}

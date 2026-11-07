import { assessRow, recentAgentMark, removalBlockReason } from "../assess";
import { readFiles } from "../git/status";
import type { WorktreeState } from "../git/worktrees";
import { failure } from "../process";
import { enrichRows } from "../scan/enrich";
import type { CommandRunner, WorktreeRow } from "../types";
import { listArgs, parseWorktrunk } from "../worktrunk/list";
import { planOrphan } from "./orphan";
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
export function stateStamp(
  state: Omit<WorktreeState, "path"> & Pick<WorktreeRow, "createdAt">,
): string {
  return JSON.stringify([
    state.headSha,
    state.createdAt,
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
/** The states in which assess lets a merged pull request stand in for Worktrunk's merge check. */
const forgeStates = ["ahead", "would_conflict", "diverged", "behind"];

/** The pull request GitHub says merged the row's tip, or null when no proof holds for its current tip. */
function provenBy(row: WorktreeRow): { pr: number } | null {
  const forge = row.forge;
  return forge?.kind === "proven" &&
    forge.tip === row.headSha &&
    forgeStates.includes(row.mainState ?? "")
    ? { pr: forge.pr }
    : null;
}

export function matchListing(row: WorktreeRow, listing: WorktreeRow[]): RemovalEntry {
  const listed = listing.find((item) => item.id === row.id);
  // `wt list` knows nothing of GitHub, so the confirmed row's answer carries over while the tip is the same.
  const fresh =
    listed && row.forge && listed.headSha === row.headSha
      ? { ...listed, forge: row.forge }
      : listed;
  // Worktrunk deletes a branch whenever an integration check matched, but a dirty worktree
  // shows that match as "behind" or "diverged" rather than "integrated".
  const unmerged =
    row.branch !== null &&
    !row.integrationReason &&
    !["empty", "integrated", "same_commit"].includes(row.mainState ?? "");
  const proof = unmerged ? provenBy(row) : null;
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
    branchWillBeRetained: unmerged && !proof,
    ...(proof ? { branchProof: proof } : {}),
  };
  if (blockedReason) return entry;
  entry.row = assessRow({ ...fresh!, sizeKiB: row.sizeKiB, sizeMeasuredAt: row.sizeMeasuredAt });
  entry.blockedReason = removalBlockReason(entry.row);
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
  const orphans = rows.map(async (row, index) => {
    if (row.kind === "orphan") entries[index] = await planOrphan(row);
  });
  const repos = [
    ...new Set(rows.filter((row) => row.kind !== "orphan").map((row) => row.repoPath)),
  ];
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
  await Promise.all([
    ...orphans,
    ...Array.from({ length: Math.min(4, repos.length) }, () => worker()),
  ]);
  return { entries };
}

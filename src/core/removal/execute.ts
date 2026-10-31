import { homedir } from "node:os";
import { readTips } from "../git/refs";
import { prune } from "../git/worktrees";
import { failure } from "../process";
import type { CommandRunner, WorktreeRow } from "../types";
import { parseRemoval, runRemove } from "../worktrunk/remove";
import { appendLog } from "./log";
import { deleteOrphan, recheckOrphan } from "./orphan";
import { listRepo, matchListing, verdictRefs } from "./plan";
import { recheckBranch, recheckMark, recheckWorktree } from "./recheck";
import type {
  ActionOptions,
  RemovalChoice,
  RemovalEntry,
  RemovalPlan,
  RemovalProgress,
  RemovalResult,
} from "./types";

/** macOS keeps user data on the APFS data volume, not the root volume. */
const dataVolume = process.platform === "darwin" ? "/System/Volumes/Data" : homedir();
function availableKiB(stdout: string): number | null {
  const line = stdout.trim().split("\n")[1];
  if (!line) return null;
  const value = Number(line.trim().split(/\s+/)[3]);
  return Number.isFinite(value) ? value : null;
}

async function diskSpace(runner: CommandRunner): Promise<number | null> {
  try {
    const result = await runner("df", ["-k", dataVolume]);
    return result.exitCode === 0 ? availableKiB(result.stdout) : null;
  } catch {
    return null;
  }
}

interface RepoSnapshot {
  listing: WorktreeRow[];
  tips: Map<string, string | null>;
}

async function snapshotRepo(
  repoPath: string,
  rows: WorktreeRow[],
  options: Omit<ActionOptions, "logPath">,
): Promise<RepoSnapshot> {
  // Tips first: a ref that moves while the listing runs then shows up as moved later.
  const tips = await readTips(repoPath, rows.flatMap(verdictRefs), options.runner);
  const listing = await listRepo(repoPath, rows, options);
  return { listing, tips };
}

function confirmationSkipReason(entry: RemovalEntry, choice?: RemovalChoice): string | null {
  if (entry.blockedReason || !choice?.include) return entry.blockedReason ?? "Not confirmed";
  if (entry.requiresDiscard && !choice.discardChanges)
    return "Discarding local files was not confirmed";
  if (choice.forceDeleteBranch && !entry.branchWillBeRetained)
    return "Forced branch deletion does not apply";
  if (entry.row.kind === "branch" && entry.branchWillBeRetained && !choice.forceDeleteBranch)
    return "Deleting the unmerged branch was not confirmed";
  return null;
}

export async function removeBatch(
  plan: RemovalPlan,
  choices: Record<string, RemovalChoice>,
  options: ActionOptions,
  onProgress?: RemovalProgress,
  shouldStop?: () => boolean,
): Promise<RemovalResult> {
  const items: RemovalResult["items"] = [];
  const entryWarnings: string[][] = plan.entries.map(() => []);
  const pruneWarnings: string[] = [];
  const succeededRepos = new Set<string>();
  const before = await diskSpace(options.runner);
  async function log(index: number, label: string, value: object): Promise<void> {
    try {
      await appendLog(options.logPath, value);
    } catch (cause) {
      entryWarnings[index]!.push(`Could not write removal log for ${label}: ${String(cause)}`);
    }
  }
  async function removeOrphan(index: number): Promise<void> {
    const { row, folderId } = plan.entries[index]!;
    const blockedReason = await recheckOrphan(row, folderId);
    if (blockedReason) {
      items[index] = { id: row.id, status: "skipped", error: blockedReason };
      onProgress?.(row.id, "skipped");
      return;
    }
    onProgress?.(row.id, "removing");
    let error: string | null = null;
    try {
      await deleteOrphan(row.path!, row.orphan!);
      items[index] = { id: row.id, status: "removed" };
      onProgress?.(row.id, "removed");
    } catch (cause) {
      error = String(cause);
      items[index] = { id: row.id, status: "failed", error };
      onProgress?.(row.id, "failed");
    }
    await log(index, row.path!, {
      timestamp: new Date().toISOString(),
      repo: row.orphan?.kind === "gitdirMissing" ? row.orphan.repo : null,
      branch: null,
      path: row.path,
      flags: [],
      exitCode: null,
      branchOutcome: null,
      orphan: true,
      error,
    });
  }
  const repos = [...new Set(plan.entries.map((entry) => entry.row.repoPath))];
  for (const repo of repos) {
    const indexes = plan.entries.flatMap((entry, index) =>
      entry.row.repoPath === repo ? [index] : [],
    );
    const repoRows = indexes.flatMap((index) => {
      const entry = plan.entries[index]!;
      return confirmationSkipReason(entry, choices[entry.row.id]) === null ? [entry.row] : [];
    });
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
      const unconfirmed = confirmationSkipReason(entry, choice);
      if (unconfirmed !== null) {
        skip(unconfirmed);
        continue;
      }
      if (row.kind === "orphan") {
        await removeOrphan(index);
        continue;
      }
      let blockedReason: string | null;
      try {
        snapshot ??= snapshotRepo(repo, repoRows, options);
        let repoState = await snapshot;
        const refs = verdictRefs(row);
        const tips = await readTips(repo, refs, options.runner);
        if (refs.some((ref) => tips.get(ref) !== repoState.tips.get(ref))) {
          repoState = await snapshotRepo(repo, repoRows, options);
          snapshot = Promise.resolve(repoState);
        }
        const current = matchListing(row, repoState.listing);
        blockedReason =
          current.blockedReason ??
          (await recheckMark(row, options.runner)) ??
          (row.kind === "branch"
            ? await recheckBranch(row, options.runner)
            : await recheckWorktree(entry, current.row, options.runner, options.readCreated));
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
      const label = row.path ?? `branch ${row.branch}`;
      onProgress?.(row.id, "removing");
      let exitCode = -1;
      let branchOutcome: string | undefined;
      let pruned: boolean | undefined;
      let error: string | undefined;
      try {
        const result = await runRemove(options.wtPath, row, flags, options.runner);
        exitCode = result.exitCode;
        if (result.exitCode !== 0) throw failure("wt remove", result);
        ({ branchOutcome, pruned } = parseRemoval(row, result.stdout));
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
      await log(index, label, {
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
    }
  }
  for (const repo of succeededRepos) {
    try {
      const result = await prune(repo, options.runner);
      if (result.exitCode !== 0)
        pruneWarnings.push(`Could not prune ${repo}: ${result.stderr.trim()}`);
    } catch (error) {
      pruneWarnings.push(`Could not prune ${repo}: ${String(error)}`);
    }
  }
  const after = await diskSpace(options.runner);
  return {
    items,
    freedKiB: before === null || after === null ? null : after - before,
    warnings: [...entryWarnings.flat(), ...pruneWarnings],
  };
}

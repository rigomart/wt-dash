import type { Verdict, WorktreeFacts } from "./types";

export interface Assessment {
  /** A few words for the STATUS column. */
  status: string;
  verdict: Verdict;
  /** One sentence with the specifics behind the status. */
  reason: string;
  /** A short clause that completes "Can't remove x: …", or null when removal is allowed. */
  removalBlockReason: string | null;
}

const integrationDetails: Record<string, (base: string) => string> = {
  ancestor: (base) => `Its commits are already in ${base}.`,
  no_added_changes: (base) => `It adds no file changes to ${base}.`,
  trees_match: (base) => `Its files match ${base} exactly.`,
  merge_adds_nothing: (base) => `Merging it into ${base} would change nothing.`,
  patch_id_match: (base) => `Its changes are in ${base} (squash or rebase merge).`,
};

/** "3 commits aren't", "1 commit isn't", or "Some commits aren't" when Git gave no count. */
function commitsArent(count: number | null): string {
  if (count === null) return "Some commits aren't";
  return count === 1 ? "1 commit isn't" : `${count} commits aren't`;
}

/** One authority for Git status, verdict, explanation, and removal eligibility. */
export function assess(facts: WorktreeFacts): Assessment {
  const result = (status: string, verdict: Verdict, reason: string, block: string | null = null): Assessment =>
    ({ status, verdict, reason, removalBlockReason: block });
  const unknown = (reason: string) => result("status unknown", "Review", reason, "its Git status is unknown; press r to rescan");

  if (!facts.path.startsWith("/") || !facts.repoPath.startsWith("/")) {
    return unknown("The worktree path isn't absolute, so Git can't check it.");
  }
  if (facts.operation) {
    const operation = facts.operation.replaceAll("_", "-");
    return result(`${operation} in progress`, "Busy", `A ${operation} was started here and isn't finished.`,
      `finish or abort the ${operation} first`);
  }
  if (facts.changes?.conflicted) {
    return result("unresolved conflicts", "Busy", "Some files still have merge conflicts.", "resolve the conflicts first");
  }
  if (facts.prunable) {
    return result("folder missing", "Broken", "The folder is gone, but Git still lists the worktree.",
      "the folder is gone; prune it instead");
  }
  if (facts.locked) {
    return facts.lockReason
      ? result("locked", "Review", `Locked: ${facts.lockReason}`, `it's locked (${facts.lockReason}); unlock it first`)
      : result("locked", "Review", "Locked, with no reason given.", "it's locked; unlock it first");
  }
  const changes = facts.changes;
  if (!changes || changes.conflicted === null) {
    return unknown("Git couldn't read its files.");
  }
  const base = facts.mainBase ?? facts.defaultBranch ?? "the default branch";
  const state = facts.mainState;
  if (!state || !["integrated", "empty", "same_commit", "ahead", "would_conflict", "diverged", "behind", "orphan"].includes(state)) {
    return unknown(`Couldn't compare it with ${base}.`);
  }
  if (changes.staged || changes.modified || changes.untracked || changes.renamed || changes.deleted) {
    return result("uncommitted changes", "Review", "Removing it deletes work that isn't committed.");
  }
  if (facts.upstreamAhead !== null && facts.upstreamAhead > 0) {
    return result("unpushed commits", "Review", `${commitsArent(facts.upstreamAhead)} pushed.`);
  }
  switch (state) {
    case "integrated": {
      if (facts.integrationReason === "same_commit") return result("no new commits", "Safe", `Same commit as ${base}.`);
      const detail = facts.integrationReason ? integrationDetails[facts.integrationReason] : undefined;
      return result("merged", "Safe", detail ? detail(base) : `Its content is already in ${base}.`);
    }
    case "same_commit":
      return result("no new commits", "Safe", `Same commit as ${base}.`);
    case "empty":
      return result("no new commits", "Safe", `No commits beyond ${base}.`);
    case "ahead":
      return result("unmerged commits", "Review", `${commitsArent(facts.mainAhead)} in ${base}.`);
    case "would_conflict":
      return result("unmerged commits", "Review", `${commitsArent(facts.mainAhead)} in ${base}, and merging would conflict.`);
    case "diverged":
      return result("unmerged commits", "Review", `${commitsArent(facts.mainAhead)} in ${base}, which has also moved on.`);
    case "behind":
      return result("behind main", "Review", `${base} has moved ahead, and Worktrunk didn't confirm this branch is in it.`);
    case "orphan":
      return result("unrelated history", "Review", `It shares no history with ${base}.`);
    default:
      return unknown(`Couldn't compare it with ${base}.`);
  }
}

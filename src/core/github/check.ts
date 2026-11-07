import { readTrees } from "../git/refs";
import type { FollowUp } from "../scan/dashboard";
import type { CommandRunner, ForgeCheck, WorktreeFacts, WorktreeRow } from "../types";
import type { ProofCache } from "./cache";
import { GH_TIMEOUT_MS, runGraphql, type GhOutcome } from "./gh";
import {
  chainedRequest,
  chunk,
  lookupRequest,
  readChained,
  readLookup,
  type GraphqlRequest,
  type LookupRow,
} from "./query";
import { readGitHubRepo, type GitHubRepo } from "./remote";

export interface GitHubOptions {
  /** Never ask GitHub; rows it could settle say so. */
  offline: boolean;
  /** The user's `gh`, or null when it wasn't found. */
  ghPath: string | null;
}

/** States in which Worktrunk couldn't show the branch's work is in the default branch. */
const UNPROVEN = new Set(["ahead", "would_conflict", "diverged", "behind"]);

/**
 * Whether GitHub may settle the row: a clean worktree or a branch, with every commit pushed, whose work
 * Worktrunk couldn't find in the default branch, and nothing else keeping it out of Safe.
 */
export function canAskGitHub(row: WorktreeFacts): boolean {
  if (row.kind !== "worktree" && row.kind !== "branch") return false;
  if (!row.headSha || !/^[0-9a-f]{40}$/.test(row.headSha)) return false;
  if (!row.mainState || !UNPROVEN.has(row.mainState)) return false;
  if (row.operation || row.locked || row.prunable) return false;
  if (row.upstreamAhead !== null && row.upstreamAhead > 0) return false;
  const changes = row.changes;
  if (row.kind === "worktree" && changes?.conflicted !== false) return false;
  return !(
    changes &&
    (changes.staged ||
      changes.modified ||
      changes.untracked ||
      changes.renamed ||
      changes.deleted ||
      changes.conflicted)
  );
}

type Unchecked = Extract<ForgeCheck, { kind: "unchecked" }>;
/** Merged pull requests from one branch into the default branch. */
type MergedInto = NonNullable<ReturnType<typeof readChained>[number]>;
const unchecked = (why: Unchecked["why"]): Unchecked => ({ kind: "unchecked", why });

/**
 * The dashboard follow-up that asks GitHub, through the user's `gh`, whether a merged pull request holds each
 * eligible row's tip. Every other row gets no forge check; aborting reports nothing.
 */
export function createGitHubCheck(options: {
  github: GitHubOptions;
  runner: CommandRunner;
  proofs: ProofCache;
  timeoutMs?: number;
}): FollowUp {
  const { github, runner, proofs, timeoutMs = GH_TIMEOUT_MS } = options;

  async function check(
    repo: string,
    rows: WorktreeRow[],
    signal: AbortSignal,
  ): Promise<Map<string, ForgeCheck>> {
    const forges = new Map<string, ForgeCheck>();
    const remote = await readGitHubRepo(repo, rows[0]!.defaultBranch, runner, signal);
    if (!remote) {
      for (const row of rows) forges.set(row.id, unchecked("no-github-remote"));
      return forges;
    }
    const uncached = rows.filter((row) => {
      const proof = proofs.get(remote, row.headSha!);
      if (proof) forges.set(row.id, proof);
      return !proof;
    });
    if (!uncached.length) return forges;
    if (github.offline || github.ghPath === null) {
      const why = unchecked(github.offline ? "offline" : "gh-missing");
      for (const row of uncached) forges.set(row.id, why);
      return forges;
    }
    const found = await lookUp(repo, remote, uncached, github.ghPath, signal);
    proofs.add(
      remote,
      [...found.values()].flatMap((forge) => (forge.kind === "proven" ? [forge] : [])),
    );
    for (const [id, forge] of found) forges.set(id, forge);
    return forges;
  }

  /** Sends each request in turn; once gh is missing or signed out, the rest get the same answer unsent. */
  function sender(ghPath: string, signal: AbortSignal) {
    let stop: GhOutcome | null = null;
    return async (request: GraphqlRequest): Promise<GhOutcome> => {
      if (stop) return stop;
      const outcome = await runGraphql(ghPath, request, runner, signal, timeoutMs);
      if (outcome.kind === "unchecked" && outcome.why !== "failed") stop = outcome;
      return outcome;
    };
  }

  async function lookUp(
    repo: string,
    remote: GitHubRepo,
    rows: WorktreeRow[],
    ghPath: string,
    signal: AbortSignal,
  ): Promise<Map<string, ForgeCheck>> {
    const send = sender(ghPath, signal);
    const trees = await readTrees(
      repo,
      rows.map((row) => row.headSha!),
      runner,
      signal,
    );
    const found = new Map<string, ForgeCheck>();
    /** Rows a merged pull request took into another branch than the default, and those branches. */
    const stacked: Array<{ row: WorktreeRow; bases: string[] }> = [];
    let defaultBranch: string | null = null;
    for (const part of chunk(rows)) {
      const asked: LookupRow[] = part.map((row) => ({
        tip: row.headSha!,
        tree: trees.get(row.headSha!) ?? null,
        heads: [
          ...new Set([row.branch, row.upstreamBranch].filter((name): name is string => !!name)),
        ],
      }));
      const { request, heads } = lookupRequest(remote, asked);
      const reply = await send(request);
      if (reply.kind === "unchecked") {
        for (const row of part) found.set(row.id, reply);
        continue;
      }
      const read = readLookup(remote, asked, heads, reply);
      defaultBranch ??= read.defaultBranch;
      read.answers.forEach((answer, index) => {
        const row = part[index]!;
        if (answer.kind === "proven") found.set(row.id, answer.proof);
        else if (answer.kind === "failed") found.set(row.id, unchecked("failed"));
        else {
          found.set(row.id, {
            kind: "not-found",
            tip: row.headSha!,
            ...(answer.samePr ? { samePr: answer.samePr } : {}),
          });
          if (answer.bases.length) stacked.push({ row, bases: answer.bases });
        }
      });
    }
    if (!stacked.length || !defaultBranch) return found;

    // Stacked pull requests: was a branch the tip went into merged into the default branch with the tip in it?
    const merges = new Map<string, MergedInto | Unchecked>();
    for (const bases of chunk([...new Set(stacked.flatMap(({ bases }) => bases))])) {
      const reply = await send(chainedRequest(remote, defaultBranch, bases));
      const lists = reply.kind === "unchecked" ? bases.map(() => reply) : readChained(bases, reply);
      lists.forEach((list, index) => merges.set(bases[index]!, list ?? unchecked("failed")));
    }
    for (const { row, bases } of stacked) {
      const answers = bases.map((base) => merges.get(base)!);
      const pr = answers
        .flatMap((answer) => (Array.isArray(answer) ? answer : []))
        .find(({ commits }) => commits.includes(row.headSha!));
      const failure = answers.find((answer): answer is Unchecked => !Array.isArray(answer));
      if (pr)
        found.set(row.id, {
          kind: "proven",
          tip: row.headSha!,
          pr: pr.number,
          mergedAt: pr.mergedAt,
          base: defaultBranch,
          by: "stacked",
        });
      else if (failure) found.set(row.id, failure);
    }
    return found;
  }

  return async (repo, rows, signal) => {
    const asked = rows.filter(canAskGitHub);
    const forges = asked.length ? await check(repo, asked, signal) : new Map<string, ForgeCheck>();
    return rows.flatMap((row) =>
      row.headSha === null
        ? []
        : [{ id: row.id, headSha: row.headSha, facts: { forge: forges.get(row.id) } }],
    );
  };
}

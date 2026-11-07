import type { ForgeProof } from "../types";
import type { GitHubRepo } from "./remote";

/** Rows asked about in one request, which keeps it far below GitHub's limit of 500,000 nodes. */
export const ROWS_PER_REQUEST = 100;

export interface GraphqlRequest {
  query: string;
  /** Every value is sent as a string with `-f`. */
  variables: Record<string, string>;
}

/** What GitHub returned for `repository`, and where its errors were. */
export interface GraphqlReply {
  /** `data.repository`; null when GitHub couldn't resolve the repository. */
  repository: unknown;
  /** Each error's `path`, or null for an error without one. */
  errorPaths: Array<unknown[] | null>;
}

/** A row to ask about: its tip, the tip's tree when Git could read it, and the branch names it was pushed as. */
export interface LookupRow {
  tip: string;
  tree: string | null;
  heads: string[];
}

export type LookupAnswer =
  | { kind: "proven"; proof: ForgeProof }
  | {
      kind: "not-found";
      samePr?: { number: number; mergedAt: string };
      /** Branches other than the default that a merged pull request brought the tip into. */
      bases: string[];
    }
  | { kind: "failed" };

export function chunk<T>(items: T[], size = ROWS_PER_REQUEST): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    chunks.push(items.slice(start, start + size));
  return chunks;
}

const MERGED_FROM = "states:MERGED, first:5, orderBy:{field:CREATED_AT,direction:DESC}";

/**
 * One query for up to `ROWS_PER_REQUEST` rows: `aN` asks which pull requests hold row N's tip, and `bN` lists
 * the merged pull requests from `heads[N]`, a branch name some row was pushed as.
 */
export function lookupRequest(
  repo: GitHubRepo,
  rows: LookupRow[],
): { request: GraphqlRequest; heads: string[] } {
  const heads = [...new Set(rows.flatMap((row) => row.heads))];
  const variables: Record<string, string> = { owner: repo.owner, name: repo.name };
  rows.forEach((row, index) => (variables[`oid${index}`] = row.tip));
  heads.forEach((head, index) => (variables[`head${index}`] = head));
  const declared = [
    "$owner:String!",
    "$name:String!",
    ...rows.map((_, index) => `$oid${index}:GitObjectID!`),
    ...heads.map((_, index) => `$head${index}:String!`),
  ];
  const fields = [
    ...rows.map(
      (_, index) =>
        `a${index}: object(oid:$oid${index}) { ... on Commit { associatedPullRequests(first:5) { nodes { number state mergedAt baseRefName headRefName headRefOid repository { nameWithOwner defaultBranchRef { name } } } } } }`,
    ),
    ...heads.map(
      (_, index) =>
        `b${index}: pullRequests(headRefName:$head${index}, ${MERGED_FROM}) { nodes { number mergedAt baseRefName headRefOid headRepository { nameWithOwner } commits(last:250) { nodes { commit { oid tree { oid } } } } } }`,
    ),
  ];
  const query = `query(${declared.join(",")}) {
  rateLimit { cost remaining }
  repository(owner:$owner, name:$name) {
    defaultBranchRef { name }
${fields.map((field) => `    ${field}`).join("\n")}
  }
}`;
  return { request: { query, variables }, heads };
}

/** The follow-up query for stacked pull requests: `kN` lists merged pull requests from `bases[N]` into `defaultBranch`. */
export function chainedRequest(
  repo: GitHubRepo,
  defaultBranch: string,
  bases: string[],
): GraphqlRequest {
  const variables: Record<string, string> = {
    owner: repo.owner,
    name: repo.name,
    default: defaultBranch,
  };
  bases.forEach((base, index) => (variables[`base${index}`] = base));
  const declared = [
    "$owner:String!",
    "$name:String!",
    "$default:String!",
    ...bases.map((_, index) => `$base${index}:String!`),
  ];
  const fields = bases.map(
    (_, index) =>
      `k${index}: pullRequests(headRefName:$base${index}, baseRefName:$default, ${MERGED_FROM}) { nodes { number mergedAt commits(last:250) { nodes { commit { oid } } } } }`,
  );
  const query = `query(${declared.join(",")}) {
  rateLimit { cost remaining }
  repository(owner:$owner, name:$name) {
${fields.map((field) => `    ${field}`).join("\n")}
  }
}`;
  return { query, variables };
}

// ---- Reading replies. GitHub's JSON is checked field by field; anything malformed counts as absent.

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const nodes = (connection: unknown): Json[] => {
  const list = object(connection)?.nodes;
  return Array.isArray(list) ? list.map(object).filter((node): node is Json => node !== null) : [];
};

interface MergedPr {
  number: number;
  mergedAt: string;
}

/** The pull request's number and merge time, or null when GitHub gave either malformed. */
function merged(node: Json): MergedPr | null {
  const number = node.number;
  const mergedAt = text(node.mergedAt);
  return Number.isSafeInteger(number) && (number as number) > 0 && mergedAt
    ? { number: number as number, mergedAt }
    : null;
}

const sameRepo = (nameWithOwner: unknown, repo: GitHubRepo) =>
  text(nameWithOwner)?.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase();

const commitOids = (node: Json, field: "oid" | "tree"): string[] =>
  nodes(node.commits).flatMap((entry) => {
    const commit = object(entry.commit);
    const oid = field === "oid" ? text(commit?.oid) : text(object(commit?.tree)?.oid);
    return oid ?? [];
  });

/**
 * The aliases under `repository` that GitHub reported errors for, or "all" when an error names the repository
 * itself or no field at all.
 */
function failedAliases(reply: GraphqlReply): Set<string> | "all" {
  const failed = new Set<string>();
  for (const path of reply.errorPaths) {
    if (!path || path.length === 0) return "all";
    if (path[0] !== "repository") continue;
    if (path.length === 1 || typeof path[1] !== "string") return "all";
    failed.add(path[1]);
  }
  return object(reply.repository) ? failed : "all";
}

/** Each row's answer, given the reply to `lookupRequest(repo, rows)` and its `heads`. */
export function readLookup(
  repo: GitHubRepo,
  rows: LookupRow[],
  heads: string[],
  reply: GraphqlReply,
): { defaultBranch: string | null; answers: LookupAnswer[] } {
  const failed = failedAliases(reply);
  if (failed === "all")
    return { defaultBranch: null, answers: rows.map(() => ({ kind: "failed" })) };
  const repository = object(reply.repository)!;
  const defaultBranch = text(object(repository.defaultBranchRef)?.name);
  const answers = rows.map((row, index): LookupAnswer => {
    const prove = (pr: MergedPr, base: string, by: ForgeProof["by"]): LookupAnswer => ({
      kind: "proven",
      proof: { kind: "proven", tip: row.tip, pr: pr.number, mergedAt: pr.mergedAt, base, by },
    });
    // Proof A: GitHub lists a merged pull request of this repository holding the exact tip.
    const bases = new Set<string>();
    for (const node of nodes(object(repository[`a${index}`])?.associatedPullRequests)) {
      const pr = merged(node);
      const target = object(node.repository);
      const base = text(node.baseRefName);
      if (!pr || node.state !== "MERGED" || !base || !sameRepo(target?.nameWithOwner, repo))
        continue;
      if (base === text(object(target?.defaultBranchRef)?.name)) return prove(pr, base, "commit");
      bases.add(base);
    }
    // Proof B: a pull request from the branch, merged into the default branch, has a commit with the tip's files.
    const aliases = [`a${index}`, ...row.heads.map((head) => `b${heads.indexOf(head)}`)];
    let samePr: MergedPr | undefined;
    for (const alias of aliases.slice(1)) {
      for (const node of nodes(repository[alias])) {
        const pr = merged(node);
        if (
          !pr ||
          !defaultBranch ||
          text(node.baseRefName) !== defaultBranch ||
          !sameRepo(object(node.headRepository)?.nameWithOwner, repo)
        )
          continue;
        if (row.tree && commitOids(node, "tree").includes(row.tree))
          return prove(pr, defaultBranch, "tree");
        if (!samePr || Date.parse(pr.mergedAt) > Date.parse(samePr.mergedAt)) samePr = pr;
      }
    }
    if (aliases.some((alias) => failed.has(alias))) return { kind: "failed" };
    return { kind: "not-found", ...(samePr ? { samePr } : {}), bases: [...bases] };
  });
  return { defaultBranch, answers };
}

/**
 * For each base in `chainedRequest`'s order, the merged pull requests from it into the default branch with their
 * commits, or null when GitHub reported an error for it.
 */
export function readChained(
  bases: string[],
  reply: GraphqlReply,
): Array<Array<MergedPr & { commits: string[] }> | null> {
  const failed = failedAliases(reply);
  if (failed === "all") return bases.map(() => null);
  const repository = object(reply.repository)!;
  return bases.map((_, index) =>
    failed.has(`k${index}`)
      ? null
      : nodes(repository[`k${index}`]).flatMap((node) => {
          const pr = merged(node);
          return pr ? [{ ...pr, commits: commitOids(node, "oid") }] : [];
        }),
  );
}

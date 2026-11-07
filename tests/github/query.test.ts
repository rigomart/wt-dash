import { expect, test } from "bun:test";
import { ghArgs } from "../../src/core/github/gh";
import {
  chainedRequest,
  chunk,
  lookupRequest,
  readChained,
  readLookup,
  ROWS_PER_REQUEST,
  type GraphqlReply,
  type LookupRow,
} from "../../src/core/github/query";
import { answerGh, type GhPullRequest, type GhState } from "../support/gh";

const repo = { owner: "acme", name: "app" };
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map(sha) as [
  string,
  string,
  string,
  string,
  string,
];
const tree = (seed: string) => sha(`f${seed}`);

const pr = (overrides: Partial<GhPullRequest> & Pick<GhPullRequest, "number">): GhPullRequest => ({
  mergedAt: `2026-01-0${overrides.number}T00:00:00Z`,
  base: "main",
  headRefName: "feature/x",
  headRefOid: A,
  commits: [{ oid: A, tree: tree("1") }],
  ...overrides,
});

const state = (pullRequests: GhPullRequest[]): GhState => ({
  mode: "ok",
  repos: [{ owner: "acme", name: "app", defaultBranch: "main", pullRequests }],
});

/** Sends the request to the fake GitHub and returns what wt-dash reads from its stdout. */
function send(model: GhState, request: Parameters<typeof ghArgs>[0]): GraphqlReply {
  const result = answerGh(model, ghArgs(request));
  expect(result.stderr).not.toContain("fake gh:");
  const body = JSON.parse(result.stdout) as {
    data?: { repository: unknown };
    errors?: Array<{ path?: unknown[] }>;
  };
  return {
    repository: body.data?.repository ?? null,
    errorPaths: (body.errors ?? []).map((error) => error.path ?? null),
  };
}

const row = (tip: string, heads: string[] = [], treeOid: string | null = null): LookupRow => ({
  tip,
  tree: treeOid,
  heads,
});

test("chunks hold at most 100 rows", () => {
  expect(ROWS_PER_REQUEST).toBe(100);
  const items = Array.from({ length: 250 }, (_, index) => index);
  expect(chunk(items).map((part) => part.length)).toEqual([100, 100, 50]);
  expect(chunk(items).flat()).toEqual(items);
  expect(chunk([])).toEqual([]);
});

test("the lookup passes every value as a variable, one per tip and one per distinct branch name", () => {
  const { request, heads } = lookupRequest(repo, [
    row(A, ["feature/x"]),
    row(B, ["feature/y", "feature/x"]),
    row(C),
  ]);
  expect(heads).toEqual(["feature/x", "feature/y"]);
  expect(request.variables).toEqual({
    owner: "acme",
    name: "app",
    oid0: A,
    oid1: B,
    oid2: C,
    head0: "feature/x",
    head1: "feature/y",
  });
  expect(request.query).toStartWith(
    "query($owner:String!,$name:String!,$oid0:GitObjectID!,$oid1:GitObjectID!,$oid2:GitObjectID!,$head0:String!,$head1:String!) {",
  );
  // No value is ever spliced into the query text.
  for (const value of [A, B, C, "feature/x", "acme"]) expect(request.query).not.toContain(value);
  expect(ghArgs(request)).toEqual([
    "api",
    "graphql",
    "-f",
    `query=${request.query}`,
    ...Object.entries(request.variables).flatMap(([key, value]) => ["-f", `${key}=${value}`]),
  ]);
});

test("proof A: a merged pull request into the default branch holding the exact tip", () => {
  const model = state([
    pr({
      number: 1,
      commits: [
        { oid: A, tree: tree("1") },
        { oid: B, tree: tree("2") },
      ],
    }),
  ]);
  const rows = [row(A, ["feature/x"]), row(B, ["feature/x"])];
  const { request, heads } = lookupRequest(repo, rows);
  const read = readLookup(repo, rows, heads, send(model, request));
  expect(read.defaultBranch).toBe("main");
  expect(read.answers).toEqual(
    [A, B].map((tip) => ({
      kind: "proven",
      proof: {
        kind: "proven",
        tip,
        pr: 1,
        mergedAt: "2026-01-01T00:00:00Z",
        base: "main",
        by: "commit",
      },
    })),
  );
});

test("proof B: a pull request from the branch merged into the default branch with a commit of the same tree", () => {
  const model = state([
    pr({ number: 2, headRefOid: B, commits: [{ oid: B, tree: tree("same") }] }),
  ]);
  const rows = [row(C, ["feature/x"], tree("same")), row(D, ["feature/x"], tree("other"))];
  const { request, heads } = lookupRequest(repo, rows);
  const { answers } = readLookup(repo, rows, heads, send(model, request));
  expect(answers[0]).toEqual({
    kind: "proven",
    proof: {
      kind: "proven",
      tip: C,
      pr: 2,
      mergedAt: "2026-01-02T00:00:00Z",
      base: "main",
      by: "tree",
    },
  });
  // GitHub has no commit D (a null object) and no tree match: a PR from the same branch merged without it.
  expect(answers[1]).toEqual({
    kind: "not-found",
    samePr: { number: 2, mergedAt: "2026-01-02T00:00:00Z" },
    bases: [],
  });
});

test("not-found names the newest same-branch merge into the default branch, never a fork's or another base's", () => {
  const model = state([
    pr({ number: 3, mergedAt: "2026-02-01T00:00:00Z" }),
    pr({ number: 4, mergedAt: "2026-03-01T00:00:00Z", headRepository: "someone/app" }),
    pr({ number: 5, mergedAt: "2026-04-01T00:00:00Z", base: "release" }),
    pr({ number: 6, mergedAt: "2026-01-15T00:00:00Z" }),
  ]);
  const rows = [row(E, ["feature/x"], tree("none")), row(D, ["feature/elsewhere"])];
  const { request, heads } = lookupRequest(repo, rows);
  const { answers } = readLookup(repo, rows, heads, send(model, request));
  expect(answers).toEqual([
    { kind: "not-found", samePr: { number: 3, mergedAt: "2026-02-01T00:00:00Z" }, bases: [] },
    { kind: "not-found", bases: [] },
  ]);
});

test("a tree match from a fork's pull request or into another base proves nothing", () => {
  const model = state([
    pr({ number: 1, headRepository: "someone/app", commits: [{ oid: B, tree: tree("t") }] }),
    pr({ number: 2, base: "release", commits: [{ oid: C, tree: tree("t") }] }),
  ]);
  const rows = [row(D, ["feature/x"], tree("t"))];
  const { request, heads } = lookupRequest(repo, rows);
  expect(readLookup(repo, rows, heads, send(model, request)).answers).toEqual([
    { kind: "not-found", bases: [] },
  ]);
});

test("a tip merged into another branch is not proven, and names that branch for the chained request", () => {
  const model = state([pr({ number: 7, base: "stack/base", headRefName: "stack/top" })]);
  const rows = [row(A, ["stack/top"])];
  const { request, heads } = lookupRequest(repo, rows);
  expect(readLookup(repo, rows, heads, send(model, request)).answers).toEqual([
    { kind: "not-found", bases: ["stack/base"] },
  ]);
});

test("associated pull requests of another repository, or not merged, prove nothing", () => {
  const reply: GraphqlReply = {
    repository: {
      defaultBranchRef: { name: "main" },
      a0: {
        associatedPullRequests: {
          nodes: [
            {
              number: 1,
              state: "MERGED",
              mergedAt: "2026-01-01T00:00:00Z",
              baseRefName: "main",
              repository: { nameWithOwner: "upstream/app", defaultBranchRef: { name: "main" } },
            },
            {
              number: 2,
              state: "OPEN",
              mergedAt: null,
              baseRefName: "main",
              repository: { nameWithOwner: "acme/app", defaultBranchRef: { name: "main" } },
            },
            {
              number: 3,
              state: "CLOSED",
              mergedAt: null,
              baseRefName: "main",
              repository: { nameWithOwner: "acme/app", defaultBranchRef: { name: "main" } },
            },
            {
              number: "4",
              state: "MERGED",
              mergedAt: "x",
              baseRefName: "main",
              repository: { nameWithOwner: "acme/app", defaultBranchRef: { name: "main" } },
            },
          ],
        },
      },
    },
    errorPaths: [],
  };
  expect(readLookup(repo, [row(A)], [], reply).answers).toEqual([{ kind: "not-found", bases: [] }]);
  // Owner and name match without case, as on GitHub.
  const upper = { owner: "ACME", name: "App" };
  const proven: GraphqlReply = {
    ...reply,
    repository: {
      defaultBranchRef: { name: "main" },
      a0: {
        associatedPullRequests: {
          nodes: [
            {
              number: 9,
              state: "MERGED",
              mergedAt: "2026-01-01T00:00:00Z",
              baseRefName: "main",
              repository: { nameWithOwner: "acme/app", defaultBranchRef: { name: "main" } },
            },
          ],
        },
      },
    },
  };
  expect(readLookup(upper, [row(A)], [], proven).answers[0]?.kind).toBe("proven");
});

test("partial data: rows whose fields errored fail, the others are read", () => {
  const model = state([pr({ number: 1 })]);
  const rows = [row(A, ["feature/x"]), row(B, ["feature/y"]), row(C, ["feature/x"])];
  const { request, heads } = lookupRequest(repo, rows);
  const reply = send(model, request);
  const partial: GraphqlReply = {
    repository: { ...(reply.repository as object), a1: null, b0: null },
    errorPaths: [
      ["repository", "a1"],
      ["repository", "b0", "nodes", 0],
    ],
  };
  // A is proven by its own field despite b0 failing; B's object errored; C, not in a PR, needed b0.
  expect(readLookup(repo, rows, heads, partial).answers.map((answer) => answer.kind)).toEqual([
    "proven",
    "failed",
    "failed",
  ]);
  // Errors outside the repository leave the rows alone.
  expect(
    readLookup(repo, rows, heads, { ...reply, errorPaths: [["rateLimit"]] }).answers.map(
      (answer) => answer.kind,
    ),
  ).toEqual(["proven", "not-found", "not-found"]);
});

test("no repository, or an error that names no field, fails every row", () => {
  const rows = [row(A), row(B)];
  const failed = {
    defaultBranch: null,
    answers: [{ kind: "failed" as const }, { kind: "failed" as const }],
  };
  const missing = send({ ...state([]), mode: "missing-repo" }, lookupRequest(repo, rows).request);
  expect(missing).toMatchObject({ repository: null, errorPaths: [["repository"]] });
  expect(readLookup(repo, rows, [], missing)).toEqual(failed);
  expect(
    readLookup(repo, rows, [], {
      repository: { defaultBranchRef: { name: "main" } },
      errorPaths: [null],
    }),
  ).toEqual(failed);
  expect(readLookup(repo, rows, [], { repository: "nonsense", errorPaths: [] })).toEqual(failed);
});

test("the chained request lists merges from each base into the default branch, with their commits", () => {
  const model = state([
    pr({
      number: 3,
      base: "stack/base",
      headRefName: "stack/top",
      commits: [{ oid: C, tree: tree("3") }],
    }),
    pr({
      number: 4,
      base: "main",
      headRefName: "stack/base",
      commits: [
        { oid: C, tree: tree("3") },
        { oid: D, tree: tree("4") },
      ],
    }),
  ]);
  const request = chainedRequest(repo, "main", ["stack/base", "stack/top"]);
  expect(request.variables).toEqual({
    owner: "acme",
    name: "app",
    default: "main",
    base0: "stack/base",
    base1: "stack/top",
  });
  expect(request.query).toStartWith(
    "query($owner:String!,$name:String!,$default:String!,$base0:String!,$base1:String!) {",
  );
  const reply = send(model, request);
  expect(readChained(["stack/base", "stack/top"], reply)).toEqual([
    [{ number: 4, mergedAt: "2026-01-04T00:00:00Z", commits: [C, D] }],
    [],
  ]);
  expect(
    readChained(["stack/base", "stack/top"], { ...reply, errorPaths: [["repository", "k1"]] }),
  ).toEqual([[{ number: 4, mergedAt: "2026-01-04T00:00:00Z", commits: [C, D] }], null]);
  expect(readChained(["stack/base"], { repository: null, errorPaths: [["repository"]] })).toEqual([
    null,
  ]);
});

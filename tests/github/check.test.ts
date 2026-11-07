import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProofCache, type ProofCache } from "../../src/core/github/cache";
import { canAskGitHub, createGitHubCheck, type GitHubOptions } from "../../src/core/github/check";
import type { RowPatch } from "../../src/core/scan/dashboard";
import type { CommandRunner, WorktreeRow } from "../../src/core/types";
import { answerGh, type GhPullRequest, type GhState } from "../support/gh";
import { row as baseRow } from "../support/update";

const GH = "/usr/local/bin/gh";
const REPO = "/repos/alpha";
const sha = (index: number) => index.toString(16).padStart(40, "0");
const treeOf = (tip: string) => `${tip.slice(0, 39)}f`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function proofCache(): Promise<{ proofs: ProofCache; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "dash-check-"));
  roots.push(root);
  const path = join(root, "pull-requests.json");
  const proofs = createProofCache(path);
  await proofs.load();
  return { proofs, path };
}

/** A row Worktrunk couldn't show merged, which GitHub may settle. */
const row = (index: number, overrides: Partial<WorktreeRow> = {}): WorktreeRow =>
  baseRow(`feature/${index}`, 0, {
    headSha: sha(index),
    mainState: "would_conflict",
    verdict: "Review",
    reason: "1 commit isn't in main, and merging would conflict.",
    ...overrides,
  });

const merged = (index: number, overrides: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number: index,
  mergedAt: "2026-10-30T12:00:00Z",
  base: "main",
  headRefName: `feature/${index}`,
  headRefOid: sha(index),
  commits: [{ oid: sha(index), tree: treeOf(sha(index)) }],
  ...overrides,
});

/**
 * Git answers config from `config` and trees from `treeOf`; gh answers from the fake GitHub with `pullRequests`
 * unless `gh` overrides it.
 */
function world(
  options: {
    pullRequests?: GhPullRequest[];
    config?: Record<string, string>;
    gh?: CommandRunner;
  } = {},
) {
  const model: GhState = {
    mode: "ok",
    repos: [
      {
        owner: "acme",
        name: "alpha",
        defaultBranch: "main",
        pullRequests: options.pullRequests ?? [],
      },
    ],
  };
  const config = options.config ?? { "remote.origin.url": "git@github.com:acme/alpha.git" };
  const commands: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args, signal, environment) => {
    commands.push({ command, args });
    if (command === "git" && args[2] === "config") {
      const value = config[args.at(-1)!];
      return value === undefined
        ? { stdout: "", stderr: "", exitCode: 1 }
        : { stdout: `${value}\n`, stderr: "", exitCode: 0 };
    }
    if (command === "git" && args[2] === "rev-parse") {
      const trees = args.slice(3).map((arg) => treeOf(arg.replace("^{tree}", "")));
      return { stdout: `${trees.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    if (command === GH)
      return options.gh ? options.gh(command, args, signal, environment) : answerGh(model, args);
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
  const ghCalls = () => commands.filter(({ command }) => command === GH);
  const gitCalls = () => commands.filter(({ command }) => command === "git");
  return { runner, ghCalls, gitCalls };
}

const ONLINE: GitHubOptions = { offline: false, ghPath: GH };
const live = () => new AbortController().signal;
const forges = (patches: RowPatch[]) =>
  Object.fromEntries(patches.map(({ id, facts }) => [id, facts.forge]));

test.each<[string, Partial<WorktreeRow>, boolean]>([
  ["a clean worktree with unmerged commits", {}, true],
  ["one Worktrunk calls ahead", { mainState: "ahead" }, true],
  ["diverged", { mainState: "diverged" }, true],
  ["behind", { mainState: "behind" }, true],
  ["a branch without a worktree", { kind: "branch", path: null, changes: null }, true],
  ["with no upstream", { upstreamAhead: null }, true],
  ["merged as Git sees it", { mainState: "integrated" }, false],
  ["with no commits beyond main", { mainState: "empty" }, false],
  ["with unrelated history", { mainState: "orphan" }, false],
  ["of unknown state", { mainState: null }, false],
  ["with unpushed commits", { upstreamAhead: 2 }, false],
  ["with uncommitted changes", { changes: { ...baseRow("x", 0).changes!, modified: true } }, false],
  ["with untracked files", { changes: { ...baseRow("x", 0).changes!, untracked: true } }, false],
  ["with conflicts", { changes: { ...baseRow("x", 0).changes!, conflicted: true } }, false],
  [
    "whose files Git couldn't read",
    { changes: { ...baseRow("x", 0).changes!, conflicted: null } },
    false,
  ],
  ["with no status at all", { changes: null }, false],
  ["mid-rebase", { operation: "rebase" }, false],
  ["locked", { locked: true, lockReason: "agent" }, false],
  ["whose folder is gone", { prunable: true }, false],
  ["an orphan folder", { kind: "orphan" }, false],
  ["with a short SHA", { headSha: "abcdef1" }, false],
  ["with no HEAD", { headSha: null }, false],
])("GitHub is asked about a row %s: %p", (_name, overrides, asked) => {
  expect(canAskGitHub(row(1, overrides))).toBe(asked);
});

test("every row gets a patch: proofs and answers for rows it asked about, no forge check for the rest", async () => {
  const { proofs } = await proofCache();
  const { runner, ghCalls } = world({
    pullRequests: [
      merged(1),
      merged(2, {
        headRefName: "feature/2",
        headRefOid: sha(99),
        commits: [{ oid: sha(99), tree: "t".repeat(40) }],
      }),
    ],
  });
  const rows = [row(1), row(2), row(3, { mainState: "integrated" }), row(4, { headSha: null })];
  const patches = await createGitHubCheck({ github: ONLINE, runner, proofs })(REPO, rows, live());
  expect(patches.map(({ id, headSha }) => [id, headSha])).toEqual([
    [rows[0]!.id, sha(1)],
    [rows[1]!.id, sha(2)],
    [rows[2]!.id, sha(3)],
  ]);
  expect(forges(patches)).toEqual({
    [rows[0]!.id]: {
      kind: "proven",
      tip: sha(1),
      pr: 1,
      mergedAt: "2026-10-30T12:00:00Z",
      base: "main",
      by: "commit",
    },
    [rows[1]!.id]: {
      kind: "not-found",
      tip: sha(2),
      samePr: { number: 2, mergedAt: "2026-10-30T12:00:00Z" },
    },
    [rows[2]!.id]: undefined,
  });
  expect(ghCalls()).toHaveLength(1);
});

test("the upstream's name is asked about too when it differs from the branch's", async () => {
  const { proofs } = await proofCache();
  const pushedAs = merged(5, {
    headRefName: "someone/renamed",
    headRefOid: sha(77),
    commits: [{ oid: sha(77), tree: treeOf(sha(5)) }],
  });
  const { runner, ghCalls } = world({ pullRequests: [pushedAs] });
  const patches = await createGitHubCheck({ github: ONLINE, runner, proofs })(
    REPO,
    [row(5, { upstreamBranch: "someone/renamed" })],
    live(),
  );
  expect(Object.values(forges(patches))).toEqual([
    expect.objectContaining({ kind: "proven", pr: 5, by: "tree" }),
  ]);
  expect(ghCalls()[0]!.args).toContain("head1=someone/renamed");
});

test("250 rows go in three requests of at most 100", async () => {
  const { proofs } = await proofCache();
  const { runner, ghCalls } = world();
  const rows = Array.from({ length: 250 }, (_, index) => row(index + 1));
  const patches = await createGitHubCheck({ github: ONLINE, runner, proofs })(REPO, rows, live());
  expect(Object.values(forges(patches)).every((forge) => forge?.kind === "not-found")).toBe(true);
  expect(ghCalls().map(({ args }) => args.filter((arg) => /^oid\d+=/.test(arg)).length)).toEqual([
    100, 100, 50,
  ]);
});

test("a repository with no rows to ask about, or no GitHub remote, never runs gh", async () => {
  const { proofs } = await proofCache();
  const settled = world();
  const check = createGitHubCheck({ github: ONLINE, runner: settled.runner, proofs });
  await check(REPO, [row(1, { mainState: "integrated" })], live());
  expect(settled.gitCalls()).toEqual([]);

  const gitlab = world({ config: { "remote.origin.url": "https://gitlab.com/acme/alpha.git" } });
  const patches = await createGitHubCheck({ github: ONLINE, runner: gitlab.runner, proofs })(
    REPO,
    [row(1)],
    live(),
  );
  expect(Object.values(forges(patches))).toEqual([{ kind: "unchecked", why: "no-github-remote" }]);
  expect(gitlab.ghCalls()).toEqual([]);
});

test("proofs are cached and not asked again; answers that aren't proofs are asked every time", async () => {
  const { proofs, path } = await proofCache();
  const { runner, ghCalls } = world({ pullRequests: [merged(1)] });
  const check = createGitHubCheck({ github: ONLINE, runner, proofs });
  await check(REPO, [row(1), row(2)], live());
  await proofs.close();
  expect(Object.keys(JSON.parse(await readFile(path, "utf8")) as object)).toEqual([
    `acme/alpha@${sha(1)}`,
  ]);

  const second = await check(REPO, [row(1), row(2)], live());
  expect(Object.values(forges(second)).map((forge) => forge?.kind)).toEqual([
    "proven",
    "not-found",
  ]);
  expect(ghCalls()).toHaveLength(2);
  expect(ghCalls()[1]!.args.filter((arg) => /^oid\d+=/.test(arg))).toEqual([`oid0=${sha(2)}`]);

  const onlyCached = await check(REPO, [row(1)], live());
  expect(Object.values(forges(onlyCached))).toEqual([expect.objectContaining({ kind: "proven" })]);
  expect(ghCalls()).toHaveLength(2);
});

test("offline or without gh, rows say so and nothing is sent; cached proofs still count", async () => {
  const { proofs } = await proofCache();
  proofs.add({ owner: "acme", name: "alpha" }, [
    {
      kind: "proven",
      tip: sha(1),
      pr: 1,
      mergedAt: "2026-10-30T12:00:00Z",
      base: "main",
      by: "commit",
    },
  ]);
  for (const [github, why] of [
    [{ offline: true, ghPath: GH }, "offline"],
    [{ offline: false, ghPath: null }, "gh-missing"],
  ] as const) {
    const { runner, ghCalls } = world();
    const patches = await createGitHubCheck({ github, runner, proofs })(
      REPO,
      [row(1), row(2)],
      live(),
    );
    expect(Object.values(forges(patches))).toEqual([
      expect.objectContaining({ kind: "proven", pr: 1 }),
      { kind: "unchecked", why },
    ]);
    expect(ghCalls()).toEqual([]);
  }
});

test("once gh is signed out, the remaining requests aren't sent", async () => {
  const { proofs } = await proofCache();
  const { runner, ghCalls } = world({
    gh: async () => ({ stdout: "", stderr: "gh auth login", exitCode: 4 }),
  });
  const rows = Array.from({ length: 150 }, (_, index) => row(index + 1));
  const patches = await createGitHubCheck({ github: ONLINE, runner, proofs })(REPO, rows, live());
  expect(new Set(Object.values(forges(patches)).map((forge) => JSON.stringify(forge)))).toEqual(
    new Set([JSON.stringify({ kind: "unchecked", why: "signed-out" })]),
  );
  expect(ghCalls()).toHaveLength(1);
});

test("a stacked pull request is asked about in one chained request, and proves the row stacked", async () => {
  const { proofs } = await proofCache();
  const lower = sha(50);
  const { runner, ghCalls } = world({
    pullRequests: [
      merged(1, { base: "stack/base", mergedAt: "2026-10-01T00:00:00Z" }),
      merged(2, {
        headRefName: "stack/base",
        headRefOid: sha(60),
        commits: [
          { oid: lower, tree: treeOf(lower) },
          { oid: sha(1), tree: treeOf(sha(1)) },
          { oid: sha(60), tree: treeOf(sha(1)) },
        ],
        mergedAt: "2026-10-02T00:00:00Z",
      }),
      merged(3, { base: "stack/other", mergedAt: "2026-10-01T00:00:00Z" }),
    ],
  });
  const rows = [row(1), row(3)];
  const patches = await createGitHubCheck({ github: ONLINE, runner, proofs })(REPO, rows, live());
  expect(forges(patches)).toEqual({
    [rows[0]!.id]: {
      kind: "proven",
      tip: sha(1),
      pr: 2,
      mergedAt: "2026-10-02T00:00:00Z",
      base: "main",
      by: "stacked",
    },
    [rows[1]!.id]: { kind: "not-found", tip: sha(3) },
  });
  expect(ghCalls()).toHaveLength(2);
  expect(ghCalls()[1]!.args.filter((arg) => !arg.startsWith("query=") && arg !== "-f")).toEqual([
    "api",
    "graphql",
    "owner=acme",
    "name=alpha",
    "default=main",
    "base0=stack/base",
    "base1=stack/other",
  ]);
});

test("a chained request that fails leaves its rows unchecked", async () => {
  const { proofs } = await proofCache();
  const pullRequests = [merged(1, { base: "stack/base" })];
  const model: GhState = {
    mode: "ok",
    repos: [{ owner: "acme", name: "alpha", defaultBranch: "main", pullRequests }],
  };
  let calls = 0;
  const { runner } = world({
    gh: async (_command, args) =>
      ++calls === 1 ? answerGh(model, args) : { stdout: "", stderr: "timeout", exitCode: 1 },
  });
  const patches = await createGitHubCheck({ github: ONLINE, runner, proofs })(
    REPO,
    [row(1)],
    live(),
  );
  expect(Object.values(forges(patches))).toEqual([{ kind: "unchecked", why: "failed" }]);
});

test("a check aborted by a rescan throws, and caches nothing", async () => {
  const { proofs, path } = await proofCache();
  const controller = new AbortController();
  const { runner } = world({
    gh: (_command, _args, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Command aborted")));
        controller.abort();
      }),
  });
  await expect(
    createGitHubCheck({ github: ONLINE, runner, proofs })(REPO, [row(1)], controller.signal),
  ).rejects.toThrow("Command aborted");
  await proofs.close();
  expect(await Bun.file(path).exists()).toBe(false);
});

test("a request that times out leaves its rows unchecked", async () => {
  const { proofs } = await proofCache();
  const { runner } = world({
    gh: (_command, _args, signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("Command aborted"))),
      ),
  });
  const patches = await createGitHubCheck({ github: ONLINE, runner, proofs, timeoutMs: 20 })(
    REPO,
    [row(1)],
    live(),
  );
  expect(Object.values(forges(patches))).toEqual([{ kind: "unchecked", why: "failed" }]);
});

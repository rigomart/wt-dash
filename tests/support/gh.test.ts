import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createSandbox, type Sandbox, TEST_TIMEOUT } from "./fixture";
import {
  chainedQuery,
  GH_ENV,
  graphqlArgs,
  type GhPullRequest,
  type GhState,
  lookupQuery,
} from "./gh";

setDefaultTimeout(TEST_TIMEOUT);

const oid = (digit: string) => digit.repeat(40);
const [A, B, C, D] = [oid("a"), oid("b"), oid("c"), oid("d")];
const tree = (digit: string) => oid(digit);

const pullRequests: GhPullRequest[] = [
  {
    number: 1,
    mergedAt: "2026-01-01T00:00:00Z",
    base: "main",
    headRefName: "feature/x",
    headRefOid: A,
    commits: [{ oid: A, tree: tree("1") }],
  },
  // Merged later from the same branch, containing A again.
  {
    number: 2,
    mergedAt: "2026-01-02T00:00:00Z",
    base: "main",
    headRefName: "feature/x",
    headRefOid: B,
    commits: [
      { oid: A, tree: tree("1") },
      { oid: B, tree: tree("2") },
    ],
  },
  {
    number: 3,
    mergedAt: "2026-01-03T00:00:00Z",
    base: "stack/base",
    headRefName: "stack/top",
    headRefOid: C,
    commits: [{ oid: C, tree: tree("3") }],
  },
  {
    number: 4,
    mergedAt: "2026-01-04T00:00:00Z",
    base: "main",
    headRefName: "stack/base",
    headRefOid: D,
    headRepository: "someone/app",
    commits: [{ oid: D, tree: tree("4") }],
  },
];

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = await createSandbox();
});

afterAll(() => sandbox?.cleanup());

async function given(state: Partial<GhState>) {
  await sandbox.gh.update((current) => {
    current.mode = "ok";
    delete current.delayMs;
    current.repos = [{ owner: "acme", name: "app", defaultBranch: "main", pullRequests }];
    Object.assign(current, state);
  });
}

const gh = (args: string[], env: Record<string, string> = GH_ENV) =>
  sandbox.exec("gh", args, { env });

const lookup = (oids: string[], heads: string[], repo = { owner: "acme", name: "app" }) =>
  gh(
    graphqlArgs(lookupQuery(oids.length, heads.length), {
      ...repo,
      ...Object.fromEntries(oids.map((value, index) => [`oid${index}`, value])),
      ...Object.fromEntries(heads.map((value, index) => [`head${index}`, value])),
    }),
  );

const associated = (pr: GhPullRequest) => ({
  number: pr.number,
  state: "MERGED",
  mergedAt: pr.mergedAt,
  baseRefName: pr.base,
  headRefName: pr.headRefName,
  headRefOid: pr.headRefOid,
  repository: { nameWithOwner: "acme/app", defaultBranchRef: { name: "main" } },
});
const fromHead = (pr: GhPullRequest) => ({
  number: pr.number,
  mergedAt: pr.mergedAt,
  baseRefName: pr.base,
  headRefOid: pr.headRefOid,
  headRepository: { nameWithOwner: pr.headRepository ?? "acme/app" },
  commits: { nodes: pr.commits.map(({ oid, tree }) => ({ commit: { oid, tree: { oid: tree } } })) },
});

test("answers aN with the pull request that first brought the commit in, and null for a commit GitHub lacks", async () => {
  await given({});
  const result = await lookup([A, B, oid("f")], ["feature/x", "nothing/here"]);
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({
    data: {
      rateLimit: { cost: 1, remaining: 4999 },
      repository: {
        defaultBranchRef: { name: "main" },
        a0: { associatedPullRequests: { nodes: [associated(pullRequests[0]!)] } },
        a1: { associatedPullRequests: { nodes: [associated(pullRequests[1]!)] } },
        a2: null,
        b0: { nodes: [fromHead(pullRequests[1]!), fromHead(pullRequests[0]!)] },
        b1: { nodes: [] },
      },
    },
  });
});

test("answers kN with the pull requests that merged branch $baseN into $default", async () => {
  await given({});
  const result = await gh(
    graphqlArgs(chainedQuery(2), {
      owner: "acme",
      name: "app",
      default: "main",
      base0: "stack/base",
      base1: "stack/top",
    }),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    data: {
      rateLimit: { cost: 1, remaining: 4999 },
      repository: {
        k0: {
          nodes: [
            {
              number: 4,
              mergedAt: "2026-01-04T00:00:00Z",
              commits: { nodes: [{ commit: { oid: D } }] },
            },
          ],
        },
        // stack/top was merged into stack/base, not main.
        k1: { nodes: [] },
      },
    },
  });
});

test("lists at most `first` pull requests from a branch, newest first", async () => {
  await given({
    repos: [
      {
        owner: "acme",
        name: "app",
        defaultBranch: "main",
        pullRequests: Array.from({ length: 7 }, (_, index) => ({
          ...pullRequests[0]!,
          number: index + 1,
        })),
      },
    ],
  });
  const result = await lookup([], ["feature/x"]);
  const numbers = (
    JSON.parse(result.stdout) as {
      data: { repository: { b0: { nodes: Array<{ number: number }> } } };
    }
  ).data.repository.b0.nodes.map(({ number }) => number);
  expect(numbers).toEqual([7, 6, 5, 4, 3]);
});

test("a missing repository gives partial data, an errors array on stdout and exit 1", async () => {
  const missing = {
    data: { rateLimit: { cost: 1, remaining: 4999 }, repository: null },
    errors: [
      {
        type: "NOT_FOUND",
        path: ["repository"],
        message: "Could not resolve to a Repository with the name 'acme/app'.",
      },
    ],
  };
  await given({ mode: "missing-repo" });
  const forced = await lookup([A], ["feature/x"]);
  expect({ ...forced, stdout: JSON.parse(forced.stdout) as unknown }).toEqual({
    exitCode: 1,
    stdout: missing,
    stderr: "gh: Could not resolve to a Repository with the name 'acme/app'.\n",
  });
  await given({});
  const unknown = await lookup([A], [], { owner: "acme", name: "gone" });
  expect(unknown.exitCode).toBe(1);
  expect(JSON.parse(unknown.stdout)).toEqual({
    data: missing.data,
    errors: [
      {
        ...missing.errors[0]!,
        message: "Could not resolve to a Repository with the name 'acme/gone'.",
      },
    ],
  });
});

test.each([
  [
    "signed-out",
    4,
    "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n",
  ],
  ["bad-credentials", 1, "gh: Bad credentials (HTTP 401)\n"],
  ["offline", 1, 'Post "https://api.github.com/graphql": dial tcp: connection refused\n'],
] as const)("%s exits %d with the real CLI's message", async (mode, exitCode, stderr) => {
  await given({ mode });
  expect(await lookup([A], ["feature/x"])).toEqual({ exitCode, stderr, stdout: "" });
});

test("waits delayMs before answering", async () => {
  await given({ delayMs: 400 });
  const started = Date.now();
  const result = await lookup([A], []);
  expect(result.exitCode).toBe(0);
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
});

test.each([
  ["another subcommand", ["auth", "status"]],
  ["another API", ["api", "repos/acme/app"]],
  ["a typed -F field", ["api", "graphql", "-f", "query={ viewer { login } }", "-F", "first=5"]],
  ["another flag", ["api", "graphql", "--jq", ".data", "-f", "query={ viewer { login } }"]],
])("refuses %s loudly", async (_, args) => {
  await given({});
  const result = await gh(args);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toStartWith("fake gh: ");
  expect(result.stdout).toBe("");
});

test.each([
  [
    "an oid that isn't 40 hex digits",
    { oid0: "abc123" },
    "Variable $oid0 of type GitObjectID! was provided invalid value",
  ],
  [
    "a declared variable not given",
    {},
    "Variable $oid0 of type GitObjectID! was provided invalid value",
  ],
])("rejects %s as GitHub does", async (_, variables, message) => {
  await given({});
  const result = await gh(
    graphqlArgs(lookupQuery(1, 0), { owner: "acme", name: "app", ...variables }),
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ errors: [{ message }] });
  expect(result.stderr).toBe(`gh: ${message}\n`);
});

test("rejects a field the fake doesn't model instead of inventing it", async () => {
  await given({});
  const result = await gh(
    graphqlArgs(
      "query($owner:String!,$name:String!) { repository(owner:$owner, name:$name) { stargazerCount } }",
      {
        owner: "acme",
        name: "app",
      },
    ),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Field 'stargazerCount' doesn't exist on type 'Repository'");
});

test("logs every call with its arguments, folder and GitHub variables, refused ones too", async () => {
  await given({});
  const before = (await sandbox.gh.calls()).length;
  const args = graphqlArgs(lookupQuery(1, 0), { owner: "acme", name: "app", oid0: A });
  await sandbox.exec("gh", args, {
    cwd: sandbox.home,
    env: { ...GH_ENV, GITHUB_TOKEN: "t", UNRELATED: "x" },
  });
  await gh(["pr", "list"]);
  const calls = (await sandbox.gh.calls()).slice(before);
  expect(calls).toEqual([
    {
      argv: args,
      cwd: sandbox.home,
      env: { ...GH_ENV, GITHUB_TOKEN: "t", NO_COLOR: "1" },
    },
    { argv: ["pr", "list"], cwd: sandbox.root, env: { ...GH_ENV, NO_COLOR: "1" } },
  ]);
});

const hasGh = (folder: string) =>
  lstat(join(folder, "gh")).then(
    () => true,
    () => false,
  );

test("the sandbox PATH has the fake gh first and no other gh, and still finds the tools tests use", async () => {
  const folders = sandbox.env.PATH.split(delimiter);
  expect(folders[0]).toBe(sandbox.gh.bin);
  expect(Bun.which("gh", { PATH: sandbox.env.PATH })).toBe(join(sandbox.gh.bin, "gh"));
  for (const folder of folders.slice(1))
    expect(`${folder}: ${await hasGh(folder)}`).toBe(`${folder}: false`);
  const shell = await sandbox.exec("sh", ["-c", "command -v gh"]);
  expect(shell.stdout.trim()).toBe(join(sandbox.gh.bin, "gh"));
  for (const tool of ["git", "bun", "du", "lsof", "ps", "sh", "perl", "python3"])
    expect(`${tool}: ${Bun.which(tool, { PATH: sandbox.env.PATH }) !== null}`).toBe(
      `${tool}: true`,
    );
});

test("with gh missing, nothing on the sandbox PATH answers to gh", async () => {
  const bare = await createSandbox({ gh: "missing" });
  try {
    expect(bare.gh.installed).toBe(false);
    expect(Bun.which("gh", { PATH: bare.env.PATH })).toBeNull();
    for (const folder of bare.env.PATH.split(delimiter))
      expect(`${folder}: ${await hasGh(folder)}`).toBe(`${folder}: false`);
    const shell = await bare.exec("sh", ["-c", "command -v gh"]);
    expect(shell.exitCode).not.toBe(0);
    await expect(bare.exec("gh", ["--version"])).rejects.toThrow(
      "gh was not found on the sandbox PATH",
    );
  } finally {
    await bare.cleanup();
  }
});

test("a gh on the developer's PATH is left out while the tools beside it still run", async () => {
  const planted = await realpath(await mkdtemp(join(tmpdir(), "wt-dash-planted-")));
  const original = process.env.PATH;
  try {
    await writeFile(join(planted, "gh"), "#!/bin/sh\necho real gh\n", { mode: 0o755 });
    await writeFile(join(planted, "neighbour"), "#!/bin/sh\necho neighbour\n", { mode: 0o755 });
    process.env.PATH = [planted, original].join(delimiter);
    for (const gh of ["fake", "missing"] as const) {
      const other = await createSandbox({ gh });
      try {
        expect(other.env.PATH.split(delimiter)).not.toContain(planted);
        const found = await other.exec("sh", ["-c", "neighbour; command -v gh || echo none"]);
        expect(found.stdout).toBe(
          `neighbour\n${gh === "fake" ? join(other.gh.bin, "gh") : "none"}\n`,
        );
      } finally {
        await other.cleanup();
      }
    }
  } finally {
    process.env.PATH = original;
    await rm(planted, { recursive: true, force: true });
  }
});

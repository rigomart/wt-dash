import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { assess } from "../../src/core/assess";
import type { DashboardService, DashboardSnapshot, ForgeCheck } from "../../src/core/types";
import {
  createSandbox,
  online,
  type Built,
  type GitHubOptions,
  type Repo,
  type Sandbox,
  type Services,
  TEST_TIMEOUT,
} from "../support/fixture";
import {
  chainedQuery,
  GH_ENV,
  type GhCall,
  type GhMode,
  graphqlArgs,
  lookupQuery,
} from "../support/gh";
import { row, scan, waitFor } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

type Name = "merged" | "branch" | "earlier" | "treeMatch" | "missing" | "stacked";

let sandbox: Sandbox;
let hub: Repo;
let solo: Repo;
let plain: Repo;
let settled: Repo;
let built: Record<Name, Built>;
let soloBuilt: Built;
let plainBuilt: Built;
let settledBuilt: Built;
let open: Services[] = [];

beforeAll(async () => {
  sandbox = await createSandbox();
  [hub, solo, plain, settled] = await Promise.all([
    sandbox.repo("hub", { github: true }),
    sandbox.repo("solo", { github: true }),
    sandbox.repo("plain"),
    sandbox.repo("settled", { github: true }),
  ]);
  // Each merges into main, so they run one after another.
  built = {
    merged: await hub.prMergedWorktree("feature/merged"),
    branch: await hub.prMergedBranch("leftover/merged"),
    earlier: await hub.prMergedEarlierCommit("feature/earlier"),
    treeMatch: await hub.prTreeMatch("feature/rebased"),
    missing: await hub.prMissingCommit("feature/missing"),
    stacked: await hub.prStacked("feature/top", { base: "feature/bottom" }),
  };
  [soloBuilt, plainBuilt, settledBuilt] = await Promise.all([
    solo.prMergedWorktree("feature/solo"),
    plain.unmergedWorktree("feature/plain"),
    settled.mergedWorktree("feature/settled"),
  ]);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((services) => services.close()));
  await rm(join(sandbox.cacheDir, "pull-requests.json"), { force: true });
});

afterAll(() => sandbox?.cleanup());

async function services(github?: GitHubOptions): Promise<Services> {
  const opened = await sandbox.services({ github });
  open.push(opened);
  return opened;
}

/** Scans every repository and waits for each follow-up to finish. */
async function scanAll(dashboard: DashboardService): Promise<DashboardSnapshot> {
  await dashboard.refresh();
  return waitFor(dashboard, (snapshot) => snapshot.checking === 0);
}

/** The calls made since `before` calls were logged. */
async function callsSince(before: number): Promise<GhCall[]> {
  return (await sandbox.gh.calls()).slice(before);
}

/** The `-f` fields of a call, by name, after checking every value was passed with `-f`. */
function fields(call: GhCall): Record<string, string> {
  expect(call.argv.slice(0, 2)).toEqual(["api", "graphql"]);
  const pairs = call.argv.slice(2);
  expect(pairs.filter((_, index) => index % 2 === 0).every((flag) => flag === "-f")).toBe(true);
  return Object.fromEntries(
    pairs
      .filter((_, index) => index % 2 === 1)
      .map((field) => [field.slice(0, field.indexOf("=")), field.slice(field.indexOf("=") + 1)]),
  );
}

const verdicts = (snapshot: DashboardSnapshot) =>
  Object.fromEntries(
    Object.entries(built).map(([name, expected]) => [name, row(snapshot, expected).verdict]),
  );

test("Worktrunk sees a GitHub forge in the fixture's origin, which Git serves from a local bare repo", async () => {
  const listed = JSON.parse(
    await sandbox.wt(
      hub.path,
      "--config-set",
      "list.json-schema=2",
      "list",
      "--branches",
      "--format=json",
    ),
  ) as {
    repo: { forge?: Record<string, string> };
    items: Array<{ branch: string; upstream?: unknown }>;
  };
  expect(listed.repo.forge).toEqual({
    url: "https://github.com/acme/hub",
    provider: "github",
    host: "github.com",
    owner: "acme",
    name: "hub",
    remote: "origin",
  });
  expect(await hub.git("config", "remote.origin.url")).toBe("https://github.com/acme/hub.git");
  expect(await hub.git("rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
  expect(await hub.git("rev-parse", "origin/main")).toBe(await hub.git("rev-parse", "main"));
  expect(await sandbox.git(hub.github!.bare, "rev-parse", "main")).toBe(
    await hub.git("rev-parse", "main"),
  );
  // GitHub deleted each merged branch, so none has an upstream left.
  expect(listed.items.filter((item) => item.upstream).map((item) => item.branch)).toEqual(["main"]);
  // Listing never runs gh, so the fake's log holds only the app's calls.
  expect(await sandbox.gh.calls()).toEqual([]);
});

test("the fake GitHub holds what each builder's Git implies", async () => {
  const { dashboard } = await services();
  const snapshot = await scan(dashboard, hub);
  const order = Object.keys(built) as Name[];
  const tips = order.map((name) => row(snapshot, built[name]).headSha!);
  const trees = await Promise.all(tips.map((tip) => hub.git("rev-parse", `${tip}^{tree}`)));
  const answer = await ask(
    graphqlArgs(lookupQuery(order.length, order.length), {
      owner: "acme",
      name: "hub",
      ...Object.fromEntries(tips.map((tip, index) => [`oid${index}`, tip])),
      ...Object.fromEntries(order.map((name, index) => [`head${index}`, built[name].branch])),
    }),
  );
  const at = (name: Name) => order.indexOf(name);
  const associated = (name: Name) =>
    answer[`a${at(name)}`]?.associatedPullRequests?.nodes.map(
      ({ number, headRefOid, baseRefName }) => ({
        number,
        tipIsHead: headRefOid === tips[at(name)],
        baseRefName,
      }),
    ) ?? null;
  const fromHead = (name: Name) =>
    answer[`b${at(name)}`]!.nodes!.map(({ number, commits }) => ({
      number,
      hasTip: commits.nodes.some(({ commit }) => commit.oid === tips[at(name)]),
      hasTree: commits.nodes.some(({ commit }) => commit.tree?.oid === trees[at(name)]),
    }));
  const [merged, branch, earlier, treeMatch, missing] = order.map(
    (name) => built[name].github!.pullRequests[0]!,
  );
  const [intoBase, intoMain] = built.stacked.github!.pullRequests;

  expect(associated("merged")).toEqual([{ number: merged, tipIsHead: true, baseRefName: "main" }]);
  expect(associated("branch")).toEqual([{ number: branch, tipIsHead: true, baseRefName: "main" }]);
  expect(associated("earlier")).toEqual([
    { number: earlier, tipIsHead: false, baseRefName: "main" },
  ]);
  // Rebased here: GitHub doesn't have the tip, but a merged commit from the branch has its files.
  expect(associated("treeMatch")).toBeNull();
  expect(fromHead("treeMatch")).toEqual([{ number: treeMatch, hasTip: false, hasTree: true }]);
  // Committed after the merge: neither the tip nor its files are on GitHub.
  expect(associated("missing")).toBeNull();
  expect(fromHead("missing")).toEqual([{ number: missing, hasTip: false, hasTree: false }]);
  // Stacked: merged into feature/bottom, which a later pull request merged into main with the tip in it.
  expect(associated("stacked")).toEqual([
    { number: intoBase!, tipIsHead: true, baseRefName: "feature/bottom" },
  ]);
  const chained = await ask(
    graphqlArgs(chainedQuery(1), {
      owner: "acme",
      name: "hub",
      default: "main",
      base0: "feature/bottom",
    }),
  );
  expect(
    chained.k0!.nodes!.map(({ number, commits }) => ({
      number,
      hasTip: commits.nodes.some(({ commit }) => commit.oid === tips[at("stacked")]),
    })),
  ).toEqual([{ number: intoMain!, hasTip: true }]);
});

test("asked online, every pr… row reaches the builder's verdict, with one request per GitHub repo that has rows to ask about", async () => {
  const before = (await sandbox.gh.calls()).length;
  const { dashboard } = await services(online(sandbox));
  const snapshot = await scanAll(dashboard);
  expect(snapshot.errors).toEqual({});

  expect(verdicts(snapshot)).toEqual(
    Object.fromEntries(Object.entries(built).map(([name, { github }]) => [name, github!.verdict])),
  );
  const forge = (name: Name) => row(snapshot, built[name]).forge;
  const [merged, branch, earlier, treeMatch, missing] = (Object.keys(built) as Name[]).map(
    (name) => built[name].github!.pullRequests[0]!,
  );
  const proven = (name: Name, pr: number, by: string) => ({
    kind: "proven",
    tip: row(snapshot, built[name]).headSha,
    pr,
    base: "main",
    by,
  });
  expect(forge("merged")).toMatchObject(proven("merged", merged!, "commit"));
  expect(forge("branch")).toMatchObject(proven("branch", branch!, "commit"));
  expect(forge("earlier")).toMatchObject(proven("earlier", earlier!, "commit"));
  expect(forge("treeMatch")).toMatchObject(proven("treeMatch", treeMatch!, "tree"));
  expect(forge("stacked")).toMatchObject(
    proven("stacked", built.stacked.github!.pullRequests[1]!, "stacked"),
  );
  expect(forge("missing")).toMatchObject({
    kind: "not-found",
    tip: row(snapshot, built.missing).headSha,
    samePr: { number: missing },
  });
  const shown = row(snapshot, built.merged);
  expect(assess(shown).status).toBe("merged on GitHub");
  expect(shown.reason).toStartWith(`PR #${merged} merged `);
  expect(shown.reason).toEndWith(" with this exact commit.");
  expect(row(snapshot, built.missing).reason).toMatch(
    new RegExp(
      `^2 commits aren't in main, and merging would conflict\\. PR #${missing} merged .+ without this commit\\.$`,
    ),
  );

  // Not on GitHub, or nothing left for GitHub to settle: no forge check, the reason as before, and no call.
  expect(row(snapshot, plainBuilt)).toMatchObject({
    verdict: "Review",
    reason: plainBuilt.expected.reason,
    forge: { kind: "unchecked", why: "no-github-remote" },
  });
  expect(row(snapshot, settledBuilt)).toMatchObject({ verdict: "Safe" });
  expect(row(snapshot, settledBuilt).forge).toBeUndefined();
  expect(row(snapshot, soloBuilt).verdict).toBe("Safe");

  const calls = await callsSince(before);
  const asked = calls.map((call) => {
    const { query, ...variables } = fields(call);
    return {
      repo: `${variables.owner}/${variables.name}`,
      chained: "default" in variables,
      query,
      variables,
    };
  });
  expect(
    asked
      .map(({ repo, chained }) => ({ repo, chained }))
      .sort((a, b) => a.repo.localeCompare(b.repo) || Number(a.chained) - Number(b.chained)),
  ).toEqual([
    { repo: "acme/hub", chained: false },
    { repo: "acme/hub", chained: true },
    { repo: "acme/solo", chained: false },
  ]);
  const lookup = asked.find(({ repo, chained }) => repo === "acme/hub" && !chained)!;
  const rows = Object.values(built).map((one) => row(snapshot, one));
  expect(Object.keys(lookup.variables).filter((key) => key.startsWith("oid"))).toHaveLength(6);
  expect(
    Object.entries(lookup.variables)
      .filter(([key]) => key.startsWith("oid"))
      .map(([, oid]) => oid)
      .sort(),
  ).toEqual(rows.map((one) => one.headSha!).sort());
  expect(
    Object.entries(lookup.variables)
      .filter(([key]) => key.startsWith("head"))
      .map(([, head]) => head)
      .sort(),
  ).toEqual(
    Object.values(built)
      .map((one) => one.branch!)
      .sort(),
  );
  const chained = asked.find(({ repo, chained }) => repo === "acme/hub" && chained)!;
  expect(chained.variables).toEqual({
    owner: "acme",
    name: "hub",
    default: "main",
    base0: "feature/bottom",
  });
  for (const call of calls) {
    expect(call.env).toMatchObject(GH_ENV);
    expect(call.argv.some((arg) => arg.startsWith("-F") || arg.startsWith("--field"))).toBe(false);
  }
});

test("a second scan sends nothing for the proofs it cached, and a repo with only cached rows is not asked", async () => {
  const first = await services(online(sandbox));
  await scanAll(first.dashboard);
  await first.close();
  const before = (await sandbox.gh.calls()).length;

  const { dashboard } = await services(online(sandbox));
  const snapshot = await scanAll(dashboard);
  expect(verdicts(snapshot)).toEqual(
    Object.fromEntries(Object.entries(built).map(([name, { github }]) => [name, github!.verdict])),
  );
  expect(row(snapshot, soloBuilt).verdict).toBe("Safe");
  const calls = await callsSince(before);
  // Only the tip GitHub didn't hold is asked about again.
  expect(calls.map((call) => fields(call))).toEqual([
    expect.objectContaining({
      owner: "acme",
      name: "hub",
      oid0: row(snapshot, built.missing).headSha!,
      head0: built.missing.branch!,
    }),
  ]);
  expect(Object.keys(fields(calls[0]!)).sort()).toEqual([
    "head0",
    "name",
    "oid0",
    "owner",
    "query",
  ]);
});

const reviewWith = (note: string) => (name: Name) => ({
  verdict: "Review" as const,
  reason: `${built[name].expected.reason} ${note}`,
});

async function checkedIn(mode: GhMode): Promise<{ snapshot: DashboardSnapshot; calls: GhCall[] }> {
  await sandbox.gh.setMode(mode);
  try {
    const before = (await sandbox.gh.calls()).length;
    const { dashboard } = await services(online(sandbox));
    await scan(dashboard, hub);
    const snapshot = await waitFor(dashboard, (next) => next.checking === 0);
    return { snapshot, calls: await callsSince(before) };
  } finally {
    await sandbox.gh.setMode("ok");
  }
}

function expectAll(snapshot: DashboardSnapshot, forge: ForgeCheck, note: string): void {
  for (const name of Object.keys(built) as Name[]) {
    const shown = row(snapshot, built[name]);
    expect({ name, forge: shown.forge, verdict: shown.verdict, reason: shown.reason }).toEqual({
      name,
      forge,
      ...reviewWith(note)(name),
    });
  }
}

test.each([
  ["signed-out", "signed-out", "Not checked against GitHub: gh isn't signed in."],
  ["bad-credentials", "failed", "Not checked against GitHub: GitHub didn't answer."],
  ["offline", "failed", "Not checked against GitHub: GitHub didn't answer."],
  ["missing-repo", "failed", "Not checked against GitHub: GitHub didn't answer."],
] as const)("gh answering %s leaves every row Review, saying why", async (mode, why, note) => {
  const { snapshot, calls } = await checkedIn(mode);
  expectAll(snapshot, { kind: "unchecked", why }, note);
  // One request; nothing came back to chain from.
  expect(calls).toHaveLength(1);
});

test("offline, or without gh, no request is made and every row says why", async () => {
  const before = (await sandbox.gh.calls()).length;
  for (const [github, why, note] of [
    [{ offline: true, ghPath: null }, "offline", "Not checked against GitHub: offline."],
    [undefined, "offline", "Not checked against GitHub: offline."],
    [
      { offline: false, ghPath: null },
      "gh-missing",
      "Not checked against GitHub: gh isn't installed.",
    ],
    [
      { offline: false, ghPath: join(sandbox.gh.bin, "no-such-gh") },
      "gh-missing",
      "Not checked against GitHub: gh isn't installed.",
    ],
  ] as const) {
    const { dashboard } = await services(github);
    await scan(dashboard, hub);
    const snapshot = await waitFor(dashboard, (next) => next.checking === 0);
    expectAll(snapshot, { kind: "unchecked", why }, note);
  }
  expect(await callsSince(before)).toEqual([]);
});

test("a sandbox with no gh on PATH asks nothing and says gh isn't installed", async () => {
  const bare = await createSandbox({ gh: "missing" });
  try {
    const repo = await bare.repo("lonely", { github: true });
    const lonely = await repo.prMergedWorktree("feature/lonely");
    const options = online(bare);
    expect(options).toEqual({ offline: false, ghPath: null });
    const { dashboard } = await bare.services({ github: options });
    await scan(dashboard, repo);
    const snapshot = await waitFor(dashboard, (next) => next.checking === 0);
    expect(row(snapshot, lonely)).toMatchObject({
      verdict: "Review",
      reason: `${lonely.expected.reason} Not checked against GitHub: gh isn't installed.`,
      forge: { kind: "unchecked", why: "gh-missing" },
    });
    expect(await bare.gh.calls()).toEqual([]);
  } finally {
    await bare.cleanup();
  }
});

interface Answer {
  data: {
    repository: Record<
      string,
      {
        associatedPullRequests?: {
          nodes: Array<{ number: number; headRefOid: string; baseRefName: string }>;
        };
        nodes?: Array<{
          number: number;
          commits: { nodes: Array<{ commit: { oid: string; tree?: { oid: string } } }> };
        }>;
      } | null
    >;
  };
}

async function ask(args: string[]): Promise<Answer["data"]["repository"]> {
  const result = await sandbox.exec("gh", args, { env: GH_ENV });
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  return (JSON.parse(result.stdout) as Answer).data.repository;
}

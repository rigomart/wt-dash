import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { assess } from "../../src/core/assess";
import {
  createSandbox,
  type Built,
  type Repo,
  type Sandbox,
  TEST_TIMEOUT,
} from "../support/fixture";
import { chainedQuery, GH_ENV, graphqlArgs, lookupQuery } from "../support/gh";
import { row, scan } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

let sandbox: Sandbox;
let hub: Repo;
let built: Record<"merged" | "branch" | "earlier" | "treeMatch" | "missing" | "stacked", Built>;

beforeAll(async () => {
  sandbox = await createSandbox();
  hub = await sandbox.repo("hub", { github: true });
  // Each merges into main, so they run one after another.
  built = {
    merged: await hub.prMergedWorktree("feature/merged"),
    branch: await hub.prMergedBranch("leftover/merged"),
    earlier: await hub.prMergedEarlierCommit("feature/earlier"),
    treeMatch: await hub.prTreeMatch("feature/rebased"),
    missing: await hub.prMissingCommit("feature/missing"),
    stacked: await hub.prStacked("feature/top", { base: "feature/bottom" }),
  };
}, 60_000);

afterAll(() => sandbox?.cleanup());

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

test("today every pr… row is Review: Worktrunk finds no integration, and only GitHub can tell", async () => {
  const { dashboard } = await sandbox.services();
  const snapshot = await scan(dashboard, hub);
  for (const [name, expected] of Object.entries(built)) {
    const shown = row(snapshot, expected);
    expect({ name, kind: shown.kind, path: shown.path }).toEqual({
      name,
      kind: expected.kind,
      path: expected.path,
    });
    expect({
      name,
      verdict: shown.verdict,
      status: assess(shown).status,
      reason: shown.reason,
      integration: shown.integrationReason,
      unproven: ["would_conflict", "diverged"].includes(shown.mainState ?? ""),
    }).toEqual({
      name,
      verdict: "Review",
      status: expected.expected.status,
      reason: expected.expected.reason,
      integration: null,
      unproven: true,
    });
  }
  expect(
    Object.fromEntries(Object.entries(built).map(([name, { github }]) => [name, github?.verdict])),
  ).toEqual({
    merged: "Safe",
    branch: "Safe",
    earlier: "Safe",
    treeMatch: "Safe",
    missing: "Review",
    stacked: "Safe",
  });
  expect(await sandbox.gh.calls()).toEqual([]);
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

test("the fake GitHub holds what each builder's Git implies", async () => {
  const { dashboard } = await sandbox.services();
  const snapshot = await scan(dashboard, hub);
  const order = Object.keys(built) as Array<keyof typeof built>;
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
  const at = (name: keyof typeof built) => order.indexOf(name);
  const associated = (name: keyof typeof built) =>
    answer[`a${at(name)}`]?.associatedPullRequests?.nodes.map(
      ({ number, headRefOid, baseRefName }) => ({
        number,
        tipIsHead: headRefOid === tips[at(name)],
        baseRefName,
      }),
    ) ?? null;
  const fromHead = (name: keyof typeof built) =>
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
  // Stacked: merged into feature/bottom, which a later pull request merged into main.
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
  expect(chained.k0!.nodes!.map(({ number }) => number)).toEqual([intoMain!]);
});

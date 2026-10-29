import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RemovalChoice } from "../../src/core/actions";
import {
  createSandbox,
  type Built,
  type Repo,
  type Sandbox,
  TEST_TIMEOUT,
} from "../support/fixture";
import { exists, logFor, row, scan } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = await createSandbox();
});

afterAll(() => sandbox?.cleanup());

async function tip(repo: Repo, branch: string): Promise<string | null> {
  const result = await sandbox.exec(
    "git",
    ["rev-parse", "--verify", "-q", `refs/heads/${branch}`],
    {
      cwd: repo.path,
    },
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function remove(
  repo: Repo,
  built: Built,
  choice: Omit<RemovalChoice, "include">,
  preview: { requiresDiscard: boolean },
) {
  const { dashboard, actions } = await sandbox.services();
  const shown = row(await scan(dashboard, repo), built);
  expect([shown.verdict, shown.reason]).toEqual([built.expected.verdict, built.expected.reason]);
  const plan = await actions.prepareRemoval([shown]);
  expect(
    plan.entries.map((entry) => [
      entry.blockedReason,
      entry.requiresDiscard,
      entry.branchWillBeRetained,
    ]),
  ).toEqual([[null, preview.requiresDiscard, true]]);
  const result = await actions.executeRemoval(plan, { [shown.id]: { include: true, ...choice } });
  return { shown, result };
}

const logged = async (built: Built) =>
  (await logFor(sandbox, built)).map(({ flags, exitCode, branchOutcome, error }) => ({
    flags,
    exitCode,
    branchOutcome,
    error,
  }));

test("removing an unmerged worktree without D keeps its branch at the same commit (README: branches are kept unless merged)", async () => {
  const repo = await sandbox.repo("kept");
  const built = await repo.unmergedWorktree("feature", { commits: 2 });
  const before = (await tip(repo, "feature"))!;
  const { shown, result } = await remove(repo, built, {}, { requiresDiscard: false });
  expect(result.items).toEqual([
    { id: shown.id, status: "removed", branchOutcome: "retained_unmerged" },
  ]);
  expect(await exists(built.path!)).toBe(false);
  expect(await tip(repo, "feature")).toBe(before);
  expect(await logged(built)).toEqual([
    { flags: [], exitCode: 0, branchOutcome: "retained_unmerged", error: null },
  ]);
});

test("removing a dirty unmerged worktree with discard confirmed, without D, still keeps its branch", async () => {
  const repo = await sandbox.repo("kept-dirty");
  const built = await repo.unmergedWorktree("feature");
  await writeFile(join(built.path!, "draft.txt"), "draft\n");
  const before = (await tip(repo, "feature"))!;
  const { shown, result } = await remove(
    repo,
    {
      ...built,
      expected: {
        ...built.expected,
        status: "uncommitted changes",
        reason: "Removing it deletes work that isn't committed.",
      },
    },
    { discardChanges: true },
    { requiresDiscard: true },
  );
  expect(result.items).toEqual([
    { id: shown.id, status: "removed", branchOutcome: "retained_unmerged" },
  ]);
  expect(await exists(built.path!)).toBe(false);
  expect(await tip(repo, "feature")).toBe(before);
  expect(await logged(built)).toEqual([
    { flags: ["-f"], exitCode: 0, branchOutcome: "retained_unmerged", error: null },
  ]);
});

test("removing an unmerged worktree with D (forceDeleteBranch) deletes its branch too (README: press D to delete unmerged branches)", async () => {
  const repo = await sandbox.repo("forced");
  const built = await repo.unmergedWorktree("feature");
  const { shown, result } = await remove(
    repo,
    built,
    { forceDeleteBranch: true },
    { requiresDiscard: false },
  );
  expect(result.items).toEqual([{ id: shown.id, status: "removed", branchOutcome: "deleted" }]);
  expect(await exists(built.path!)).toBe(false);
  expect(await tip(repo, "feature")).toBeNull();
  expect(await logged(built)).toEqual([
    { flags: ["-D"], exitCode: 0, branchOutcome: "deleted", error: null },
  ]);
});

// Fails until branchWillBeRetained counts "behind" with reason "ancestor" as merged (#23).
test.failing(
  "a dirty worktree's branch that main moved past is previewed as deleted, as Worktrunk deletes it (#23)",
  async () => {
    const repo = await sandbox.repo("behind");
    const built = await repo.dirtyWorktree("behind");
    await writeFile(join(repo.path, "later.txt"), "later\n");
    await repo.git("add", "later.txt");
    await repo.git("commit", "-q", "-m", "Main moves on");
    const { dashboard, actions } = await sandbox.services();
    const shown = row(await scan(dashboard, repo), built);
    expect([shown.mainState, shown.integrationReason]).toEqual(["behind", "ancestor"]);
    const plan = await actions.prepareRemoval([shown]);
    const result = await actions.executeRemoval(plan, {
      [shown.id]: { include: true, discardChanges: true },
    });
    expect(result.items).toEqual([{ id: shown.id, status: "removed", branchOutcome: "deleted" }]);
    expect(await tip(repo, "behind")).toBeNull();
    expect(plan.entries[0]!.branchWillBeRetained).toBe(false);
  },
);

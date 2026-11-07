import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assessRow } from "../../src/core/assess";
import type { ForgeCheck, WorktreeRow } from "../../src/core/types";
import { createSandbox, type Built, type Sandbox, TEST_TIMEOUT } from "../support/fixture";
import { branches, exists, logFor, row, scan } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = await createSandbox();
});

afterAll(() => sandbox?.cleanup());

/** The row as the scan shows it once GitHub has answered that PR `pr` merged its tip. */
function provenOnGitHub(shown: WorktreeRow, pr: number): WorktreeRow {
  const forge: ForgeCheck = {
    kind: "proven",
    tip: shown.headSha!,
    pr,
    mergedAt: "2026-10-30T12:00:00Z",
    base: "main",
    by: "commit",
  };
  return assessRow({ ...shown, forge });
}

const logged = async (built: Built) =>
  (await logFor(sandbox, built)).map(({ flags, exitCode, branchOutcome, branchProof, error }) => ({
    flags,
    exitCode,
    branchOutcome,
    branchProof,
    error,
  }));

test("a worktree Worktrunk can't show merged but GitHub proves merged is removed with its branch, and the log names the PR", async () => {
  const repo = await sandbox.repo("proven");
  const built = await repo.unmergedWorktree("feature");
  const { dashboard, actions } = await sandbox.services();
  const shown = row(await scan(dashboard, repo), built);
  expect([shown.verdict, shown.mainState, shown.integrationReason]).toEqual([
    "Review",
    "ahead",
    null,
  ]);
  const proven = provenOnGitHub(shown, 60);
  expect(proven.verdict).toBe("Safe");

  const plan = await actions.prepareRemoval([proven]);
  expect(plan.entries[0]).toMatchObject({
    blockedReason: null,
    branchWillBeRetained: false,
    branchProof: { pr: 60 },
    row: { verdict: "Safe" },
  });
  const result = await actions.executeRemoval(plan, { [proven.id]: { include: true } });
  expect(result.items).toEqual([{ id: proven.id, status: "removed", branchOutcome: "deleted" }]);
  expect(await exists(built.path!)).toBe(false);
  expect(await branches(repo)).toEqual(["main"]);
  expect(await logged(built)).toEqual([
    { flags: ["-D"], exitCode: 0, branchOutcome: "deleted", branchProof: { pr: 60 }, error: null },
  ]);
});

test("a worktree proven merged on GitHub that gains a commit after confirmation is skipped, and its branch kept", async () => {
  const repo = await sandbox.repo("moved");
  const built = await repo.unmergedWorktree("feature");
  const { dashboard, actions } = await sandbox.services();
  const proven = provenOnGitHub(row(await scan(dashboard, repo), built), 61);
  const plan = await actions.prepareRemoval([proven]);
  expect(plan.entries[0]?.branchProof).toEqual({ pr: 61 });

  await writeFile(join(built.path!, "later.txt"), "later\n");
  await sandbox.git(built.path!, "add", "later.txt");
  await sandbox.git(built.path!, "commit", "-q", "-m", "Later");
  const moved = await sandbox.git(built.path!, "rev-parse", "HEAD");

  const result = await actions.executeRemoval(plan, { [proven.id]: { include: true } });
  expect(result.items).toEqual([
    { id: proven.id, status: "skipped", error: "it changed; refresh and preview again" },
  ]);
  expect(await exists(built.path!)).toBe(true);
  expect(await repo.git("rev-parse", "refs/heads/feature")).toBe(moved);
  expect(await logged(built)).toEqual([]);
});

test("a branch without a worktree that GitHub proves merged is deleted without D", async () => {
  const repo = await sandbox.repo("leftover");
  const built = await repo.unmergedBranch("leftover");
  const { dashboard, actions } = await sandbox.services();
  const shown = row(await scan(dashboard, repo), built);
  expect(shown.verdict).toBe("Review");
  const proven = provenOnGitHub(shown, 62);
  expect(proven.verdict).toBe("Safe");

  const plan = await actions.prepareRemoval([proven]);
  expect(plan.entries[0]).toMatchObject({
    blockedReason: null,
    branchWillBeRetained: false,
    branchProof: { pr: 62 },
  });
  const result = await actions.executeRemoval(plan, { [proven.id]: { include: true } });
  expect(result.items).toEqual([{ id: proven.id, status: "removed", branchOutcome: "deleted" }]);
  expect(await branches(repo)).toEqual(["main"]);
  expect(await logged(built)).toEqual([
    { flags: ["-D"], exitCode: 0, branchOutcome: "deleted", branchProof: { pr: 62 }, error: null },
  ]);
});

import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RemovalChoice, RemovalPlan, RemovalResult } from "../../src/core/removal/types";
import type { WorktreeRow } from "../../src/core/types";
import {
  createSandbox,
  type Built,
  type Repo,
  type Sandbox,
  TEST_TIMEOUT,
} from "../support/fixture";
import { named, on, record, type Gate, type Match, type Recorder } from "../support/runners";
import { exists, row, scan } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = await createSandbox();
});

afterAll(() => sandbox?.cleanup());

const CHANGED = "it changed; refresh and preview again";
const FILES_CHANGED = "Local files changed since preview";
const MISSING_BRANCH = "it is missing or now has a worktree";

/** The branch's commit, or null when it doesn't exist. */
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

async function commit(cwd: string, file: string): Promise<void> {
  await writeFile(join(cwd, file), `${file}\n`);
  await sandbox.git(cwd, "add", file);
  await sandbox.git(cwd, "commit", "-q", "-m", `Add ${file}`);
}

interface Preview {
  recorder: Recorder;
  rows: WorktreeRow[];
  plan: RemovalPlan;
  execute(choice?: Omit<RemovalChoice, "include">): Promise<RemovalResult>;
}

async function preview(repo: Repo, built: Built[]): Promise<Preview> {
  const recorder = record(sandbox.runner);
  const { dashboard, actions } = await sandbox.services({ runner: recorder.runner });
  const snapshot = await scan(dashboard, repo);
  const rows = built.map((one) => row(snapshot, one));
  expect(rows.map((shown) => shown.verdict)).toEqual(built.map((one) => one.expected.verdict));
  const plan = await actions.prepareRemoval(rows);
  expect(plan.entries.map((entry) => entry.blockedReason)).toEqual(rows.map(() => null));
  return {
    recorder,
    rows,
    plan,
    execute: (choice = {}) =>
      actions.executeRemoval(
        plan,
        Object.fromEntries(rows.map((shown) => [shown.id, { include: true, ...choice }])),
      ),
  };
}

async function whileHeld(
  recorder: Recorder,
  match: Match,
  run: () => Promise<RemovalResult>,
  change: () => Promise<void>,
): Promise<RemovalResult> {
  const gate: Gate = recorder.gate(match);
  const result = run();
  try {
    await Promise.race([
      gate.reached,
      result.then((done) => {
        throw new Error(`The batch ended without reaching the gate: ${JSON.stringify(done.items)}`);
      }),
    ]);
    await change();
  } finally {
    gate.release();
  }
  return result;
}

/** The batch's recheck of `repo`, which runs after its listing and just before `wt remove`. */
const recheck = (repo: Repo) => on(named("git", "worktree", "list"), repo.path);

type Timing = "after the preview" | "after the batch listed the repo";
const TIMINGS: Timing[] = ["after the preview", "after the batch listed the repo"];

async function confirmAround(
  repo: Repo,
  built: Built,
  timing: Timing,
  change: () => Promise<void>,
  choice?: Omit<RemovalChoice, "include">,
) {
  const shown = await preview(repo, [built]);
  let result: RemovalResult;
  if (timing === "after the preview") {
    await change();
    result = await shown.execute(choice);
  } else
    result = await whileHeld(shown.recorder, recheck(repo), () => shown.execute(choice), change);
  return { ...shown, result };
}

const skipped = (shown: WorktreeRow, error: string): RemovalResult["items"] => [
  { id: shown.id, status: "skipped", error },
];

interface WorktreeCase {
  name: string;
  build(repo: Repo, branch: string): Promise<Built>;
  change(repo: Repo, built: Built): Promise<void>;
  choice?: Omit<RemovalChoice, "include">;
  reason: Record<Timing, string>;
}

const worktreeCases: WorktreeCase[] = [
  {
    name: "HEAD moved: a new commit in the worktree",
    build: (repo, branch) => repo.squashMergedWorktree(branch),
    change: (_, built) => commit(built.path!, "later.txt"),
    reason: { "after the preview": CHANGED, "after the batch listed the repo": CHANGED },
  },
  {
    // Another untracked file leaves Worktrunk's change flags as they were, so only the file list differs.
    name: "files changed: a new untracked file in a worktree already dirty",
    build: (repo, branch) => repo.dirtyWorktree(branch),
    change: (_, built) => writeFile(join(built.path!, "later.txt"), "later\n"),
    choice: { discardChanges: true },
    reason: {
      "after the preview": FILES_CHANGED,
      "after the batch listed the repo": FILES_CHANGED,
    },
  },
  {
    name: "files changed: an edit in a worktree that was clean",
    build: (repo, branch) => repo.squashMergedWorktree(branch),
    change: (_, built) => writeFile(join(built.path!, "README.md"), "Edited after the preview\n"),
    reason: { "after the preview": CHANGED, "after the batch listed the repo": FILES_CHANGED },
  },
  {
    name: "the worktree got locked",
    build: (repo, branch) => repo.squashMergedWorktree(branch),
    change: async (repo, built) => {
      await repo.git("worktree", "lock", "--reason", "agent busy", built.path!);
    },
    reason: {
      "after the preview": CHANGED,
      "after the batch listed the repo": "it's locked (agent busy); unlock it first",
    },
  },
];

for (const item of worktreeCases)
  for (const timing of TIMINGS)
    test(`${item.name}, ${timing}: skipped, folder and branch kept (README: every removal is checked again)`, async () => {
      const repo = await sandbox.repo(
        `wt-${worktreeCases.indexOf(item)}-${TIMINGS.indexOf(timing)}`,
      );
      const built = await item.build(repo, "target");
      const { recorder, rows, result } = await confirmAround(
        repo,
        built,
        timing,
        () => item.change(repo, built),
        item.choice,
      );
      expect(result.items).toEqual(skipped(rows[0]!, item.reason[timing]));
      expect(recorder.count(named("wt", "remove"))).toBe(0);
      expect(await exists(built.path!)).toBe(true);
      expect(await tip(repo, "target")).toBe(await sandbox.git(built.path!, "rev-parse", "HEAD"));
    });

async function recreate(repo: Repo, built: Built): Promise<void> {
  await repo.git("worktree", "remove", built.path!);
  expect(await exists(built.path!)).toBe(false);
  await repo.git("worktree", "add", "-q", built.path!, built.branch);
}

test('removed and recreated at the same path, after the preview: skipped as "it changed" (README: created again at the same path)', async () => {
  const repo = await sandbox.repo("recreated-preview");
  const built = await repo.squashMergedWorktree("target");
  const { recorder, rows, result } = await confirmAround(repo, built, "after the preview", () =>
    recreate(repo, built),
  );
  // Same path, branch and commit: only the record's creation time tells the new worktree apart.
  expect(result.items).toEqual(skipped(rows[0]!, CHANGED));
  expect(recorder.count(named("wt", "remove"))).toBe(0);
  expect(await exists(built.path!)).toBe(true);
  expect(await tip(repo, "target")).not.toBeNull();
});

test('removed and recreated at the same path, after the batch listed the repo: skipped as "it changed" (#22)', async () => {
  const repo = await sandbox.repo("recreated-listed");
  const built = await repo.squashMergedWorktree("target");
  const { recorder, rows, result } = await confirmAround(
    repo,
    built,
    "after the batch listed the repo",
    () => recreate(repo, built),
  );
  expect(result.items).toEqual(skipped(rows[0]!, CHANGED));
  expect(recorder.count(named("wt", "remove"))).toBe(0);
  expect(await exists(built.path!)).toBe(true);
  expect(await tip(repo, "target")).not.toBeNull();
});

type MergeTiming = "after the preview" | "while an earlier removal in the batch runs";

interface MergeCase {
  name: string;
  build(repo: Repo): Promise<Built>;
  change(repo: Repo, built: Built): Promise<void>;
}

/** Gives main an upstream. */
async function withOrigin(repo: Repo): Promise<void> {
  const remote = join(sandbox.root, "remotes", `${repo.name}.git`);
  await sandbox.git(sandbox.root, "init", "-q", "--bare", remote);
  await repo.git("remote", "add", "origin", remote);
  await repo.git("push", "-q", "-u", "origin", "main");
}

const mergeCases: MergeCase[] = [
  {
    name: "the default branch moved: the branch got merged into main",
    build: (repo) => repo.unmergedWorktree("target"),
    change: async (repo) => {
      await repo.git("merge", "-q", "--no-ff", "-m", "Merge target", "target");
    },
  },
  {
    name: "the default branch's upstream moved: origin/main now holds the branch",
    build: async (repo) => {
      await withOrigin(repo);
      return repo.unmergedWorktree("target");
    },
    change: async (_, built) => {
      await sandbox.git(built.path!, "push", "-q", "origin", "target:main");
    },
  },
  {
    name: "the branch's upstream moved: its last commit got pushed",
    build: (repo) => repo.unpushedWorktree("target"),
    change: async (_, built) => {
      await sandbox.git(built.path!, "push", "-q");
    },
  },
];

for (const item of mergeCases)
  for (const timing of [
    "after the preview",
    "while an earlier removal in the batch runs",
  ] as MergeTiming[])
    test(`${item.name}, ${timing}: skipped as "it changed" (README: merge status is checked again)`, async () => {
      const repo = await sandbox.repo(`merge-${mergeCases.indexOf(item)}-${timing.length}`);
      const first = await repo.squashMergedWorktree("first");
      const built = await item.build(repo);
      const before = await preview(repo, [first, built]);
      const [firstRow, target] = before.rows as [WorktreeRow, WorktreeRow];
      let result: RemovalResult;
      if (timing === "after the preview") {
        await item.change(repo, built);
        result = await before.execute();
      } else
        result = await whileHeld(
          before.recorder,
          on(named("wt", "remove"), first.path!),
          () => before.execute(),
          () => item.change(repo, built),
        );
      expect(result.items).toEqual([
        { id: firstRow.id, status: "removed", branchOutcome: "deleted" },
        { id: target.id, status: "skipped", error: CHANGED },
      ]);
      expect(
        before.recorder.calls.filter(named("wt", "remove")).map((call) => call.args.at(-1)),
      ).toEqual([first.path!]);
      expect(await exists(built.path!)).toBe(true);
      expect(await tip(repo, "target")).toBe(await sandbox.git(built.path!, "rev-parse", "HEAD"));
    });

interface BranchCase {
  name: string;
  change(repo: Repo, built: Built): Promise<void>;
  reason: string;
  /** The branch's commit after the change, or null when it is gone. */
  after(repo: Repo, before: string): Promise<string | null>;
}

const branchCases: BranchCase[] = [
  {
    name: "a leftover branch moved",
    change: async (repo, built) => {
      await repo.git("branch", "-f", built.branch, "main");
    },
    reason: CHANGED,
    after: (repo) => repo.git("rev-parse", "main"),
  },
  {
    name: "a leftover branch was deleted",
    change: async (repo, built) => {
      await repo.git("branch", "-D", built.branch);
    },
    reason: MISSING_BRANCH,
    after: async () => null,
  },
  {
    name: "a leftover branch now has a worktree",
    change: async (repo, built) => {
      await repo.git("worktree", "add", "-q", checkout(built), built.branch);
    },
    reason: MISSING_BRANCH,
    after: async (_, before) => before,
  },
];

const checkout = (built: Built) => join(sandbox.root, "worktrees", `${built.branch}-checkout`);

for (const item of branchCases)
  for (const timing of TIMINGS)
    test(`${item.name}, ${timing}: skipped as "${item.reason}" (README: a branch without a worktree is skipped)`, async () => {
      const repo = await sandbox.repo(
        `branch-${branchCases.indexOf(item)}-${TIMINGS.indexOf(timing)}`,
      );
      const built = await repo.mergedBranch(`leftover-${TIMINGS.indexOf(timing)}`);
      const before = (await tip(repo, built.branch))!;
      const { recorder, rows, result } = await confirmAround(repo, built, timing, () =>
        item.change(repo, built),
      );
      expect(result.items).toEqual(skipped(rows[0]!, item.reason));
      expect(recorder.count(named("wt", "remove"))).toBe(0);
      expect(await tip(repo, built.branch)).toBe(await item.after(repo, before));
      if (item.reason === MISSING_BRANCH && (await item.after(repo, before)))
        expect(await exists(checkout(built))).toBe(true);
    });

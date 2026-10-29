import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assess } from "../../src/core/assess";
import type { WorktreeRow } from "../../src/core/types";
import {
  createSandbox,
  type Built,
  type Repo,
  type Sandbox,
  type Services,
  TEST_TIMEOUT,
} from "../support/fixture";
import { named, on, record } from "../support/runners";
import { branches, exists, logFor, row, scan } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

let sandbox: Sandbox;
let services: Services;
const repos: Record<string, Repo> = {};
const built: Record<string, Built> = {};
let picks: string[];
let hookRan: string;

async function commit(cwd: string, file: string, content: string): Promise<string> {
  await writeFile(join(cwd, file), content);
  await sandbox.git(cwd, "add", file);
  await sandbox.git(cwd, "commit", "-q", "-m", `Change ${file}`);
  return sandbox.git(cwd, "rev-parse", "HEAD");
}

async function cherryPickable(repo: Repo): Promise<[Built, string[]]> {
  const worktree = (await repo.unmergedWorktree("pick")).path!;
  await commit(worktree, "shared.txt", "ours\n");
  await sandbox.git(worktree, "checkout", "-q", "--detach", "main");
  const conflicting = await commit(worktree, "shared.txt", "theirs\n");
  const clean = await commit(worktree, "extra.txt", "extra\n");
  await sandbox.git(worktree, "checkout", "-q", "pick");
  const pick: Built = {
    kind: "worktree",
    repo: repo.path,
    path: worktree,
    branch: "pick",
    expected: {
      verdict: "Review",
      status: "unmerged commits",
      reason: "2 commits aren't in main.",
      blocked: false,
    },
  };
  return [pick, [conflicting, clean]];
}

/** Resolves the conflict and commits, which leaves only sequencer/ behind with the second pick still to do. */
async function stopCherryPick(worktree: string): Promise<void> {
  const result = await sandbox.exec("git", ["cherry-pick", ...picks], { cwd: worktree });
  if (result.exitCode === 0) throw new Error("cherry-pick did not stop");
  await writeFile(join(worktree, "shared.txt"), "resolved\n");
  await sandbox.git(worktree, "add", "shared.txt");
  await sandbox.git(worktree, "commit", "-q", "--no-edit");
  const marker = (name: string) =>
    sandbox.git(worktree, "rev-parse", "--path-format=absolute", "--git-path", name);
  expect([
    await exists(await marker("sequencer")),
    await exists(await marker("CHERRY_PICK_HEAD")),
  ]).toEqual([true, false]);
}

beforeAll(async () => {
  sandbox = await createSandbox();
  hookRan = join(sandbox.root, "hook-ran");
  const setUp = async (name: string, build: (repo: Repo) => Promise<void>) => {
    repos[name] = await sandbox.repo(name);
    await build(repos[name]);
  };
  await Promise.all([
    setUp("sequential", async (repo) => {
      built.first = await repo.squashMergedWorktree("first");
      built.second = await repo.squashMergedWorktree("second");
    }),
    setUp("named", async (repo) => {
      built.wtB = await repo.mergedBranch("wt-b");
      await repo.git("worktree", "add", "-q", "-b", "other", join(repo.path, "wt-b"));
    }),
    setUp("picking", async (repo) => {
      [built.pick, picks] = await cherryPickable(repo);
    }),
    setUp("leftover", async (repo) => {
      built.gone = await repo.mergedBranch("gone");
      built.kept = await repo.unmergedBranch("kept");
    }),
    setUp("blocked", async (repo) => {
      built.locked = await repo.lockedWorktree("locked", { reason: "agent busy" });
      built.rebasing = await repo.rebasingWorktree("rebasing");
      built.deleted = await repo.deletedWorktree("deleted");
    }),
    setUp("dirty", async (repo) => {
      built.dirty = await repo.dirtyWorktree("dirty");
      await mkdir(join(built.dirty.path!, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(built.dirty.path!, "node_modules", "pkg", "index.js"), "export {};\n");
    }),
    setUp("hooked", async (repo) => {
      await mkdir(join(repo.path, ".config"));
      await commit(repo.path, ".config/wt.toml", `pre-remove = "touch '${hookRan}'"\n`);
      built.hooked = await repo.squashMergedWorktree("hooked");
    }),
  ]);
  services = await sandbox.services();
}, 30_000);

afterAll(() => sandbox?.cleanup());

const include = (rows: WorktreeRow[], choice: object = {}) =>
  Object.fromEntries(rows.map((shown) => [shown.id, { include: true, ...choice }]));

test("stops a removal when an agent marks its worktree during the batch (#18)", async () => {
  const recorder = record(sandbox.runner);
  const { dashboard, actions } = await sandbox.services({ runner: recorder.runner });
  const snapshot = await scan(dashboard, repos.sequential!);
  const [first, second] = [row(snapshot, built.first!), row(snapshot, built.second!)];
  expect([first.verdict, second.verdict]).toEqual(["Safe", "Safe"]);
  const plan = await actions.prepareRemoval([first, second]);
  const removing = recorder.gate(named("wt", "remove"));
  const result = actions.executeRemoval(plan, include([first, second]));
  try {
    expect((await removing.reached).args.at(-1)).toBe(first.path!);
    await sandbox.wt(second.path!, "config", "state", "marker", "set", "🤖");
  } finally {
    removing.release();
  }
  expect((await result).items).toEqual([
    { id: first.id, status: "removed", branchOutcome: "deleted" },
    {
      id: second.id,
      status: "skipped",
      error: "an agent started work here; refresh and preview again",
    },
  ]);
  expect([await exists(first.path!), await exists(second.path!)]).toEqual([false, true]);
  expect(await branches(repos.sequential!)).toEqual(["main", "second"]);
});

test("skips a branch whose name is also a worktree folder, which wt remove would delete instead (#18)", async () => {
  const repo = repos.named!;
  const shown = row(await scan(services.dashboard, repo), built.wtB!);
  expect([shown.verdict, shown.reason]).toEqual(["Safe", "Its commits are already in main."]);
  const plan = await services.actions.prepareRemoval([shown]);
  expect(plan.entries[0]!.blockedReason).toBeNull();
  expect((await services.actions.executeRemoval(plan, include([shown]))).items).toEqual([
    {
      id: shown.id,
      status: "skipped",
      error:
        "a worktree folder has the same name, so Worktrunk would remove that instead; delete it with git branch",
    },
  ]);
  expect(await exists(join(repo.path, "wt-b"))).toBe(true);
  expect(await branches(repo)).toEqual(["main", "other", "wt-b"]);
});

test("skips a worktree left mid cherry-pick with only sequencer/ (#6)", async () => {
  const recorder = record(sandbox.runner);
  const { dashboard, actions } = await sandbox.services({ runner: recorder.runner });
  const shown = row(await scan(dashboard, repos.picking!), built.pick!);
  expect([shown.verdict, assess(shown).status, shown.reason]).toEqual([
    "Review",
    "unmerged commits",
    "2 commits aren't in main.",
  ]);
  const plan = await actions.prepareRemoval([shown]);
  expect(plan.entries[0]!.blockedReason).toBeNull();
  const recheck = recorder.gate(on(named("git", "worktree", "list"), repos.picking!.path));
  const result = actions.executeRemoval(plan, include([shown]));
  try {
    await recheck.reached;
    await stopCherryPick(shown.path!);
  } finally {
    recheck.release();
  }
  expect((await result).items).toEqual([
    { id: shown.id, status: "skipped", error: "finish or abort the cherry-pick first" },
  ]);
  expect(await exists(shown.path!)).toBe(true);
});

test("removes a merged leftover branch, and an unmerged one only when D is pressed (#18)", async () => {
  const repo = repos.leftover!;
  const snapshot = await scan(services.dashboard, repo);
  const [gone, kept] = [row(snapshot, built.gone!), row(snapshot, built.kept!)];
  expect([gone.verdict, kept.verdict]).toEqual(["Safe", "Review"]);
  const plan = await services.actions.prepareRemoval([gone, kept]);
  expect(plan.entries.map((entry) => [entry.blockedReason, entry.branchWillBeRetained])).toEqual([
    [null, false],
    [null, true],
  ]);
  expect((await services.actions.executeRemoval(plan, include([gone, kept]))).items).toEqual([
    { id: gone.id, status: "removed", branchOutcome: "deleted" },
    { id: kept.id, status: "skipped", error: "Deleting the unmerged branch was not confirmed" },
  ]);
  expect(await branches(repo)).toEqual(["kept", "main"]);

  const again = row(await scan(services.dashboard, repo), built.kept!);
  const forced = await services.actions.prepareRemoval([again]);
  expect(
    (await services.actions.executeRemoval(forced, include([again], { forceDeleteBranch: true })))
      .items,
  ).toEqual([{ id: again.id, status: "removed", branchOutcome: "deleted" }]);
  expect(await branches(repo)).toEqual(["main"]);
  const logged = [...(await logFor(sandbox, built.gone!)), ...(await logFor(sandbox, built.kept!))];
  expect(
    logged.map(({ flags, exitCode, branchOutcome, error }) => ({
      flags,
      exitCode,
      branchOutcome,
      error,
    })),
  ).toEqual([
    { flags: [], exitCode: 0, branchOutcome: "deleted", error: null },
    { flags: ["-D"], exitCode: 0, branchOutcome: "deleted", error: null },
  ]);
});

test("blocks removing locked, mid-rebase and missing worktrees, and prunes the missing one", async () => {
  const repo = repos.blocked!;
  const snapshot = await scan(services.dashboard, repo);
  const rows = [built.locked!, built.rebasing!, built.deleted!].map((one) => row(snapshot, one));
  expect(rows.map((shown) => [shown.verdict, assess(shown).status, shown.reason])).toEqual([
    ["Review", "locked", "Locked: agent busy"],
    ["Busy", "rebase in progress", "A rebase was started here and isn't finished."],
    ["Broken", "folder missing", "The folder is gone, but Git still lists the worktree."],
  ]);
  const plan = await services.actions.prepareRemoval(rows);
  const reasons = [
    "it's locked (agent busy); unlock it first",
    "finish or abort the rebase first",
    "the folder is gone; prune it instead",
  ];
  expect(plan.entries.map((entry) => entry.blockedReason)).toEqual(reasons);
  expect(
    (await services.actions.executeRemoval(plan, include(rows, { discardChanges: true }))).items,
  ).toEqual(
    rows.map((shown, index) => ({ id: shown.id, status: "skipped", error: reasons[index] })),
  );
  expect([await exists(rows[0]!.path!), await exists(rows[1]!.path!)]).toEqual([true, true]);

  const prune = await services.actions.preparePrune(repo.path);
  expect(prune.records).toEqual([
    "Removing worktrees/blocked.deleted: gitdir file points to non-existent location",
  ]);
  await services.actions.executePrune(prune);
  const listed = (await repo.git("worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice(9));
  expect(listed).toEqual([repo.path, rows[0]!.path!, rows[1]!.path!]);
});

test("removes a dirty worktree only once discarding its files is confirmed", async () => {
  const shown = row(await scan(services.dashboard, repos.dirty!), built.dirty!);
  expect([shown.verdict, shown.reason]).toEqual([
    built.dirty!.expected.verdict,
    built.dirty!.expected.reason,
  ]);
  const plan = await services.actions.prepareRemoval([shown]);
  const { row: _, ...preview } = plan.entries[0]!;
  expect(preview).toEqual({
    blockedReason: null,
    requiresDiscard: true,
    branchWillBeRetained: false,
    localFiles: [" M README.md", "?? notes.txt"],
    ignoredFiles: [],
    disposableIgnored: 1,
  });
  expect((await services.actions.executeRemoval(plan, include([shown]))).items).toEqual([
    { id: shown.id, status: "skipped", error: "Discarding local files was not confirmed" },
  ]);
  expect(await exists(shown.path!)).toBe(true);

  const confirmed = await services.actions.prepareRemoval([shown]);
  expect(
    (await services.actions.executeRemoval(confirmed, include([shown], { discardChanges: true })))
      .items,
  ).toEqual([{ id: shown.id, status: "removed", branchOutcome: "deleted" }]);
  expect(await exists(shown.path!)).toBe(false);
  expect((await logFor(sandbox, built.dirty!)).map((line) => line.flags)).toEqual([["-f"]]);
});

test("removes a worktree without running the project's Worktrunk hooks", async () => {
  const shown = row(await scan(services.dashboard, repos.hooked!), built.hooked!);
  const plan = await services.actions.prepareRemoval([shown]);
  expect((await services.actions.executeRemoval(plan, include([shown]))).items).toEqual([
    { id: shown.id, status: "removed", branchOutcome: "deleted" },
  ]);
  expect(await exists(shown.path!)).toBe(false);
  expect(await exists(hookRan)).toBe(false);
});

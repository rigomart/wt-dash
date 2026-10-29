import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assess, markerNote } from "../../src/core/assess";
import { createDashboardService } from "../../src/core/scan/dashboard";
import { readCreatedAt } from "../../src/core/scan/discovery";
import type { WorktreeRow } from "../../src/core/types";
import {
  createSandbox,
  type Built,
  type Expected,
  type Repo,
  type Sandbox,
  TEST_TIMEOUT,
} from "../support/fixture";
import { named } from "../support/runners";
import { row, timeline } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Made before the tests are declared, so the tests it can't support are reported as skipped.
const sandbox: Sandbox = await createSandbox();
let verdicts: Repo;
let marks: Repo;
let aged: Repo;
let built: Record<string, Built>;

beforeAll(async () => {
  [verdicts, marks, aged] = await Promise.all(
    ["verdicts", "marks", "aged"].map((name) => sandbox.repo(name)),
  );
  const [squashed, merged, recent, fresh] = await (async () => [
    await verdicts.squashMergedWorktree("squashed"),
    await verdicts.mergedWorktree("merged"),
    await verdicts.mergedWorktree("recent", { ageMs: 2 * 60 * MINUTE }),
    await verdicts.freshWorktree("fresh"),
  ])();
  const working = await marks.markedWorktree("working", { marker: "🤖", ageMs: 20 * MINUTE });
  const stale = await marks.markedWorktree("stale", { marker: "🤖", ageMs: 28 * DAY });
  const waiting = await marks.mergedBranch("waiting");
  await sandbox.exec(
    sandbox.wtPath,
    ["config", "state", "marker", "set", "💬", "--branch", "waiting"],
    {
      cwd: marks.path,
      env: { WORKTRUNK_TEST_EPOCH: String(Math.floor((Date.now() - 5 * MINUTE) / 1000)) },
    },
  );
  const touched = await aged.mergedWorktree("touched");
  built = {
    squashed: squashed!,
    merged: merged!,
    recent: recent!,
    fresh: fresh!,
    working,
    stale,
    waiting: {
      ...waiting,
      expected: {
        ...waiting.expected,
        verdict: "Review",
        reason: "An agent was waiting for input here 5m ago.",
        note: "An agent was waiting for input here 5m ago.",
      },
    },
    touched,
  };
}, 30_000);

afterAll(() => sandbox.cleanup());

function judged(shown: WorktreeRow): Expected {
  const assessment = assess(shown);
  return {
    verdict: shown.verdict,
    status: assessment.status,
    reason: shown.reason,
    blocked: assessment.removalBlockReason !== null,
    note: markerNote(shown) ?? undefined,
  };
}

const target = (event: { args: string[] }) => event.args[event.args.indexOf("-C") + 1];

test("lists the first project's worktrees alone, then every project's worktrees before any branches (#20)", async () => {
  const { runner, events } = timeline(sandbox.runner);
  const { dashboard } = await sandbox.services({ runner });
  await dashboard.refresh();
  expect(dashboard.getSnapshot().progress.phase).toBe("complete");
  const lists = events
    .filter(named("wt", "list"))
    .map(
      (event) =>
        `${event.phase} ${event.args.includes("--branches") ? "full" : "quick"} ${target(event)}`,
    );
  const quick = [verdicts, marks, aged].flatMap((repo) => [
    `start quick ${repo.path}`,
    `end quick ${repo.path}`,
  ]);
  expect(lists.slice(0, 2)).toEqual([`start quick ${verdicts.path}`, `end quick ${verdicts.path}`]);
  expect(lists.slice(0, quick.length).sort()).toEqual(quick.sort());
  expect(lists.slice(quick.length).sort()).toEqual(
    [verdicts, marks, aged]
      .flatMap((repo) => [`start full ${repo.path}`, `end full ${repo.path}`])
      .sort(),
  );
});

test("a worktree with nothing beyond main stays Review for its first day (#16)", async () => {
  const { dashboard } = await sandbox.services();
  await dashboard.refresh([verdicts.path]);
  const snapshot = dashboard.getSnapshot();
  for (const name of ["squashed", "merged", "recent", "fresh"]) {
    const { note: _, ...expected } = built[name]!.expected;
    const { note, ...shown } = judged(row(snapshot, built[name]!));
    expect({ name, ...shown }).toEqual({ name, ...expected });
    expect(note).toBeUndefined();
  }
  expect(built.recent!.expected.reason).toBe("Created 2h ago, so it may still be in use.");
  expect(built.fresh!.expected.reason).toBe("Created just now, so it may still be in use.");
});

test.skipIf(!sandbox.backdatesOnDisk)(
  "a worktree's age comes from when Git created its record, not when Git last wrote to it (#16)",
  async () => {
    const worktree = built.touched!.path!;
    const gitdir = resolve(
      worktree,
      /^gitdir: (.+)$/m.exec(await readFile(join(worktree, ".git"), "utf8"))![1]!,
    );
    await sandbox.git(worktree, "checkout", "-q", "--detach");
    await sandbox.git(worktree, "checkout", "-q", "touched");
    expect(Date.now() - (await stat(gitdir)).mtimeMs).toBeLessThan(MINUTE);
    const { sizes } = await sandbox.services();
    // The birth time macOS keeps on disk, without the sandbox's backdating fallback.
    const dashboard = createDashboardService({
      projectRoot: sandbox.scanRoot,
      wtPath: sandbox.wtPath,
      runner: sandbox.runner,
      sizeService: sizes,
    });
    try {
      await dashboard.refresh([aged.path]);
      const { note: _, ...shown } = judged(row(dashboard.getSnapshot(), built.touched!));
      expect(shown).toEqual({
        verdict: "Safe",
        status: "merged",
        reason: "Its commits are already in main.",
        blocked: false,
      });
    } finally {
      await dashboard.close();
    }
  },
);

test("an agent mark from the last day keeps a merged worktree or branch out of Safe (#18)", async () => {
  const { dashboard } = await sandbox.services();
  await dashboard.refresh([marks.path]);
  const snapshot = dashboard.getSnapshot();
  expect(built.working!.expected.reason).toBe("An agent was working here 20m ago.");
  expect(built.stale!.expected).toMatchObject({
    verdict: "Safe",
    note: "Agent mark from 28d ago, likely stale.",
  });
  for (const name of ["working", "stale", "waiting"]) {
    const { expected } = built[name]!;
    expect({ name, ...judged(row(snapshot, built[name]!)) }).toEqual({ name, ...expected });
  }
  expect(snapshot.rows.filter((shown) => shown.repoPath === marks.path)).toHaveLength(3);
});

test("readCreatedAt reads when Git created a worktree's record, which later writes don't move, or null without a birth time", async () => {
  const repo = await sandbox.repo("born");
  const path = join(sandbox.root, "worktrees", "born.new");
  const before = Date.now();
  await repo.git("worktree", "add", "-q", "-b", "new", path, "main");
  const after = Date.now();
  const created = await readCreatedAt(path);
  if (process.platform === "darwin") expect(created).not.toBeNull();
  if (created !== null) {
    // File systems stamp times from a clock that can trail Date.now() by a tick.
    expect(Date.parse(created)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(created)).toBeLessThanOrEqual(after);
  }
  // A checkout rewrites HEAD in the record, moving its mtime and ctime.
  await sandbox.git(path, "checkout", "-q", "--detach");
  expect(await readCreatedAt(path)).toBe(created);
  expect(await readCreatedAt(repo.path)).toBeNull();
});

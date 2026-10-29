import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assess, markerNote } from "../../src/core/assess";
import { readCreatedAt } from "../../src/core/discovery";
import type { DashboardService, DashboardSnapshot } from "../../src/core/types";
import { createSandbox, findRow, OLD_AGE_MS, type Built, type Repo, type Sandbox } from "./fixture";

let sandbox: Sandbox;
let builds: Array<[string, Built]>;

beforeAll(async () => {
  sandbox = await createSandbox();
  const one = async (name: string, build: (repo: Repo) => Promise<Built>) =>
    [name, await build(await sandbox.repo(name))] as [string, Built];
  const [mixed, ...single] = await Promise.all([
    sandbox.repo("mixed"),
    one("merged", (repo) => repo.mergedWorktree("feature/merged")),
    one("squashed", (repo) => repo.squashMergedWorktree("feature/squashed")),
    one("fresh", (repo) => repo.freshWorktree("feature/fresh")),
    one("dirty", (repo) => repo.dirtyWorktree("feature/dirty")),
    one("unmerged", (repo) => repo.unmergedWorktree("feature/unmerged", { commits: 2 })),
    one("unpushed", (repo) => repo.unpushedWorktree("feature/unpushed")),
    one("locked", (repo) => repo.lockedWorktree("feature/locked")),
    one("locked-bare", (repo) => repo.lockedWorktree("feature/locked-bare", { reason: null })),
    one("rebasing", (repo) => repo.rebasingWorktree("feature/rebasing")),
    one("conflicted", (repo) => repo.conflictedWorktree("feature/conflicted")),
    one("deleted", (repo) => repo.deletedWorktree("feature/deleted")),
    one("working", (repo) => repo.markedWorktree("agent/working", { marker: "🤖" })),
    one("waiting", (repo) => repo.markedWorktree("agent/waiting", { marker: "💬" })),
    one("stale", (repo) => repo.markedWorktree("agent/stale", { marker: "🤖", ageMs: OLD_AGE_MS })),
    one("sized", (repo) => repo.sizedWorktree("feature/sized", { kib: 1536 })),
    one("merged-branch", (repo) => repo.mergedBranch("leftover/merged")),
    one("unmerged-branch", (repo) => repo.unmergedBranch("leftover/unmerged")),
  ]);
  const shared: Array<[string, Built]> = [];
  for (const [name, build] of [
    ["mixed squashed", () => mixed.squashMergedWorktree("squashed")],
    ["mixed merged branch", () => mixed.mergedBranch("merged-branch")],
    ["mixed fresh", () => mixed.freshWorktree("fresh")],
    ["mixed unmerged", () => mixed.unmergedWorktree("unmerged")],
    ["mixed unmerged branch", () => mixed.unmergedBranch("unmerged-branch")],
    ["mixed dirty", () => mixed.dirtyWorktree("dirty")],
    ["mixed locked", () => mixed.lockedWorktree("locked")],
  ] as const)
    shared.push([name, await build()]);
  builds = [...(single as Array<[string, Built]>), ...shared];
}, 30_000);

afterAll(() => sandbox?.cleanup());

function waitFor(
  service: DashboardService,
  predicate: (snapshot: DashboardSnapshot) => boolean,
): Promise<DashboardSnapshot> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("snapshot timeout"));
    }, 10_000);
    unsubscribe = service.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      queueMicrotask(unsubscribe);
      resolve(snapshot);
    });
  });
}

test("the real dashboard gives every built row the verdict and reason the fixture expects", async () => {
  const { dashboard } = await sandbox.services();
  await dashboard.refresh();
  const snapshot = dashboard.getSnapshot();
  expect(snapshot.progress.phase).toBe("complete");
  expect(snapshot.fatalError).toBeNull();
  expect(snapshot.errors).toEqual({});
  for (const [name, built] of builds) {
    const row = findRow(snapshot.rows, built);
    expect(row ? name : `${name}: no row`).toBe(name);
    const assessment = assess(row!);
    expect({ name, ...built.expected }).toEqual({
      name,
      verdict: row!.verdict,
      status: assessment.status,
      reason: row!.reason,
      blocked: assessment.removalBlockReason !== null,
      ...(built.expected.note === undefined ? {} : { note: markerNote(row!) ?? undefined }),
    });
    if (built.path !== null) expect(row!.path).toBe(built.path);
  }
  expect(snapshot.rows).toHaveLength(builds.length);
});

test("sizes come from du on the worktree's real files, node_modules included", async () => {
  const [, sized] = builds.find(([name]) => name === "sized")!;
  const { dashboard } = await sandbox.services();
  void dashboard.refresh();
  const snapshot = await waitFor(
    dashboard,
    (next) => (findRow(next.rows, sized)?.sizeKiB ?? 0) > 0,
  );
  expect(findRow(snapshot.rows, sized)!.sizeKiB!).toBeGreaterThanOrEqual(sized.minSizeKiB!);
});

test("an old worktree is old on disk where the file system allows it", async () => {
  const [, merged] = builds.find(([name]) => name === "merged")!;
  const real = Date.parse((await readCreatedAt(merged.path!))!);
  const seen = Date.parse((await sandbox.readCreated(merged.path!))!);
  expect(Date.now() - seen).toBeGreaterThan(OLD_AGE_MS - 60_000);
  if (process.platform === "darwin") expect(sandbox.backdatesOnDisk).toBe(true);
  if (sandbox.backdatesOnDisk) expect(real).toBe(seen);
});

test("commands see the sandbox's HOME and Git config, never the developer's", async () => {
  const result = await sandbox.runner("sh", [
    "-c",
    'printf "%s\\n" "$HOME" "$XDG_CONFIG_HOME" "$WORKTRUNK_CONFIG_PATH"; git config --global --show-origin user.email',
  ]);
  const [home, config, wtConfig, origin] = result.stdout.trim().split("\n");
  expect(home).toBe(sandbox.home);
  expect(config!.startsWith(sandbox.root)).toBe(true);
  expect(wtConfig!.startsWith(sandbox.root)).toBe(true);
  expect(origin).toBe(`file:${join(sandbox.root, "gitconfig")}\tsandbox@example.com`);
  expect(process.env.HOME).toBe(homedir());
  expect(sandbox.home).not.toBe(homedir());
});

test("a repo refuses a merging builder after one that needs main to stay put", async () => {
  const repo = await sandbox.repo("order");
  await repo.freshWorktree("fresh");
  await expect(repo.squashMergedWorktree("late")).rejects.toThrow("build it before freshWorktree");
});

test("cleanup removes the sandbox and worktrees its repos placed outside it", async () => {
  const other = await createSandbox();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "wt-dash-outside-")));
  try {
    const repo = await other.repo("repo");
    await repo.git("worktree", "add", "-q", "-b", "away", join(outside, "away"));
    await repo.git("worktree", "lock", join(outside, "away"));
    await other.cleanup();
    await other.cleanup();
    for (const path of [other.root, join(outside, "away")])
      expect(
        await stat(path).then(
          () => path,
          () => null,
        ),
      ).toBeNull();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

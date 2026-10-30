import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOrphans, orphanRow, readOrphanCause } from "../../src/core/scan/orphans";
import { ORPHANS } from "../../src/core/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "dash-orphans-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  return { root, home };
}

async function linked(folder: string, link: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, ".git"), link);
  return folder;
}

async function shell(folder: string, ...extra: string[]): Promise<string> {
  await mkdir(folder, { recursive: true });
  for (const name of [".codex-worktree-name", ...extra]) await writeFile(join(folder, name), "x\n");
  return folder;
}

test("finds folders whose Git record is gone in every agent location, and names the repository that held it", async () => {
  const { root, home } = await sandbox();
  const repo = join(root, "projects", "app");
  await mkdir(join(repo, ".git", "worktrees"), { recursive: true });
  const claude = await linked(
    join(repo, ".claude", "worktrees", "fix"),
    `gitdir: ${repo}/.git/worktrees/fix\n`,
  );
  const codex = await linked(
    join(home, ".codex", "worktrees", "abcd", "app"),
    `gitdir: ${root}/old/app/.git/worktrees/app\n`,
  );
  const t3 = await linked(
    join(home, ".t3", "worktrees", "app", "t3-1"),
    "gitdir: ../../../../bare/worktrees/t3-1\n",
  );
  const line = await linked(
    join(home, ".t3-lines", "lines", "worktrees", "line"),
    "gitdir: /nowhere/record\n",
  );

  const found = await findOrphans(home, [
    { path: repo, linked: { count: 0, paths: [], unread: [] } },
  ]);
  expect(Object.fromEntries(found.map((orphan) => [orphan.path, orphan.cause]))).toEqual({
    [claude]: {
      kind: "gitdirMissing",
      gitdir: `${repo}/.git/worktrees/fix`,
      repo,
      repoExists: true,
    },
    [codex]: {
      kind: "gitdirMissing",
      gitdir: `${root}/old/app/.git/worktrees/app`,
      repo: `${root}/old/app`,
      repoExists: false,
    },
    [t3]: {
      kind: "gitdirMissing",
      gitdir: `${home}/bare/worktrees/t3-1`,
      repo: `${home}/bare`,
      repoExists: false,
    },
    [line]: { kind: "gitdirMissing", gitdir: "/nowhere/record", repo: null, repoExists: false },
  });
  for (const orphan of found) expect(await readOrphanCause(orphan.path)).toEqual(orphan.cause);
});

test("a live worktree, a repository, an unreadable link, a symlink or a file is not an orphan", async () => {
  const { root, home } = await sandbox();
  const record = join(root, "elsewhere", ".git", "worktrees", "live");
  await mkdir(record, { recursive: true });
  const worktrees = join(home, ".codex", "worktrees", "abcd");
  await linked(join(worktrees, "live"), `gitdir: ${record}\n`);
  await mkdir(join(worktrees, "clone", ".git"), { recursive: true });
  await linked(join(worktrees, "garbled"), "not a gitdir line\n");
  await mkdir(join(worktrees, "plain"));
  const outside = await linked(join(root, "outside"), "gitdir: /nowhere/record\n");
  await symlink(outside, join(worktrees, "linked"));
  await writeFile(join(worktrees, "file"), "gitdir: /nowhere/record\n");

  expect(await findOrphans(home, [])).toEqual([]);
  for (const name of ["live", "clone", "garbled", "plain", "linked", "file", "missing"])
    expect(await readOrphanCause(join(worktrees, name))).toBeNull();
});

test("a Codex id folder holding only its name file is an empty shell, ignoring .DS_Store", async () => {
  const { home } = await sandbox();
  const codex = join(home, ".codex", "worktrees");
  const empty = await shell(join(codex, "aaaa"));
  const finderLeft = await shell(join(codex, "bbbb"), ".DS_Store");
  await shell(join(codex, "cccc"), "notes.txt");
  await mkdir(join(codex, "dddd"));
  await shell(join(codex, "eeee"));
  await mkdir(join(codex, "eeee", "app"));
  await shell(join(home, ".t3", "worktrees", "app", "t3-1"));
  await linked(join(codex, "ffff"), "gitdir: /nowhere/record\n");

  expect(await findOrphans(home, [])).toEqual([
    { path: empty, cause: { kind: "emptyShell" } },
    { path: finderLeft, cause: { kind: "emptyShell" } },
  ]);
});

test("skips a folder a scanned repository still records, comparing real paths", async () => {
  const { root, home } = await sandbox();
  const moved = await linked(
    join(home, ".codex", "worktrees", "abcd", "app"),
    `gitdir: ${root}/old/app/.git/worktrees/app\n`,
  );
  await symlink(root, join(root, "alias"));
  const recorded = join(root, "alias", "home", ".codex", "worktrees", "abcd", "app");
  const repos = [
    { path: join(root, "projects", "app"), linked: { count: 1, paths: [recorded], unread: [] } },
  ];

  expect(await findOrphans(home, repos)).toEqual([]);
  expect((await findOrphans(home, []))[0]?.path).toBe(moved);
});

test("records that can't be read hide the folders they may hold, but not empty shells", async () => {
  const { root, home } = await sandbox();
  const codex = join(home, ".codex", "worktrees");
  const app = await linked(
    join(codex, "abcd", "app"),
    `gitdir: ${root}/old/app/.git/worktrees/app\n`,
  );
  const web = await linked(
    join(codex, "efgh", "web"),
    `gitdir: ${root}/old/web/.git/worktrees/web\n`,
  );
  const empty = await shell(join(codex, "ijkl"));
  const repo = (linked: { count: number; paths: string[]; unread: string[] } | null) => [
    { path: join(root, "projects", "moved"), linked },
  ];

  expect(
    (await findOrphans(home, repo({ count: 1, paths: [], unread: ["app"] }))).map(
      (orphan) => orphan.path,
    ),
  ).toEqual([web, empty]);
  expect((await findOrphans(home, repo(null))).map((orphan) => orphan.path)).toEqual([empty]);
  expect(
    (await findOrphans(home, repo({ count: 0, paths: [], unread: [] }))).map(
      (orphan) => orphan.path,
    ),
  ).toEqual([app, web, empty]);
});

test("an orphan row carries its cause, the orphans group and no Git facts", () => {
  const path = "/Users/me/.codex/worktrees/abcd/app";
  const cause = {
    kind: "gitdirMissing",
    gitdir: "/Users/me/old/app/.git/worktrees/app",
    repo: "/Users/me/old/app",
    repoExists: false,
  } as const;
  const row = orphanRow({ path, cause });
  expect(row).toMatchObject({
    id: `${ORPHANS}\0${path}`,
    kind: "orphan",
    repoPath: ORPHANS,
    repoName: "Orphaned folders",
    path,
    tool: "Codex",
    orphan: cause,
    branch: null,
    headSha: null,
    changes: null,
    mainState: null,
    defaultBranch: null,
    locked: false,
    prunable: false,
    sizeKiB: null,
    verdict: "Orphaned",
    reason: "Its repository at /Users/me/old/app no longer exists.",
  });
});

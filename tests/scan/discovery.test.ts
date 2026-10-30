import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverRepos,
  readCreatedAt,
  readLinkedWorktrees,
  reposOfWorktrees,
} from "../../src/core/scan/discovery";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("finds repo roots through a depth-3 .git directory and skips deeper ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-discover-"));
  roots.push(root);
  await mkdir(join(root, "top", ".git"), { recursive: true });
  await mkdir(join(root, "group", "nested", ".git"), { recursive: true });
  await mkdir(join(root, "group", "too", "deep", ".git"), { recursive: true });
  await mkdir(join(root, "top", "nested", ".git"), { recursive: true });
  expect(await discoverRepos(root, 3)).toEqual([join(root, "group", "nested"), join(root, "top")]);
});

test("ignores .git files and symlinked directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-discover-"));
  roots.push(root);
  await mkdir(join(root, "linked-target", ".git"), { recursive: true });
  await mkdir(join(root, "file-repo"), { recursive: true });
  await writeFile(join(root, "file-repo", ".git"), "gitdir: /somewhere");
  await symlink(join(root, "linked-target"), join(root, "link"));
  expect(await discoverRepos(root, 3)).toEqual([join(root, "linked-target")]);
});

test("does not scan repositories inside installed dependencies or build output", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-discover-"));
  roots.push(root);
  await mkdir(join(root, "real", ".git"), { recursive: true });
  await mkdir(join(root, "node_modules", "vendor", ".git"), { recursive: true });
  await mkdir(join(root, "build", ".git"), { recursive: true });
  expect(await discoverRepos(root, 3)).toEqual([join(root, "real")]);
});

test("reads linked worktrees and their folders from Git's records without running Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-discover-"));
  roots.push(root);
  await mkdir(join(root, "busy", ".git", "worktrees", "one"), { recursive: true });
  await mkdir(join(root, "busy", ".git", "worktrees", "two"), { recursive: true });
  await mkdir(join(root, "busy", ".git", "worktrees", "three"), { recursive: true });
  await writeFile(join(root, "busy", ".git", "worktrees", "one", "gitdir"), "/trees/one/.git\n");
  // worktree.useRelativePaths writes the path against the record's folder.
  await writeFile(
    join(root, "busy", ".git", "worktrees", "three", "gitdir"),
    "../../../../trees/three/.git\n",
  );
  await mkdir(join(root, "quiet", ".git"), { recursive: true });
  const busy = await readLinkedWorktrees(join(root, "busy"));
  expect({ ...busy, paths: busy?.paths.sort() }).toEqual({
    count: 3,
    paths: ["/trees/one", join(root, "trees", "three")].sort(),
    unread: ["two"],
  });
  expect(await readLinkedWorktrees(join(root, "quiet"))).toEqual({
    count: 0,
    paths: [],
    unread: [],
  });
});

test("a worktree's creation time is its Git folder's birth time, which later Git writes leave alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-discover-"));
  roots.push(root);
  const admin = join(root, "repo", ".git", "worktrees", "one");
  const before = Date.now();
  await mkdir(admin, { recursive: true });
  const after = Date.now();
  await mkdir(join(root, "absolute"));
  await writeFile(join(root, "absolute", ".git"), `gitdir: ${admin}\n`);
  await mkdir(join(root, "relative"));
  await writeFile(join(root, "relative", ".git"), "gitdir: ../repo/.git/worktrees/one\n");
  await Bun.sleep(20);
  await writeFile(join(admin, "HEAD"), "ref: refs/heads/one\n");

  const created = Date.parse((await readCreatedAt(join(root, "absolute")))!);
  // Linux stamps files from a coarse clock that can trail Date.now() by a scheduler tick, up to 10 ms.
  expect(created).toBeGreaterThanOrEqual(before - 10);
  expect(created).toBeLessThanOrEqual(after);
  expect(await readCreatedAt(join(root, "relative"))).toBe(new Date(created).toISOString());
});

test("a worktree's creation time is unknown without a readable .git file and Git folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-discover-"));
  roots.push(root);
  await mkdir(join(root, "no-link"));
  await mkdir(join(root, "dangling"));
  await writeFile(join(root, "dangling", ".git"), `gitdir: ${join(root, "gone")}\n`);
  await mkdir(join(root, "garbled"));
  await writeFile(join(root, "garbled", ".git"), "not a gitdir line\n");
  for (const name of ["no-link", "dangling", "garbled", "missing"])
    expect(await readCreatedAt(join(root, name))).toBeNull();
});

test("follows each worktree's .git file to its main repository, only where the record still exists", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dash-discover-")));
  roots.push(root);
  const agent = join(root, "agent");
  async function worktree(path: string, gitdir: string, record = true) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, ".git"), `gitdir: ${gitdir}\n`);
    if (record) await mkdir(resolve(path, gitdir), { recursive: true });
  }
  await worktree(join(agent, "a1", "app"), join(root, "code", "app", ".git", "worktrees", "app"));
  await worktree(join(agent, "a2", "app"), join(root, "code", "app", ".git", "worktrees", "app1"));
  await worktree(join(agent, "b1", "lib"), "../../../elsewhere/lib/.git/worktrees/lib");
  await worktree(join(agent, "c1", "gone"), join(root, "gone", ".git", "worktrees", "gone"), false);
  await worktree(join(agent, "d1", "bare"), join(root, "bare.git", "worktrees", "bare"));
  await worktree(join(agent, "shallow"), join(root, "shallow", ".git", "worktrees", "shallow"));
  await mkdir(join(agent, "e1", "plain"), { recursive: true });
  expect(await reposOfWorktrees(agent, [2, 2])).toEqual([
    join(root, "code", "app"),
    join(root, "elsewhere", "lib"),
  ]);
  expect(await reposOfWorktrees(agent, [1, 2])).toEqual([
    join(root, "code", "app"),
    join(root, "elsewhere", "lib"),
    join(root, "shallow"),
  ]);
  expect(await reposOfWorktrees(join(root, "missing"), [2, 2])).toEqual([]);
});

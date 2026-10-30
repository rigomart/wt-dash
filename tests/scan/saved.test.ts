import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedRepos, rememberRepos, savedReposFile } from "../../src/core/scan/saved";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function world() {
  const root = await mkdtemp(join(tmpdir(), "dash-saved-"));
  roots.push(root);
  const repo = async (name: string) => {
    await mkdir(join(root, name, ".git"), { recursive: true });
    return join(root, name);
  };
  return { root, repo, file: join(root, "state", "wt-dash", "repos.json") };
}

const saved = async (file: string) => JSON.parse(await readFile(file, "utf8")).repos as string[];

test("the file is in $XDG_STATE_HOME when it is an absolute path, else in ~/.local/state", () => {
  expect(savedReposFile("/home/me", { XDG_STATE_HOME: "/state" })).toBe(
    "/state/wt-dash/repos.json",
  );
  expect(savedReposFile("/home/me", {})).toBe("/home/me/.local/state/wt-dash/repos.json");
  expect(savedReposFile("/home/me", { XDG_STATE_HOME: "" })).toBe(
    "/home/me/.local/state/wt-dash/repos.json",
  );
  // The spec ignores a relative path.
  expect(savedReposFile("/home/me", { XDG_STATE_HOME: "state" })).toBe(
    "/home/me/.local/state/wt-dash/repos.json",
  );
});

test("remembering creates the file and its folders, and returns what it saved", async () => {
  const { repo, file } = await world();
  const [b, a] = [await repo("b"), await repo("a")];
  expect(await rememberRepos(file, [b, a])).toEqual([a, b]);
  expect(await saved(file)).toEqual([a, b]);
  expect(await readSavedRepos(file)).toEqual([a, b]);
});

test("a later scan adds to the saved repositories and never narrows them", async () => {
  const { repo, file } = await world();
  const [a, b, c] = [await repo("a"), await repo("b"), await repo("c")];
  await rememberRepos(file, [a, b]);
  expect(await rememberRepos(file, [c])).toEqual([a, b, c]);
  expect(await rememberRepos(file, [])).toEqual([a, b, c]);
  expect(await saved(file)).toEqual([a, b, c]);
});

test("drops a saved repository whose folder is gone or no longer holds a .git folder", async () => {
  const { root, repo, file } = await world();
  const [kept, deleted, unlinked, linkedWorktree] = await Promise.all(
    ["kept", "deleted", "unlinked", "linkedWorktree"].map(repo),
  );
  await rememberRepos(file, [kept!, deleted!, unlinked!, linkedWorktree!]);
  await rm(deleted!, { recursive: true });
  await rm(join(unlinked!, ".git"), { recursive: true });
  await rm(join(linkedWorktree!, ".git"), { recursive: true });
  await writeFile(
    join(linkedWorktree!, ".git"),
    `gitdir: ${join(root, "kept", ".git", "worktrees", "x")}`,
  );
  expect(await readSavedRepos(file)).toEqual([kept!]);
  expect(await saved(file)).toHaveLength(4);
  expect(await rememberRepos(file, [])).toEqual([kept!]);
  expect(await saved(file)).toEqual([kept!]);
});

test("keeps a saved repository that can't be read, without listing it, until it can be again", async () => {
  const { repo, file } = await world();
  const [a, locked] = [await repo("a"), await repo("locked")];
  await rememberRepos(file, [a, locked]);
  await chmod(locked, 0o000);
  try {
    expect(await readSavedRepos(file)).toEqual([a]);
    expect(await rememberRepos(file, [])).toEqual([a]);
    expect(await saved(file)).toEqual([a, locked]);
  } finally {
    await chmod(locked, 0o755);
  }
  expect(await readSavedRepos(file)).toEqual([a, locked]);
});

test("a missing, corrupt or wrongly shaped file reads as empty and is rewritten", async () => {
  const { repo, file } = await world();
  const a = await repo("a");
  expect(await readSavedRepos(file)).toEqual([]);
  await mkdir(join(file, ".."), { recursive: true });
  for (const text of ["{not json", "[]", '{"repos":"a"}', "null", ""]) {
    await writeFile(file, text);
    expect(await readSavedRepos(file)).toEqual([]);
    expect(await rememberRepos(file, [a])).toEqual([a]);
    expect(await saved(file)).toEqual([a]);
  }
  await writeFile(file, JSON.stringify({ repos: [a, 7, "relative/path", a] }));
  expect(await readSavedRepos(file)).toEqual([a]);
});

test("a scan that finds nothing creates no file", async () => {
  const { file } = await world();
  expect(await rememberRepos(file, [])).toEqual([]);
  expect(await readFile(file, "utf8").catch(() => null)).toBeNull();
});

test("leaves the file alone when a scan changes nothing", async () => {
  const { repo, file } = await world();
  const a = await repo("a");
  await rememberRepos(file, [a]);
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
  expect(await rememberRepos(file, [a])).toEqual([a]);
  expect((await stat(file)).mtimeMs).toBe(old.getTime());
});

test("a write that fails leaves the run going and no temporary file behind", async () => {
  const { repo, file } = await world();
  const [a, b] = [await repo("a"), await repo("b")];
  await rememberRepos(file, [a]);
  await chmod(join(file, ".."), 0o555);
  try {
    expect(await rememberRepos(file, [b])).toEqual([a, b]);
    expect(await readdir(join(file, ".."))).toEqual(["repos.json"]);
    expect(await saved(file)).toEqual([a]);
  } finally {
    await chmod(join(file, ".."), 0o755);
  }
  expect(await rememberRepos(file, [])).toEqual([a]);
});

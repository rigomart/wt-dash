import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverRepos } from "../src/core/discovery";

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
  expect(await discoverRepos(root, 3)).toEqual([
    join(root, "group", "nested"),
    join(root, "top"),
  ]);
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

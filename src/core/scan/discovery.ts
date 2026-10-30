import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const holdsGitFolder = (entries: Dirent[]) =>
  entries.some((entry) => entry.name === ".git" && entry.isDirectory());

/** Whether `folder` is a repository by the scan's test, or null when it can't be read, so it may still be one. */
export async function isRepo(folder: string): Promise<boolean | null> {
  try {
    return holdsGitFolder(await readdir(folder, { withFileTypes: true }));
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
      ? false
      : null;
  }
}

export async function discoverRepos(root: string, maxDepth: number): Promise<string[]> {
  const repos: string[] = [];
  const skipped = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".cache",
    ".Trash",
  ]);

  async function visit(directory: string, depth: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (depth > 0 && ["EACCES", "EPERM", "ENOENT"].includes(error.code ?? "")) return [];
        throw error;
      },
    );
    if (depth + 1 <= maxDepth && holdsGitFolder(entries)) {
      repos.push(directory);
      return;
    }
    if (depth + 2 > maxDepth) return;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || skipped.has(entry.name)) continue;
      await visit(join(directory, entry.name), depth + 1);
    }
  }

  await visit(root, 0);
  return repos.sort();
}

/**
 * Where repositories are found: a folder searched for them, or an agent's worktree folder, whose worktrees lead
 * back to their repositories wherever those live.
 */
export type RepoSource =
  | { kind: "scan"; folder: string }
  | { kind: "agent"; folder: string; levels: readonly [number, number] };

/** The repositories each source finds, searching scan folders `depth` levels below them. */
export function findRepos(
  sources: RepoSource[],
  depth: number,
): Promise<Array<{ source: RepoSource; repos: string[] }>> {
  return Promise.all(
    sources.map(async (source) => ({
      source,
      repos:
        source.kind === "scan"
          ? await discoverRepos(source.folder, depth + 1)
          : await reposOfWorktrees(source.folder, source.levels),
    })),
  );
}

async function readGitdir(worktree: string): Promise<string | null> {
  const link = await readFile(join(worktree, ".git"), "utf8");
  const gitdir = /^gitdir: (.+)$/m.exec(link)?.[1]?.trim();
  return gitdir ? resolve(worktree, gitdir) : null;
}

async function repoOfWorktree(worktree: string): Promise<string | null> {
  try {
    const gitdir = await readGitdir(worktree);
    const records = gitdir && dirname(gitdir);
    if (!records || basename(records) !== "worktrees" || basename(dirname(records)) !== ".git")
      return null;
    await stat(gitdir);
    return await realpath(dirname(dirname(records)));
  } catch {
    return null;
  }
}

/** The repositories of the worktrees between `fewest` and `most` folder levels below `folder`, read from their `.git` files, never through Git. */
export async function reposOfWorktrees(
  folder: string,
  [fewest, most]: readonly [number, number],
): Promise<string[]> {
  const repos = new Set<string>();
  async function visit(directory: string, level: number): Promise<void> {
    if (level >= fewest) {
      const repo = await repoOfWorktree(directory);
      if (repo) return void repos.add(repo);
    }
    if (level >= most) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => visit(join(directory, entry.name), level + 1)),
    );
  }
  await visit(folder, 0);
  return [...repos].sort();
}

export interface LinkedWorktrees {
  count: number;
  /** Folders of the worktrees whose `gitdir` record could be read. */
  paths: string[];
  /** Names of the records whose `gitdir` could not be read. */
  unread: string[];
}

/** Read the linked worktrees Git records in `.git/worktrees`, without running Git. */
export async function readLinkedWorktrees(repo: string): Promise<LinkedWorktrees | null> {
  const records = join(repo, ".git", "worktrees");
  let names: string[];
  try {
    const entries = await readdir(records, { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { count: 0, paths: [], unread: [] }
      : null;
  }
  const paths = await Promise.all(
    names.map((name) =>
      readFile(join(records, name, "gitdir"), "utf8").then(
        // Git writes a relative path, against the record's folder, under worktree.useRelativePaths.
        (gitdir) => dirname(resolve(join(records, name), gitdir.trim())),
        () => null,
      ),
    ),
  );
  return {
    count: names.length,
    paths: paths.filter((path) => path !== null),
    unread: names.filter((_, index) => paths[index] === null),
  };
}

/**
 * When Git created the worktree, as an ISO time, or null when it can't be read. Uses the birth time of its
 * folder under `.git/worktrees`, whose mtime moves with every commit and checkout.
 */
export async function readCreatedAt(worktree: string): Promise<string | null> {
  try {
    const gitdir = await readGitdir(worktree);
    if (!gitdir) return null;
    const { birthtimeMs } = await stat(gitdir);
    return birthtimeMs > 0 ? new Date(birthtimeMs).toISOString() : null;
  } catch {
    return null;
  }
}

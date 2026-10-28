import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
    if (
      depth + 1 <= maxDepth &&
      entries.some((entry) => entry.name === ".git" && entry.isDirectory())
    ) {
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

export interface LinkedWorktrees {
  count: number;
  /** Folders of the worktrees whose `gitdir` record could be read. */
  paths: string[];
}

/** Read the linked worktrees Git records in `.git/worktrees`, without running Git. */
export async function readLinkedWorktrees(repo: string): Promise<LinkedWorktrees | null> {
  const records = join(repo, ".git", "worktrees");
  let names: string[];
  try {
    const entries = await readdir(records, { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { count: 0, paths: [] } : null;
  }
  const paths = await Promise.all(
    names.map((name) =>
      readFile(join(records, name, "gitdir"), "utf8").then(
        (gitdir) => dirname(gitdir.trim()),
        () => null,
      ),
    ),
  );
  return { count: names.length, paths: paths.filter((path) => path !== null) };
}

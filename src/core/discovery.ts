import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function discoverRepos(root: string, maxDepth: number): Promise<string[]> {
  const repos: string[] = [];
  const skipped = new Set([".git", "node_modules", "dist", "build", "target", ".next", ".cache", ".Trash"]);

  async function visit(directory: string, depth: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (depth > 0 && ["EACCES", "EPERM", "ENOENT"].includes(error.code ?? "")) return [];
      throw error;
    });
    if (depth + 1 <= maxDepth && entries.some((entry) => entry.name === ".git" && entry.isDirectory())) {
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

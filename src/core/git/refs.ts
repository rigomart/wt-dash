import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { failure } from "../process";
import type { CommandRunner } from "../types";

/** Worktrunk prefers local unless its tracking branch is strictly ahead. */
export async function readComparisonBase(
  repo: string,
  branch: string | null,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!branch) return null;
  try {
    const upstream = await runner(
      "git",
      ["-C", repo, "rev-parse", "--verify", "--symbolic-full-name", `${branch}@{upstream}`],
      signal,
    );
    const ref = upstream.stdout.trim();
    if (upstream.exitCode !== 0 || !ref.startsWith("refs/")) return branch;
    const divergence = await runner(
      "git",
      ["-C", repo, "rev-list", "--left-right", "--count", `${branch}...${ref}`],
      signal,
    );
    if (divergence.exitCode === 0 && /^0\s+[1-9]\d*\s*$/.test(divergence.stdout.trim())) {
      return ref.replace(/^refs\/(remotes|heads)\//, "");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return branch;
}

const descriptionKey = /^branch\.(.+)\.description$/;

/** Each branch's description from `branch.<name>.description`; config that can't be read gives none. */
export async function readDescriptions(
  repo: string,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const descriptions = new Map<string, string>();
  try {
    const result = await runner(
      "git",
      ["-C", repo, "config", "--null", "--get-regexp", "^branch\\..*\\.description$"],
      signal,
    );
    // Exit 1 means no entry matched.
    if (result.exitCode !== 0) return descriptions;
    for (const entry of result.stdout.split("\0")) {
      const newline = entry.indexOf("\n");
      if (newline < 0) continue;
      const branch = descriptionKey.exec(entry.slice(0, newline))?.[1];
      const text = entry.slice(newline + 1).trim();
      if (branch && text) descriptions.set(branch, text);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return descriptions;
}

/** `rev-parse --verify -q` exits 1 with no output for a missing ref. */
export async function readTip(
  repoPath: string,
  ref: string,
  runner: CommandRunner,
): Promise<string | null> {
  const result = await runner("git", ["-C", repoPath, "rev-parse", "--verify", "-q", ref]);
  if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim()) return null;
  if (result.exitCode !== 0) throw failure("git rev-parse", result);
  return result.stdout.trim();
}

export async function readTips(
  repoPath: string,
  refs: string[],
  runner: CommandRunner,
): Promise<Map<string, string | null>> {
  const unique = [...new Set(refs)];
  const tips: Array<string | null> = [];
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (next < unique.length && !failed) {
      const index = next++;
      try {
        tips[index] = await readTip(repoPath, unique[index]!, runner);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, unique.length) }, worker));
  return new Map(unique.map((ref, index) => [ref, tips[index]!]));
}

/**
 * When a branch without a worktree was created, the way `wt step prune` judges its age: its oldest reflog
 * entry, or else when Git last wrote its ref. Null when neither can be read, as in a reftable repository.
 */
export async function readBranchCreatedAt(repo: string, branch: string): Promise<string | null> {
  const gitDir = join(repo, ".git");
  let first = "";
  try {
    const file = await open(join(gitDir, "logs", "refs", "heads", branch));
    try {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(4096), 0, 4096, 0);
      first = buffer.toString("utf8", 0, bytesRead).split("\n")[0]!;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  if (first) {
    // `<old> <new> <name> <<email>> <seconds> <zone>\t<message>`
    const seconds = /> (\d+) [+-]\d{4}(\t|$)/.exec(first)?.[1];
    return seconds ? new Date(Number(seconds) * 1000).toISOString() : null;
  }
  for (const ref of [join(gitDir, "refs", "heads", branch), join(gitDir, "packed-refs")]) {
    try {
      return new Date((await stat(ref)).mtimeMs).toISOString();
    } catch {
      // A packed ref has no file of its own; packed-refs was written no earlier than the ref.
    }
  }
  return null;
}

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
  const tips = await Promise.all(unique.map((ref) => readTip(repoPath, ref, runner)));
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

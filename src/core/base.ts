import type { CommandRunner } from "./types";

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

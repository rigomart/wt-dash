import type { CommandRunner } from "../types";

export interface GitHubRepo {
  owner: string;
  name: string;
}

const owner = "([A-Za-z0-9][A-Za-z0-9-]*)";
const name = "([A-Za-z0-9._-]+?)";
const end = "(?:\\.git)?/?$";
const forms = [
  new RegExp(`^https://(?:[^@/]+@)?github\\.com/${owner}/${name}${end}`, "i"),
  new RegExp(`^git@github\\.com:${owner}/${name}${end}`, "i"),
  new RegExp(`^ssh://git@github\\.com(?::22)?/${owner}/${name}${end}`, "i"),
];

/** The repository a github.com HTTPS or SSH remote URL names, or null for any other URL. */
export function parseGitHubUrl(url: string): GitHubRepo | null {
  for (const form of forms) {
    const match = form.exec(url.trim());
    if (match) return { owner: match[1]!, name: match[2]! };
  }
  return null;
}

/**
 * The GitHub repository of the remote the default branch tracks, or of `origin` when it tracks none; null when
 * that remote isn't on github.com. The URL is read as configured, before any `insteadOf` rewrite.
 */
export async function readGitHubRepo(
  repo: string,
  defaultBranch: string | null,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<GitHubRepo | null> {
  let remote = "origin";
  if (defaultBranch) {
    const tracked = await runner(
      "git",
      ["-C", repo, "config", "--get", `branch.${defaultBranch}.remote`],
      signal,
    );
    if (tracked.exitCode === 0 && tracked.stdout.trim()) remote = tracked.stdout.trim();
  }
  const url = await runner("git", ["-C", repo, "config", "--get", `remote.${remote}.url`], signal);
  return url.exitCode === 0 ? parseGitHubUrl(url.stdout) : null;
}

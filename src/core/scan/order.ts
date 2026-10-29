import { basename } from "node:path";
import type { LinkedWorktrees } from "./discovery";

/**
 * Repos in the order the projects screen shows them: most worktrees first, with the repo whose worktrees
 * took the most space at the last measurement moved up to second. `first` holds the repos listed first.
 */
export function listingOrder(
  repos: Array<{ path: string; linked: LinkedWorktrees | null }>,
  sizeOf: (path: string) => number | null,
): { order: string[]; first: Set<string> } {
  const ranked = [...repos].sort(
    (a, b) =>
      (b.linked?.count ?? 0) - (a.linked?.count ?? 0) ||
      basename(a.path).localeCompare(basename(b.path)) ||
      a.path.localeCompare(b.path),
  );
  const saved = (repo: (typeof repos)[number]) =>
    (repo.linked?.paths ?? []).reduce((sum, path) => sum + (sizeOf(path) ?? 0), 0);
  const heaviest = ranked.reduce<(typeof repos)[number] | null>(
    (best, repo) => (saved(repo) > (best ? saved(best) : 0) ? repo : best),
    null,
  );
  const promoted = heaviest !== null && heaviest !== ranked[0];
  if (promoted) {
    ranked.splice(ranked.indexOf(heaviest), 1);
    ranked.splice(1, 0, heaviest);
  }
  const order = ranked.map((repo) => repo.path);
  return { order, first: new Set(order.slice(0, promoted ? 2 : 1)) };
}

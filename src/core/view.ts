import type { DashboardSnapshot, ToolName, Verdict, WorktreeRow } from "./types";
import { TOOL_NAMES } from "./worktrunk/list";

export interface ViewOptions {
  search?: string;
  verdicts?: Verdict[];
  repos?: string[];
  tools?: ToolName[];
  sort?: { key: "size" | "age" | "repo" | "verdict"; direction: "asc" | "desc" };
}

export interface RepoGroup {
  repoPath: string;
  repoName: string;
  rows: WorktreeRow[];
}

const verdictOrder: Record<Verdict, number> = {
  Safe: 0,
  Review: 2,
  Busy: 3,
  Broken: 4,
};

function compareValues(
  a: number | string | null,
  b: number | string | null,
  direction: "asc" | "desc",
): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  const comparison =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
  return direction === "asc" ? comparison : -comparison;
}

export function selectRows(rows: WorktreeRow[], options: ViewOptions): WorktreeRow[] {
  const search = options.search?.trim().toLocaleLowerCase() ?? "";
  const sort = options.sort ?? { key: "size", direction: "desc" };
  return rows
    .filter((row) => {
      if (
        search &&
        !`${row.branch ?? ""}\n${row.path ?? ""}\n${row.repoName}\n${TOOL_NAMES[row.tool]}`
          .toLocaleLowerCase()
          .includes(search)
      )
        return false;
      if (options.verdicts?.length && !options.verdicts.includes(row.verdict)) return false;
      if (options.repos?.length && !options.repos.includes(row.repoName)) return false;
      if (options.tools?.length && !options.tools.includes(row.tool)) return false;
      return true;
    })
    .sort((a, b) => {
      let left: number | string | null;
      let right: number | string | null;
      switch (sort.key) {
        case "size":
          left = a.sizeKiB;
          right = b.sizeKiB;
          break;
        case "age":
          left =
            a.committedAt && Number.isFinite(Date.parse(a.committedAt))
              ? -Date.parse(a.committedAt)
              : null;
          right =
            b.committedAt && Number.isFinite(Date.parse(b.committedAt))
              ? -Date.parse(b.committedAt)
              : null;
          break;
        case "repo":
          left = a.repoName;
          right = b.repoName;
          break;
        case "verdict":
          left = verdictOrder[a.verdict];
          right = verdictOrder[b.verdict];
          break;
      }
      return compareValues(left, right, sort.direction) || a.id.localeCompare(b.id);
    });
}

/** A worktree with no size yet whose folder is being measured; one whose measurement failed is not. */
export function isSizing(snapshot: Pick<DashboardSnapshot, "sizing">, row: WorktreeRow): boolean {
  return row.sizeKiB === null && row.path !== null && snapshot.sizing.includes(row.path);
}

export function groupByRepo(rows: WorktreeRow[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const row of rows) {
    let group = groups.get(row.repoPath);
    if (!group) {
      group = { repoPath: row.repoPath, repoName: row.repoName, rows: [] };
      groups.set(row.repoPath, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

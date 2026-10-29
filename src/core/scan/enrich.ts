import { assess } from "../assess";
import { readBranchCreatedAt, readComparisonBase } from "../git/refs";
import type { CommandRunner, WorktreeRow } from "../types";
import { readMarks } from "../worktrunk/list";
import { readCreatedAt } from "./discovery";

export interface EnrichOptions {
  readCreated?: (worktree: string) => Promise<string | null>;
  readBranchCreated?: (repo: string, branch: string) => Promise<string | null>;
  signal?: AbortSignal;
}

/**
 * Adds what Worktrunk's JSON lacks: the comparison base, each row's creation time, and when its marker was
 * set, then assesses each row again.
 */
export async function enrichRows(
  repo: string,
  rows: WorktreeRow[],
  runner: CommandRunner,
  options: EnrichOptions = {},
): Promise<WorktreeRow[]> {
  if (!rows.length) return rows;
  const readCreated = options.readCreated ?? readCreatedAt;
  const readBranchCreated = options.readBranchCreated ?? readBranchCreatedAt;
  const [base, created, marks] = await Promise.all([
    readComparisonBase(repo, rows[0]!.defaultBranch, runner, options.signal),
    Promise.all(
      rows.map((row) =>
        row.path !== null
          ? readCreated(row.path)
          : row.branch
            ? readBranchCreated(repo, row.branch)
            : null,
      ),
    ),
    readMarks(repo, runner, options.signal),
  ]);
  return rows.map((row, index) => {
    // Worktrunk's JSON carries the marker only for worktrees; its state in Git config has it for every branch.
    const mark = row.branch ? marks.get(row.branch) : undefined;
    const marker = row.marker ?? mark?.marker ?? null;
    const enriched: WorktreeRow = {
      ...row,
      mainBase: base,
      createdAt: created[index]!,
      marker,
      markerSetAt: mark && mark.marker === marker ? mark.setAt : null,
    };
    const assessment = assess(enriched);
    return { ...enriched, verdict: assessment.verdict, reason: assessment.reason };
  });
}

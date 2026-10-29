import { basename } from "node:path";
import type { ChangeFlags, ToolName, WorktreeFacts, WorktreeRow } from "./types";
import { assess } from "./assess";

export class SchemaMismatchError extends Error {
  constructor(schema: unknown) {
    super(`Worktrunk JSON schema changed: expected 2, received ${String(schema)}`);
    this.name = "SchemaMismatchError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function changesFrom(value: unknown): ChangeFlags | null {
  const input = object(value);
  if (!input) return null;
  const keys = ["staged", "modified", "untracked", "renamed", "deleted"] as const;
  if (keys.some((key) => typeof input[key] !== "boolean")) return null;
  return {
    staged: input.staged as boolean,
    modified: input.modified as boolean,
    untracked: input.untracked as boolean,
    renamed: input.renamed as boolean,
    deleted: input.deleted as boolean,
    conflicted: typeof input.conflicted === "boolean" ? input.conflicted : null,
  };
}

export function toolForPath(path: string): ToolName {
  if (path.includes("/.claude/worktrees/")) return "Claude";
  if (path.includes("/.codex/worktrees/")) return "Codex";
  if (path.includes("/.t3-lines/lines/worktrees/")) return "t3";
  return "Other";
}

/** Worktrees other than the main one, and local branches without a worktree other than the default branch. */
export function parseWorktrunk(repoPath: string, stdout: string): WorktreeRow[] {
  const payload = object(JSON.parse(stdout) as unknown);
  if (payload?.schema !== 2) throw new SchemaMismatchError(payload?.schema);
  if (!Array.isArray(payload.items)) throw new Error("Worktrunk JSON has no items array");
  const defaultBranchName = string(object(payload.repo)?.default_branch);

  const rows: WorktreeRow[] = [];
  for (const raw of payload.items) {
    const item = object(raw);
    if (!item) continue;
    const worktree = object(item.worktree);
    const branch = string(item.branch);
    let path: string | null = null;
    if (worktree) {
      if (worktree.main !== false) continue;
      path = string(worktree.path);
      if (!path) continue;
    } else if (!branch || branch === defaultBranchName) continue;
    const head = object(item.head);
    const upstream = object(item.upstream);
    const defaultBranch = object(item.default_branch);
    const integration = object(defaultBranch?.integration);
    const display = object(item.display);
    const facts: WorktreeFacts = {
      // A path holds no NUL, so the two kinds of id cannot collide.
      id: path === null ? `${repoPath}\0branch\0${branch}` : `${repoPath}\0${path}`,
      kind: path === null ? "branch" : "worktree",
      repoPath,
      repoName: basename(repoPath),
      path,
      branch,
      headSha: string(head?.sha),
      committedAt: string(head?.committed_at),
      // Worktrunk's JSON has no creation time.
      createdAt: null,
      marker: string(item.marker),
      // The JSON has no marker time; it is read from Worktrunk's state in Git config.
      markerSetAt: null,
      tool: path === null ? "Other" : toolForPath(path),
      changes: changesFrom(worktree?.changes),
      upstreamAhead: typeof upstream?.ahead === "number" ? upstream.ahead : null,
      mainState: string(display?.state),
      integrationReason: string(integration?.reason),
      lockReason: string(object(worktree?.locked)?.reason),
      mainAhead: typeof defaultBranch?.ahead === "number" ? defaultBranch.ahead : null,
      defaultBranch: defaultBranchName,
      mainBase: null,
      locked: object(worktree?.locked) !== null,
      prunable: object(worktree?.prunable) !== null,
      operation: string(worktree?.operation),
    };
    const { verdict, reason } = assess(facts);
    rows.push({ ...facts, sizeKiB: null, sizeMeasuredAt: null, verdict, reason });
  }
  return rows;
}

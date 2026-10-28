import { basename } from "node:path";
import type { ChangeFlags, ToolName, WorktreeFacts, WorktreeRow } from "./types";
import { verdictFor } from "./verdict";

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

export function parseWorktrunk(repoPath: string, stdout: string): WorktreeRow[] {
  const payload = object(JSON.parse(stdout) as unknown);
  if (payload?.schema !== 2) throw new SchemaMismatchError(payload?.schema);
  if (!Array.isArray(payload.items)) throw new Error("Worktrunk JSON has no items array");

  const rows: WorktreeRow[] = [];
  for (const raw of payload.items) {
    const item = object(raw);
    const worktree = object(item?.worktree);
    if (!item || !worktree || worktree.main !== false) continue;
    const path = string(worktree.path);
    if (!path) continue;
    const head = object(item.head);
    const upstream = object(item.upstream);
    const defaultBranch = object(item.default_branch);
    const integration = object(defaultBranch?.integration);
    const display = object(item.display);
    const facts: WorktreeFacts = {
      id: `${repoPath}\0${path}`,
      repoPath,
      repoName: basename(repoPath),
      path,
      branch: string(item.branch),
      headSha: string(head?.sha),
      committedAt: string(head?.committed_at),
      // Worktrunk's JSON has no creation time.
      createdAt: null,
      tool: toolForPath(path),
      changes: changesFrom(worktree.changes),
      upstreamAhead: typeof upstream?.ahead === "number" ? upstream.ahead : null,
      mainState: string(display?.state),
      integrationReason: string(integration?.reason),
      lockReason: string(object(worktree.locked)?.reason),
      mainAhead: typeof defaultBranch?.ahead === "number" ? defaultBranch.ahead : null,
      defaultBranch: string(object(payload.repo)?.default_branch),
      mainBase: null,
      locked: object(worktree.locked) !== null,
      prunable: object(worktree.prunable) !== null,
      operation: string(worktree.operation),
    };
    rows.push({
      ...facts,
      sizeKiB: null,
      sizeMeasuredAt: null,
      ...verdictFor(facts),
    });
  }
  return rows;
}

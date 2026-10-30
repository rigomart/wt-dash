import { basename, dirname } from "node:path";
import type {
  ChangeFlags,
  CommandRunner,
  LineCounts,
  ToolName,
  WorktreeFacts,
  WorktreeRow,
} from "../types";
import { assess } from "../assess";

/** `wt list` arguments for a repo's worktrees and, unless `branches` is false, its local branches without one. */
export function listArgs(repo: string, branches = true): string[] {
  return [
    "-C",
    repo,
    "--config-set",
    "list.json-schema=2",
    "list",
    ...(branches ? ["--branches"] : []),
    "--format=json",
  ];
}

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

function lineCountsFrom(value: unknown): LineCounts | null {
  const input = object(value);
  return typeof input?.added === "number" && typeof input.deleted === "number"
    ? { added: input.added, deleted: input.deleted }
    : null;
}

function varsFrom(value: unknown): Record<string, string> | null {
  const entries = Object.entries(object(value) ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length ? Object.fromEntries(entries) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export const TOOL_NAMES: Record<ToolName, string> = {
  Claude: "Claude Code",
  Codex: "Codex",
  t3: "t3",
  Cursor: "Cursor",
  Conductor: "Conductor",
  Windsurf: "Windsurf",
  Gemini: "Gemini CLI",
  ClaudeSquad: "Claude Squad",
  Superset: "Superset",
  Worktrunk: "Worktrunk",
  Other: "other",
};

export interface AgentFolder {
  tool: ToolName;
  /** Relative to the home folder. */
  folder: string;
  /** The fewest and most folder levels below `folder` a worktree sits at. */
  levels: readonly [number, number];
}

/** Cursor and Superset document only their base folder, so one or two levels below it match. */
export const AGENT_FOLDERS: readonly AgentFolder[] = [
  { tool: "t3", folder: ".t3/worktrees", levels: [2, 2] },
  { tool: "t3", folder: ".t3-lines/lines/worktrees", levels: [1, 2] },
  { tool: "Codex", folder: ".codex/worktrees", levels: [2, 2] },
  { tool: "Cursor", folder: ".cursor/worktrees", levels: [1, 2] },
  { tool: "Conductor", folder: "conductor/workspaces", levels: [2, 2] },
  { tool: "Windsurf", folder: ".windsurf/worktrees", levels: [2, 2] },
  { tool: "ClaudeSquad", folder: ".claude-squad/worktrees", levels: [1, 1] },
  { tool: "Superset", folder: ".superset/worktrees", levels: [1, 2] },
];

const TOOL_LAYOUTS: Array<readonly [RegExp, ToolName]> = [
  ...AGENT_FOLDERS.map(
    ({ tool, folder, levels: [fewest, most] }) =>
      [new RegExp(`/${folder.replaceAll(".", "\\.")}(/[^/]+){${fewest},${most}}$`), tool] as const,
  ),
  [/\/\.gemini\/worktrees\/[^/]+$/, "Gemini"],
];

export function toolForPath(path: string, repoPath: string): ToolName {
  const layout = TOOL_LAYOUTS.find(([pattern]) => pattern.test(path));
  if (layout) return layout[1];
  if (path.includes("/.claude/worktrees/")) return "Claude";
  if (path.includes("/.codex/worktrees/")) return "Codex";
  if (path.includes("/.t3-lines/lines/worktrees/")) return "t3";
  // Worktrunk's default `worktree-path` puts `<repo>.<branch>` beside the repository.
  if (dirname(path) === dirname(repoPath) && basename(path).startsWith(`${basename(repoPath)}.`))
    return "Worktrunk";
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
      tool: path === null ? "Other" : toolForPath(path, repoPath),
      changes: changesFrom(worktree?.changes),
      upstreamAhead: typeof upstream?.ahead === "number" ? upstream.ahead : null,
      mainState: string(display?.state),
      integrationReason: string(integration?.reason),
      lockReason: string(object(worktree?.locked)?.reason),
      mainAhead: count(defaultBranch?.ahead),
      mainBehind: count(defaultBranch?.behind),
      mainDiff: lineCountsFrom(defaultBranch?.diff),
      subject: string(head?.subject),
      // Worktrunk's JSON has no description; it is read from Git config.
      description: null,
      vars: varsFrom(item.vars),
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

export interface Mark {
  marker: string;
  setAt: string | null;
}

const markKey = /^worktrunk\.state\.(.+)\.marker$/;

/**
 * Worktrunk's marks by branch, from `worktrunk.state.<branch>.marker` entries such as
 * `{"marker":"🤖","set_at":1790780978}`. A value that isn't that JSON gives a mark with no time; config
 * that can't be read gives no marks.
 */
export async function readMarks(
  repo: string,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<Map<string, Mark>> {
  const marks = new Map<string, Mark>();
  try {
    const result = await runner(
      "git",
      ["-C", repo, "config", "--null", "--get-regexp", "^worktrunk\\.state\\..*\\.marker$"],
      signal,
    );
    // Exit 1 means no entry matched.
    if (result.exitCode !== 0) return marks;
    for (const entry of result.stdout.split("\0")) {
      const newline = entry.indexOf("\n");
      if (newline < 0) continue;
      const branch = markKey.exec(entry.slice(0, newline))?.[1];
      if (branch) marks.set(branch, parseMark(entry.slice(newline + 1)));
    }
  } catch {}
  return marks;
}

function parseMark(value: string): Mark {
  try {
    const parsed = JSON.parse(value) as { marker?: unknown; set_at?: unknown };
    if (typeof parsed.marker === "string") {
      const seconds = parsed.set_at;
      const date = typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000) : null;
      const setAt = date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
      return { marker: parsed.marker, setAt };
    }
  } catch {}
  return { marker: value.trim(), setAt: null };
}

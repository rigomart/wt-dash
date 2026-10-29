import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { assess } from "./assess";
import { readComparisonBase } from "./base";
import { readCreatedAt } from "./discovery";
import type { CommandRunner, WorktreeRow } from "./types";

/** `wt list` arguments for a repo's worktrees and its local branches without one. */
export function listArgs(repo: string): string[] {
  return ["-C", repo, "--config-set", "list.json-schema=2", "list", "--branches", "--format=json"];
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

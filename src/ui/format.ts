import { assess } from "../core/assess";
import type { LineCounts, WorktreeRow } from "../core/types";

export function plain(value: string): string {
  return value.replace(/\p{Cc}/gu, " ");
}

export function sizeLabel(kib: number | null): string {
  if (kib === null) return "…";
  if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)} GB`;
  if (kib >= 1024) return `${(kib / 1024).toFixed(1)} MB`;
  return `${kib} KB`;
}

function elapsed(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ms = now - Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** Compact age for a table column: "now", "5h", "12d". */
export function ageLabel(iso: string | null, now: number): string {
  const ms = elapsed(iso, now);
  if (ms === null) return "?";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "now";
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Relative time for prose: "just now", "4m ago", "3h ago", "5d ago". */
export function agoLabel(iso: string | null, now: number): string {
  const ms = elapsed(iso, now);
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function clockLabel(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The branch, or for an orphan, which has none, its folder's name. */
/** An orphan is named by its folder, with the folder above unless that is the agent's `worktrees` folder: `abcd/app`. */
export function branchLabel(row: WorktreeRow): string {
  if (row.kind === "orphan" && row.path) {
    const [parent, folder] = row.path.split("/").slice(-2);
    return parent && parent !== "worktrees" ? `${parent}/${folder}` : folder || row.path;
  }
  if (row.branch) return row.branch;
  return row.headSha ? `detached @${row.headSha.slice(0, 7)}` : "detached";
}

export function homePath(path: string, home: string): string {
  return home && (path === home || path.startsWith(home + "/"))
    ? "~" + path.slice(home.length)
    : path;
}

/** Shortens each path under `home` in a sentence, such as an orphan's reason, to start with `~`. */
export function homeText(text: string, home: string): string {
  return text
    .split(" ")
    .map((word) => homePath(word, home))
    .join(" ");
}

/** Display the single Git status, shortened only when the column cannot fit it. */
export function statusLabel(row: WorktreeRow, width = 23): string {
  const label = plain(assess(row).status);
  if (Bun.stringWidth(label) <= width) return label;
  return width > 0
    ? Array.from(label)
        .slice(0, Math.max(0, width - 1))
        .join("") + "…"
    : "";
}

export function changesLabel(row: WorktreeRow): string {
  if (!row.changes) return "unknown";
  const { staged, modified, untracked, renamed, deleted, conflicted } = row.changes;
  const parts = [
    staged ? "staged" : "",
    modified || renamed || deleted ? "modified" : "",
    untracked ? "untracked" : "",
    conflicted ? "conflicts" : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "clean";
}

export function upstreamLabel(row: WorktreeRow): string {
  if (row.upstreamAhead === null) return "no tracking branch";
  return row.upstreamAhead > 0 ? `${row.upstreamAhead} commits not pushed` : "pushed";
}

/** "+18 −4", leaving out a side that is zero; empty when nothing changed or the counts are unknown. */
export function linesLabel(diff: LineCounts | null): string {
  if (!diff) return "";
  return [diff.added ? `+${diff.added}` : "", diff.deleted ? `−${diff.deleted}` : ""]
    .filter(Boolean)
    .join(" ");
}

/** The work a branch carries beyond the default branch: "3 commits ahead of main · +18"; null when unknown. */
export function aheadLabel(row: WorktreeRow): string | null {
  if (row.mainAhead === null) return null;
  const base = row.defaultBranch ?? "the default branch";
  if (!row.mainAhead) return `no commits beyond ${base}`;
  const lines = linesLabel(row.mainDiff);
  return `${countLabel(row.mainAhead, "commit")} ahead of ${base}${lines ? ` · ${lines}` : ""}`;
}

/** Ahead, behind and lines changed against the default branch: "3 ahead of main · 2 behind · +18 lines". */
export function divergenceLabel(row: WorktreeRow): string | null {
  if (row.mainAhead === null) return null;
  const base = row.defaultBranch ?? "the default branch";
  const lines = linesLabel(row.mainDiff);
  const changed = row.mainDiff ? row.mainDiff.added + row.mainDiff.deleted : 0;
  return [
    row.mainAhead ? `${row.mainAhead} ahead of ${base}` : `none beyond ${base}`,
    row.mainBehind ? `${row.mainBehind} behind` : "",
    lines ? `${lines} ${changed === 1 ? "line" : "lines"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function branchOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case "deleted":
      return "branch deleted";
    case "retained_unmerged":
      return "branch kept (not merged)";
    case "not_attempted":
      return "branch left alone";
    default:
      return `branch ${outcome.replaceAll("_", " ")}`;
  }
}

/** Strip the two-letter porcelain status from `git status --porcelain` lines. */
export function porcelainPath(line: string): string {
  return line.length > 3 && line[2] === " " ? line.slice(3) : line;
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const ROW_KINDS: Array<[WorktreeRow["kind"], string, string]> = [
  ["worktree", "worktree", "worktrees"],
  ["branch", "branch", "branches"],
  ["orphan", "orphaned folder", "orphaned folders"],
];

/**
 * "3 worktrees", "1 branch", "2 Safe worktrees and 1 branch", or "2 worktrees, 1 branch and 1 orphaned folder",
 * counting branches without a worktree and orphans apart. The adjective goes on the first kind only.
 */
export function rowsLabel(rows: WorktreeRow[], adjective = ""): string {
  const parts = ROW_KINDS.map(([kind, singular, plural]) => {
    const count = rows.filter((row) => row.kind === kind).length;
    return { count, singular, plural };
  }).filter((part) => part.count);
  if (!parts.length) return countLabel(0, `${adjective ? `${adjective} ` : ""}worktree`);
  const labels = parts.map(({ count, singular, plural }, index) => {
    const kind = index === 0 && adjective ? `${adjective} ` : "";
    return countLabel(count, `${kind}${singular}`, `${kind}${plural}`);
  });
  return labels.length === 1
    ? labels[0]!
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

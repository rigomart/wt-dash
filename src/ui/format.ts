import { assess } from "../core/assess";
import type { WorktreeRow } from "../core/types";

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

export function branchLabel(row: WorktreeRow): string {
  if (row.branch) return row.branch;
  return row.headSha ? `detached @${row.headSha.slice(0, 7)}` : "detached";
}

export function homePath(path: string, home: string): string {
  return home && (path === home || path.startsWith(home + "/"))
    ? "~" + path.slice(home.length)
    : path;
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

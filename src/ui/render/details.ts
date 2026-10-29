import { assess, markerNote, removalBlockReason } from "../../core/assess";
import type { ToolName, WorktreeRow } from "../../core/types";
import { isSizing } from "../../core/view";
import {
  agoLabel,
  branchLabel,
  changesLabel,
  countLabel,
  homePath,
  porcelainPath,
  sizeLabel,
  statusLabel,
  upstreamLabel,
} from "../format";
import { cell, clip, middle, rule, seg, textWidth, wrap, type Line, type Style } from "../line";
import { inJob } from "../selectors";
import type { UiState } from "../state";
import { verdictColor } from "../theme";
import { dim } from "./common";
import { bottomPanelHeight, pad, type RenderContext } from "./layout";
import { removalStatus } from "./status";
import { keyHints } from "./chrome";

export interface Body {
  lines: Line[];
  below: number;
}

export function withDetails(
  ctx: RenderContext,
  height: number,
  list: (ctx: RenderContext, height: number) => Body,
  details: (width: number) => Line[],
): Body {
  const { width } = ctx;
  const strip = bottomPanelHeight(height);
  if (!strip) return list(ctx, height);
  const listHeight = height - strip;
  const result = list(ctx, listHeight);
  return {
    lines: [
      ...pad(result.lines, listHeight),
      rule(width, result.below ? `↓ ${result.below} more` : "", { dim: true }),
      ...pad(details(width - 2), strip - 1).map((line) => [seg("  "), ...line]),
    ],
    below: 0,
  };
}

export const TOOL_NAMES: Record<ToolName, string> = {
  Claude: "Claude Code",
  Codex: "Codex",
  t3: "t3",
  Other: "other",
};

const SUMMARY_FILE_LINES = 2;

export function worktreeSummary(
  row: WorktreeRow | null,
  state: UiState,
  ctx: RenderContext,
  width: number,
): Line[] {
  const { theme, now, home } = ctx;
  if (!row) return [[dim("No worktree in view")]];
  const color = verdictColor(theme, row.verdict);
  const changes = changesLabel(row);
  const commit = `last commit ${agoLabel(row.committedAt, now)}${row.headSha ? ` · ${row.headSha.slice(0, 7)}` : ""}`;
  const lines: Line[] = [
    [
      seg(branchLabel(row), { bold: true }),
      dim(state.screen.kind === "all" ? ` · ${row.repoName}  ` : "  "),
      seg(`● ${row.verdict} · ${statusLabel(row)}`, { fg: color }),
    ],
    row.path === null
      ? [dim(`Branch without a worktree · created ${agoLabel(row.createdAt, now)}`)]
      : [dim(middle(homePath(row.path, home), width))],
    row.path === null
      ? [dim(`${commit} · ${upstreamLabel(row)}`)]
      : [
          dim(`${TOOL_NAMES[row.tool]} · ${commit} · `),
          seg(changes, { fg: changes === "clean" ? theme.safe : theme.review }),
          dim(` · ${upstreamLabel(row)}`),
        ],
  ];
  const failure = state.failures[row.id];
  if (failure)
    lines.push([seg(clip(`Last removal failed: ${failure}`, width), { fg: theme.broken })]);
  const blocked = ctx.canAct && !inJob(state, row.id) ? removalBlockReason(row) : null;
  if (blocked && row.verdict !== "Broken")
    lines.push([seg(clip(`Can't be removed: ${blocked}`, width), { fg: theme.review })]);
  if (ctx.canAct && row.kind === "worktree")
    lines.push(...pad(summaryFiles(row, state, ctx, width), SUMMARY_FILE_LINES));
  const mark = markerNote(row, now);
  if (mark) lines.push([dim(clip(mark, width))]);
  return lines;
}

function summaryFiles(row: WorktreeRow, state: UiState, ctx: RenderContext, width: number): Line[] {
  const { theme } = ctx;
  const files = state.files[row.id];
  if (!files || files.kind === "loading") return [[dim("checking files…")]];
  if (files.kind === "error") return [[dim(clip(files.message, width))]];
  const { localFiles, ignoredFiles, disposableIgnored } = files.report;
  const lines: Line[] = [];
  if (!localFiles.length) lines.push([seg("nothing uncommitted", { fg: theme.safe })]);
  else {
    const label = "uncommitted  ";
    const names = localFiles.map(porcelainPath);
    let shown = "";
    let count = 0;
    for (const name of names) {
      const next = shown ? `${shown}  ${name}` : name;
      const more = names.length - count - 1 ? ` +${names.length - count - 1} more` : "";
      if (count && textWidth(label + next + more) > width) break;
      shown = next;
      count++;
    }
    lines.push([
      seg(label, { fg: theme.review }),
      seg(shown),
      dim(count < names.length ? ` +${names.length - count} more` : ""),
    ]);
  }
  const ignored = ignoredSummary(ignoredFiles, disposableIgnored);
  if (ignored) lines.push([dim(clip(`ignored  ${ignored}`, width))]);
  return lines;
}

function actionLines(
  row: WorktreeRow,
  state: UiState,
  ctx: RenderContext,
  width: number,
  canExpand: boolean,
): Line[] {
  const { theme } = ctx;
  const blocked = ctx.canAct && !inJob(state, row.id) ? removalBlockReason(row) : null;
  if (blocked && row.verdict === "Broken" && !state.selected.size)
    return [keyHints(theme, [["enter", "prune"], ...expandHint(state, canExpand)])];
  if (blocked)
    return wrap(`Can't be removed: ${blocked}`, width).map((text) => [
      seg(text, { fg: theme.review }),
    ]);
  if (ctx.canAct && !inJob(state, row.id)) {
    return [
      keyHints(theme, [
        ["space", state.selected.has(row.id) ? "deselect" : "select"],
        ["enter", "remove"],
        ...expandHint(state, canExpand),
      ]),
    ];
  }
  if (!ctx.canAct) return [keyHints(theme, [["R", "remeasure"], ...expandHint(state, canExpand)])];
  return [];
}

const LABEL_WIDTH = 14;

export function field(label: string, value: string, width: number, look: Style = {}): Line[] {
  return wrap(value, Math.max(8, width - LABEL_WIDTH)).map((text, index) => [
    cell(index ? "" : label, LABEL_WIDTH, { dim: true }),
    seg(text, look),
  ]);
}

function fileField(
  label: string,
  items: string[],
  width: number,
  look: Style,
  maxLines = 3,
): Line[] {
  const lines = field(label, items.join("  "), width, look);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept.push([cell("", LABEL_WIDTH), dim(`+ more (${items.length} total)`)]);
  return kept;
}

function filesSection(row: WorktreeRow, state: UiState, ctx: RenderContext, width: number): Line[] {
  const { theme } = ctx;
  const files = state.files[row.id];
  if (!files || files.kind === "loading") return field("FILES", "checking…", width, { dim: true });
  if (files.kind === "error") return field("FILES", files.message, width, { dim: true });
  const report = files.report;
  const lines: Line[] = report.localFiles.length
    ? fileField("UNCOMMITTED", report.localFiles.map(porcelainPath), width, { fg: theme.review })
    : field("UNCOMMITTED", "none", width, { fg: theme.safe });
  const ignored = ignoredSummary(report.ignoredFiles, report.disposableIgnored);
  if (ignored) lines.push(...field("IGNORED", ignored, width, { dim: true }));
  return lines;
}

/** Ignored files are informational: Worktrunk removes them with the worktree without asking. */
function ignoredSummary(files: string[], caches: number): string {
  const shown = files.slice(0, 3).join("  ");
  const more = files.length > 3 ? ` +${files.length - 3} more` : "";
  const cacheNote = caches
    ? `${files.length ? " · " : ""}${countLabel(caches, "cache folder")}`
    : "";
  return shown + more + cacheNote;
}

export function detailLines(
  row: WorktreeRow | null,
  state: UiState,
  ctx: RenderContext,
  width: number,
  canExpand: boolean,
): Line[] {
  const { theme, now } = ctx;
  if (!row) return [[dim("No worktree in view")]];
  const assessment = assess(row);
  const color = verdictColor(theme, row.verdict);
  const lines: Line[] = [
    ...wrap(`${row.repoName} / ${branchLabel(row)}`, width).map((text) => [
      seg(text, { bold: true }),
    ]),
    [seg("● ", { fg: color }), seg(`${row.verdict} · ${statusLabel(row)}`, { fg: color })],
    ...wrap(assessment.reason, width - 2).map((text) => [dim(`  ${text}`)]),
    [],
    [dim("PATH")],
    ...(row.path === null
      ? [[dim("none; a branch without a worktree")]]
      : wrap(homePath(row.path, ctx.home), width).map((text) => [seg(text)])),
    [],
    ...(row.path === null
      ? field("CREATED", agoLabel(row.createdAt, now), width)
      : field("CREATED BY", TOOL_NAMES[row.tool], width)),
    ...field(
      "LAST COMMIT",
      agoLabel(row.committedAt, now) + (row.headSha ? ` · ${row.headSha.slice(0, 7)}` : ""),
      width,
    ),
    ...(row.path === null
      ? []
      : field(
          "CHANGES",
          changesLabel(row),
          width,
          changesLabel(row) === "clean" ? { fg: theme.safe } : { fg: theme.review },
        )),
    ...field("UPSTREAM", upstreamLabel(row), width),
    ...(row.locked && assessment.status !== "locked"
      ? field("LOCK", row.lockReason ?? "no lock reason supplied", width)
      : []),
    ...(row.path === null
      ? []
      : field(
          "SIZE",
          row.sizeMeasuredAt
            ? `${sizeLabel(row.sizeKiB)} · measured ${agoLabel(row.sizeMeasuredAt, now)}`
            : isSizing(ctx.snapshot, row)
              ? `${sizeLabel(row.sizeKiB)} · measuring…`
              : "not measured",
          width,
        )),
  ];
  const mark = markerNote(row, now);
  if (mark) lines.push(...field("MARK", mark, width));
  if (ctx.canAct && row.kind === "worktree")
    lines.push([], ...filesSection(row, state, ctx, width));
  lines.push([]);
  const failure = state.failures[row.id];
  const status = removalStatus(state, row.id, theme);
  if (failure) lines.push(...field("LAST REMOVAL", failure, width, { fg: theme.broken }), []);
  else if (status) lines.push(...field("REMOVAL", status.label, width, status.style), []);
  lines.push(...actionLines(row, state, ctx, width, canExpand));
  return lines;
}

function expandHint(state: UiState, canExpand: boolean): Array<[string, string]> {
  if (state.expanded) return [["i", "back"]];
  return canExpand ? [["i", "more"]] : [];
}

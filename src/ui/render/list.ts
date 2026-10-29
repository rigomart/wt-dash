import type { RGBA } from "@opentui/core";
import { assess } from "../../core/assess";
import { removalBlockReason } from "../../core/actions";
import type { Verdict, WorktreeRow } from "../../core/types";
import { ageLabel, branchLabel, rowsLabel, sizeLabel, statusLabel } from "../format";
import { cell, clip, fitLine, middle, rule, seg, spread, textWidth, type Line } from "../line";
import {
  isGrouped,
  listScreen,
  listView,
  scopedRows,
  visibleRows,
  type ListView,
  type Section,
} from "../selectors";
import { VERDICTS, type UiState } from "../state";
import { verdictColor } from "../theme";
import { dim, spinner } from "./common";
import { bodyHeightFor, pad, type RenderContext, type Viewport } from "./layout";
import { removalStatus } from "./status";
import { headerLine, keyHints, listFooter, meterLine, statusLine, tabsLine } from "./chrome";
import { detailLines, withDetails, worktreeSummary, type Body } from "./details";

export function renderList(state: UiState, ctx: RenderContext, viewport: Viewport): Line[] {
  const { width } = ctx;
  const view = listView(state, ctx.snapshot);
  const bodyHeight = bodyHeightFor(ctx.height);
  const { lines, below } = listColumn(state, view, ctx, bodyHeight, viewport, true);
  return [
    headerLine(state, ctx, state.screen, scopedRows(state, ctx.snapshot)),
    ...lines,
    rule(width, below ? `↓ ${below} more` : "", { dim: true }),
    statusLine(state, ctx),
    listFooter(state, ctx, view.focus, false),
  ];
}

export function listColumn(
  state: UiState,
  view: ListView,
  ctx: RenderContext,
  bodyHeight: number,
  viewport: Viewport,
  details: boolean,
): Body {
  const top: Line[] = [tabsLine(state, view, ctx), meterLine(scopedRows(state, ctx.snapshot), ctx)];
  if (state.expanded) {
    const lines = detailLines(view.focus, state, ctx, ctx.width, true);
    const scroll = Math.max(0, Math.min(state.detailTop, lines.length - bodyHeight));
    return {
      lines: [...top, ...pad(lines.slice(scroll, scroll + bodyHeight), bodyHeight)],
      below: Math.max(0, lines.length - scroll - bodyHeight),
    };
  }
  const list = (listCtx: RenderContext, height: number) =>
    sectionLines(state, view, listCtx, height, viewport);
  const { lines, below } = details
    ? withDetails(ctx, bodyHeight, list, (panelWidth) =>
        worktreeSummary(view.focus, state, ctx, panelWidth),
      )
    : list(ctx, bodyHeight);
  return { lines: [...top, ...pad(lines, bodyHeight)], below };
}

const SECTION_TITLES: Record<Verdict, { icon: string; gloss: string }> = {
  Safe: { icon: "✓", gloss: "can go" },
  Review: { icon: "?", gloss: "needs a look" },
  Busy: { icon: "‖", gloss: "finish the Git operation first" },
  Broken: { icon: "✗", gloss: "folder missing; prune the record" },
};

function sectionHeader(section: Section, state: UiState, ctx: RenderContext): Line {
  const { theme, width } = ctx;
  const kib = section.rows.reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
  const summary = dim(`  ${rowsLabel(section.rows)} · ${sizeLabel(kib)}`);
  if (section.kind === "verdict") {
    const { icon, gloss } = SECTION_TITLES[section.verdict];
    const left: Line = [
      seg(`${icon} ${section.verdict.toUpperCase()}`, {
        fg: verdictColor(theme, section.verdict),
        bold: true,
      }),
      summary,
      dim(` · ${gloss}`),
    ];
    const right =
      section.verdict === "Safe" && ctx.canAct ? keyHints(theme, [["a", "select all"]]) : [];
    return spread(left, right, width);
  }
  const counts: Line = VERDICTS.flatMap((verdict) => {
    const count = section.rows.filter((row) => row.verdict === verdict).length;
    return count
      ? [seg(`  ${count} ${verdict.toLowerCase()}`, { fg: verdictColor(theme, verdict) })]
      : [];
  });
  return spread([seg(`▸ ${section.repoName}`, { bold: true }), summary], counts, width);
}

interface Columns {
  dot: number;
  branch: number;
  repo: number;
  reason: number;
  age: number;
  size: number;
}

function columns(width: number, grouped: boolean, showRepo: boolean): Columns {
  const dot = grouped ? 2 : 0;
  const size = 10;
  const age = width >= 72 ? 5 : 0;
  const repo = showRepo && !grouped && width >= 96 ? 13 : 0;
  let branch = Math.max(12, Math.min(32, Math.floor(width * 0.26)));
  let reason = width - 4 - dot - branch - repo - age - size;
  if (reason < 8) {
    branch += Math.max(0, reason);
    reason = 0;
  }
  return { dot, branch, repo, reason, age, size };
}

function rowLine(
  row: WorktreeRow,
  cols: Columns,
  state: UiState,
  ctx: RenderContext,
  focused: boolean,
): Line {
  const { theme } = ctx;
  const color = verdictColor(theme, row.verdict);
  const status = removalStatus(state, row.id, theme);
  const confirming =
    state.confirm?.kind === "remove" &&
    state.confirm.ready.some((entry) => entry.row.id === row.id);
  const parts: Line = [focused ? seg("▌ ", { fg: theme.accent }) : seg("  ")];
  if (!ctx.canAct) parts.push(seg("  "));
  else if (status) parts.push(seg(`${status.icon} `, status.style));
  else if (confirming) parts.push(seg("■ ", { fg: theme.accent }));
  else if (state.selected.has(row.id)) parts.push(seg("■ ", { fg: theme.safe }));
  else parts.push(dim(removalBlockReason(row) ? "– " : "□ "));
  if (cols.dot) parts.push(seg("● ", { fg: color }));
  parts.push(
    cell(middle(branchLabel(row), cols.branch - 1), cols.branch - 1, {
      bold: focused,
      dim: status?.done,
    }),
    seg(" "),
  );
  if (cols.repo) parts.push(cell(row.repoName, cols.repo - 1, { dim: true }), seg(" "));
  if (cols.reason) {
    if (status) parts.push(cell(status.label, cols.reason - 1, status.style));
    else parts.push(...reasonCell(row, cols.reason - 1, color));
    parts.push(seg(" "));
  }
  if (cols.age)
    parts.push(cell(ageLabel(row.committedAt, ctx.now), cols.age, { dim: true }, "right"));
  parts.push(cell(rowSize(row), cols.size, { dim: row.sizeKiB === null || status?.done }, "right"));
  return fitLine(parts, ctx.width, focused ? { bg: theme.focusBg } : undefined);
}

export function rowSize(row: WorktreeRow): string {
  return row.kind === "branch" ? "branch" : sizeLabel(row.sizeKiB);
}

function reasonCell(row: WorktreeRow, width: number, color: RGBA): Line {
  const label = statusLabel(row, width);
  const assessment = assess(row);
  const reason =
    row.locked && assessment.status === "locked"
      ? (row.lockReason ?? "no reason given")
      : assessment.reason.replace(/\.$/, "");
  const rest = width - textWidth(label) >= 16 ? clip(`  ${reason}`, width - textWidth(label)) : "";
  return [seg(label, { fg: color }), ...fitLine([dim(rest)], width - textWidth(label))];
}

function emptyMessage(state: UiState, ctx: RenderContext): Line {
  const { snapshot } = ctx;
  const screen = listScreen(state, snapshot);
  const listing =
    snapshot.progress.phase === "scanning" &&
    (screen.kind === "project"
      ? !snapshot.errors[screen.repoPath] &&
        !snapshot.rows.some((row) => row.repoPath === screen.repoPath)
      : !snapshot.rows.length);
  if (listing)
    return [
      seg(spinner(state), { fg: ctx.theme.accent }),
      seg(screen.kind === "project" ? " Listing worktrees…" : " Scanning repositories…"),
    ];
  if (!snapshot.rows.length) {
    return snapshot.progress.phase === "scanning" || snapshot.progress.phase === "idle"
      ? [seg(spinner(state), { fg: ctx.theme.accent }), seg(" Scanning repositories…")]
      : [dim("No worktrees found.")];
  }
  if (!visibleRows(state, snapshot).length) return [dim("Every worktree is being removed.")];
  if (state.search && state.tab === "All")
    return [dim(`No worktrees match “${state.search}”. Esc clears the search.`)];
  return [
    dim(
      `No ${state.tab} worktrees${state.search ? ` match “${state.search}”` : ""}. Press 1 to see all.`,
    ),
  ];
}

function sectionLines(
  state: UiState,
  view: ListView,
  ctx: RenderContext,
  height: number,
  viewport: Viewport,
): { lines: Line[]; below: number } {
  if (!view.rows.length) return { lines: [[], emptyMessage(state, ctx)], below: 0 };
  const cols = columns(
    ctx.width,
    isGrouped(state, ctx.snapshot),
    listScreen(state, ctx.snapshot).kind === "all",
  );
  const lines: Line[] = [];
  const isRow: boolean[] = [];
  const push = (line: Line, row = false) => {
    lines.push(line);
    isRow.push(row);
  };
  let focusStart = 0;
  view.sections.forEach((section, index) => {
    if (index) push([]);
    push(sectionHeader(section, state, ctx));
    for (const row of section.rows) {
      const focused = row.id === view.focus?.id;
      if (focused) focusStart = lines.length;
      push(rowLine(row, cols, state, ctx, focused), true);
    }
  });
  const focusEnd = focusStart + 1;
  let top = viewport.listTop;
  const want = isRow[focusStart - 1] ? focusStart : focusStart - 1;
  if (want < top) top = want;
  if (focusEnd > top + height) top = Math.min(focusStart, focusEnd - height);
  top = Math.max(0, Math.min(top, lines.length - height));
  viewport.listTop = top;
  return {
    lines: lines.slice(top, top + height),
    below: isRow.slice(top + height).filter(Boolean).length,
  };
}

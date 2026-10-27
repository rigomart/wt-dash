import type { RGBA } from "@opentui/core";
import { assess } from "../core/assess";
import { removalBlockReason, type RemovalEntry } from "../core/actions";
import type { DashboardSnapshot, ToolName, Verdict, WorktreeRow } from "../core/types";
import {
  ageLabel, agoLabel, branchLabel, changesLabel, clockLabel, countLabel,
  homePath, porcelainPath, sizeLabel, upstreamLabel, statusLabel,
} from "./format";
import { cell, clip, fitLine, lineWidth, middle, rule, seg, sliceLine, spread, textWidth, wrap, type Line, type Style } from "./line";
import {
  TABS, VERDICTS, inJob, jobStatus, listView, visibleRows,
  type Confirm, type ListView, type RunStatus, type Section, type Tab, type Toast, type UiState,
} from "./model";
import { verdictColor, type Theme } from "./theme";

export interface RenderContext {
  snapshot: DashboardSnapshot;
  width: number;
  height: number;
  now: number;
  theme: Theme;
  home: string;
  canAct: boolean;
}
/** Scroll offsets that persist between frames so the list does not jump. */
export interface Viewport { listTop: number }

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function render(state: UiState, ctx: RenderContext, viewport: Viewport): Line[] {
  const width = Math.max(20, ctx.width);
  const height = Math.max(8, ctx.height);
  const sized = { ...ctx, width, height };
  const lines = pad(renderList(state, sized, viewport), height).map((line) => fitLine(line, width));
  if (state.help) return withHelp(lines, state, sized);
  return state.confirm ? withConfirm(lines, state, state.confirm, sized) : lines;
}

/** Rows the list shows at once; used for page up/down. */
export function listPageSize(height: number): number {
  return Math.max(1, height - 12);
}

function pad(lines: Line[], height: number): Line[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push([]);
  return out;
}

const key = (theme: Theme, text: string): Line[number] => seg(text, { fg: theme.accent, bold: true });
const dim = (text: string): Line[number] => seg(text, { dim: true });
const spinner = (state: UiState) => SPINNER[state.frame % SPINNER.length]!;

function keyHints(theme: Theme, pairs: Array<[string, string]>): Line {
  return pairs.flatMap(([name, action], index) => [
    ...(index ? [seg("  ")] : []), key(theme, name), dim(` ${action}`),
  ]);
}

function quitHint(theme: Theme): Line {
  return keyHints(theme, [["?", "keys"], ["q", "quit"]]);
}

function toastLine(theme: Theme, toast: Toast): Line {
  const style: Record<Toast["tone"], [string, Style]> = {
    info: ["", {}],
    ok: ["✓ ", { fg: theme.safe }],
    warn: ["! ", { fg: theme.review, bg: theme.toastBg }],
    error: ["✗ ", { fg: theme.broken, bg: theme.toastBg }],
  };
  const [icon, look] = style[toast.tone];
  return [seg(` ${icon}${toast.text} `, look)];
}

function selectedKiB(state: UiState, snapshot: DashboardSnapshot): number {
  return snapshot.rows.filter((row) => state.selected.has(row.id)).reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
}

// ─── Main list ────────────────────────────────────────────────────────────────

function bodyHeightFor(state: UiState, ctx: RenderContext): number {
  const top = 3 + (bannerLine(ctx) ? 1 : 0);
  const footer = 1 + (state.jobs.length ? 1 : 0);
  return Math.max(1, ctx.height - top - 1 - footer);
}

function renderList(state: UiState, ctx: RenderContext, viewport: Viewport): Line[] {
  const { width } = ctx;
  const view = listView(state, ctx.snapshot);
  const top: Line[] = [headerLine(state, ctx), tabsLine(state, view, ctx)];
  const banner = bannerLine(ctx);
  if (banner) top.push(banner);
  top.push(meterLine(state, ctx));
  const footer = [...(state.jobs.length ? [progressLine(state, ctx)] : []), listFooter(state, ctx, view.focus)];
  const bodyHeight = bodyHeightFor(state, ctx);
  let body: Line[];
  let below = 0;
  if (state.expanded) {
    const lines = detailLines(view.focus, state, ctx, width, true);
    const scroll = Math.max(0, Math.min(state.detailTop, lines.length - bodyHeight));
    body = lines.slice(scroll, scroll + bodyHeight);
    below = Math.max(0, lines.length - scroll - bodyHeight);
  } else ({ lines: body, below } = sectionLines(state, view, ctx, bodyHeight, viewport));
  const bottom = rule(width, below ? `↓ ${below} more` : "", { dim: true });
  return [...top, ...pad(body, bodyHeight), bottom, ...footer];
}

function headerLine(state: UiState, ctx: RenderContext): Line {
  const { snapshot, theme } = ctx;
  const progress = snapshot.progress;
  const rows = visibleRows(state, snapshot);
  const total = rows.reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
  const unknown = rows.filter((row) => row.sizeKiB === null).length;
  const status: Line = progress.phase === "scanning"
    ? [seg(spinner(state), { fg: theme.accent }), dim(` scanning ${progress.reposDone}/${progress.reposTotal} repos`)]
    : progress.phase === "error" ? [seg("scan failed", { fg: theme.broken })]
    : progress.phase === "complete" ? [dim(`scanned ${clockLabel(progress.completedAt)}  `), key(theme, "r"), dim(" rescan")]
    : [dim("starting…")];
  const summary = `${countLabel(rows.length, "worktree")} · up to ${sizeLabel(total)}`
    + (unknown ? ` · ${unknown} sizing` : "") + " · ";
  return spread([seg("wt-dash", { bold: true })], [dim(summary), ...status], ctx.width, "right");
}

function tabsLine(state: UiState, view: ListView, ctx: RenderContext): Line {
  const { theme, width, snapshot } = ctx;
  const short: Record<Tab, string> = { All: "All", Safe: "Safe", Review: "Rev", Busy: "Busy", Broken: "Brk" };
  const tone: Record<Tab, Style> = {
    All: {}, Safe: { fg: theme.safe }, Review: { fg: theme.review }, Busy: { fg: theme.busy }, Broken: { fg: theme.broken },
  };
  const left: Line = TABS.flatMap((tab) => {
    const count = view.counts[tab];
    let label = `${width < 64 ? short[tab] : tab} ${count}`;
    if (tab === "Safe" && width >= 100 && view.safeKiB) label += ` · ${sizeLabel(view.safeKiB)}`;
    const look: Style = tab === state.tab ? { reverse: true, bold: true } : { ...tone[tab], dim: count === 0 };
    return [seg(` ${label} `, look)];
  });
  let right: Line;
  if (state.searching) {
    right = [key(theme, "/ "), seg(state.search), seg(" ", { reverse: true }), dim(`  ${view.rows.length} of ${snapshot.rows.length}`)];
  } else if (state.search) {
    right = [key(theme, "/ "), seg(state.search, { bold: true }), dim("  esc clears")];
  } else right = [key(theme, "/"), dim(" search")];
  return spread(left, right, width, state.searching || state.search ? "right" : "left");
}

function meterLine(state: UiState, ctx: RenderContext): Line {
  const { snapshot, theme, width } = ctx;
  const rows = visibleRows(state, snapshot);
  const kib = (verdict: Verdict) => rows.filter((row) => row.verdict === verdict).reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
  const total = VERDICTS.reduce((sum, verdict) => sum + kib(verdict), 0);
  if (!total) return rule(width);
  const meter: Line = [];
  let used = 0;
  let running = 0;
  for (const verdict of VERDICTS) {
    running += kib(verdict);
    const end = Math.round((running / total) * width);
    if (end > used) meter.push(seg("━".repeat(end - used), { fg: verdictColor(theme, verdict) }));
    used = Math.max(used, end);
  }
  return fitLine(meter, width);
}

function bannerLine(ctx: RenderContext): Line | null {
  const { snapshot, theme } = ctx;
  if (snapshot.fatalError) return [seg(`✗ ${snapshot.fatalError}`, { fg: theme.broken })];
  const errors = Object.entries(snapshot.errors);
  if (!errors.length) return null;
  const [repo, message] = errors[0]!;
  return [seg(`! ${countLabel(errors.length, "repo")} failed to scan: ${repo.split("/").at(-1)}: ${message}`, { fg: theme.review })];
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
  const summary = dim(`  ${countLabel(section.rows.length, "worktree")} · ${sizeLabel(kib)}`);
  if (section.kind === "verdict") {
    const { icon, gloss } = SECTION_TITLES[section.verdict];
    const left: Line = [seg(`${icon} ${section.verdict.toUpperCase()}`, { fg: verdictColor(theme, section.verdict), bold: true }), summary, dim(` · ${gloss}`)];
    const right = section.verdict === "Safe" && ctx.canAct ? keyHints(theme, [["a", "select all"]]) : [];
    return spread(left, right, width);
  }
  const counts: Line = VERDICTS.flatMap((verdict) => {
    const count = section.rows.filter((row) => row.verdict === verdict).length;
    return count ? [seg(`  ${count} ${verdict.toLowerCase()}`, { fg: verdictColor(theme, verdict) })] : [];
  });
  return spread([seg(`▸ ${section.repoName}`, { bold: true }), summary], counts, width);
}

interface Columns { dot: number; branch: number; repo: number; reason: number; age: number; size: number }

function columns(width: number, grouped: boolean): Columns {
  const dot = grouped ? 2 : 0;
  const size = 10;
  const age = width >= 72 ? 5 : 0;
  const repo = !grouped && width >= 96 ? 13 : 0;
  let branch = Math.max(12, Math.min(32, Math.floor(width * 0.26)));
  let reason = width - 4 - dot - branch - repo - age - size;
  if (reason < 8) { branch += Math.max(0, reason); reason = 0; }
  return { dot, branch, repo, reason, age, size };
}

function rowLine(row: WorktreeRow, cols: Columns, state: UiState, ctx: RenderContext, focused: boolean): Line {
  const { theme } = ctx;
  const color = verdictColor(theme, row.verdict);
  const status = removalStatus(state, row.id, theme);
  const confirming = state.confirm?.kind === "remove" && state.confirm.ready.some((entry) => entry.row.id === row.id);
  const parts: Line = [focused ? seg("▌ ", { fg: theme.accent }) : seg("  ")];
  if (!ctx.canAct) parts.push(seg("  "));
  else if (status) parts.push(seg(`${status.icon} `, status.style));
  else if (confirming) parts.push(seg("■ ", { fg: theme.accent }));
  else if (state.selected.has(row.id)) parts.push(seg("■ ", { fg: theme.safe }));
  else parts.push(dim(removalBlockReason(row) ? "– " : "□ "));
  if (cols.dot) parts.push(seg("● ", { fg: color }));
  parts.push(cell(middle(branchLabel(row), cols.branch - 1), cols.branch - 1, { bold: focused, dim: status?.done }), seg(" "));
  if (cols.repo) parts.push(cell(row.repoName, cols.repo - 1, { dim: true }), seg(" "));
  if (cols.reason) {
    if (status) parts.push(cell(status.label, cols.reason - 1, status.style));
    else parts.push(...reasonCell(row, cols.reason - 1, color));
    parts.push(seg(" "));
  }
  if (cols.age) parts.push(cell(ageLabel(row.committedAt, ctx.now), cols.age, { dim: true }, "right"));
  parts.push(cell(sizeLabel(row.sizeKiB), cols.size, { dim: row.sizeKiB === null || status?.done }, "right"));
  return fitLine(parts, ctx.width, focused ? { bg: theme.focusBg } : undefined);
}

function reasonCell(row: WorktreeRow, width: number, color: RGBA): Line {
  const label = statusLabel(row, width);
  const assessment = assess(row);
  const reason = row.locked && assessment.status === "locked" ? row.lockReason ?? "no reason given" : assessment.reason.replace(/\.$/, "");
  const rest = width - textWidth(label) >= 16 ? clip(`  ${reason}`, width - textWidth(label)) : "";
  return [seg(label, { fg: color }), ...fitLine([dim(rest)], width - textWidth(label))];
}

interface RowStatus { icon: string; label: string; style: Style; done: boolean }

/** A row's place in a running removal, or why the last attempt left it in place. */
function removalStatus(state: UiState, id: string, theme: Theme): RowStatus | null {
  const running = jobStatus(state, id);
  const look: Record<RunStatus, RowStatus> = {
    waiting: { icon: "◦", label: "queued", style: { dim: true }, done: false },
    removing: { icon: SPINNER[state.frame % SPINNER.length]!, label: "removing…", style: { fg: theme.accent }, done: false },
    removed: { icon: "✓", label: "removed", style: { fg: theme.safe }, done: true },
    failed: { icon: "✗", label: "removal failed", style: { fg: theme.broken }, done: false },
    skipped: { icon: "!", label: "not removed", style: { fg: theme.review }, done: false },
    unverified: { icon: "?", label: "check result", style: { fg: theme.review }, done: false },
  };
  if (running) return look[running];
  if (state.failures[id]) return { ...look.failed, icon: "✗" };
  return null;
}

function emptyMessage(state: UiState, ctx: RenderContext): Line {
  const { snapshot } = ctx;
  if (!snapshot.rows.length) {
    return snapshot.progress.phase === "scanning" || snapshot.progress.phase === "idle"
      ? [seg(spinner(state), { fg: ctx.theme.accent }), seg(" Scanning repositories…")]
      : [dim("No worktrees found.")];
  }
  if (!visibleRows(state, snapshot).length) return [dim("Every worktree is being removed.")];
  if (state.search && state.tab === "All") return [dim(`No worktrees match “${state.search}”. Esc clears the search.`)];
  return [dim(`No ${state.tab} worktrees${state.search ? ` match “${state.search}”` : ""}. Press 1 to see all.`)];
}

function sectionLines(state: UiState, view: ListView, ctx: RenderContext, height: number,
  viewport: Viewport): { lines: Line[]; below: number } {
  if (!view.rows.length) return { lines: [[], emptyMessage(state, ctx)], below: 0 };
  const cols = columns(ctx.width, state.grouped);
  const lines: Line[] = [];
  const isRow: boolean[] = [];
  const push = (line: Line, row = false) => { lines.push(line); isRow.push(row); };
  let focusStart = 0;
  let focusEnd = 0;
  view.sections.forEach((section, index) => {
    if (index) push([]);
    push(sectionHeader(section, state, ctx));
    for (const row of section.rows) {
      const focused = row.id === view.focus?.id;
      if (focused) focusStart = lines.length;
      push(rowLine(row, cols, state, ctx, focused), true);
      if (!focused) continue;
      for (const line of summaryLines(row, state, ctx, 4 + cols.dot)) push(line);
      focusEnd = lines.length;
    }
  });
  let top = viewport.listTop;
  const want = isRow[focusStart - 1] ? focusStart : focusStart - 1;
  if (want < top) top = want;
  if (focusEnd > top + height) top = Math.min(focusStart, focusEnd - height);
  top = Math.max(0, Math.min(top, lines.length - height));
  viewport.listTop = top;
  return { lines: lines.slice(top, top + height), below: isRow.slice(top + height).filter(Boolean).length };
}

const TOOL_NAMES: Record<ToolName, string> = { Claude: "Claude Code", Codex: "Codex", t3: "t3", Other: "other" };

function summaryLines(row: WorktreeRow, state: UiState, ctx: RenderContext, indent: number): Line[] {
  const { theme, width, now, home } = ctx;
  const inner = Math.max(8, width - indent - 1);
  const lines: Line[] = wrap(homePath(row.path, home), inner).map((text) => [dim(text)]);
  const changes = changesLabel(row);
  lines.push([
    dim(`${TOOL_NAMES[row.tool]} · last commit ${agoLabel(row.committedAt, now)}${row.headSha ? ` · ${row.headSha.slice(0, 7)}` : ""} · `),
    seg(changes, { fg: changes === "clean" ? theme.safe : theme.review }), dim(` · ${upstreamLabel(row)}`),
  ]);
  if (ctx.canAct) lines.push(...summaryFiles(row, state, ctx, inner));
  const failure = state.failures[row.id];
  if (failure) lines.push(...wrap(`Last removal failed: ${failure}`, inner).map((text) => [seg(text, { fg: theme.broken })]));
  lines.push(...actionLines(row, state, ctx, inner, true));
  return lines.map((line) => fitLine([seg(" ".repeat(indent)), ...line], width, { bg: theme.focusBg }));
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
    lines.push([seg(label, { fg: theme.review }), seg(shown), dim(count < names.length ? ` +${names.length - count} more` : "")]);
  }
  const ignored = ignoredSummary(ignoredFiles, disposableIgnored);
  if (ignored) lines.push([dim(clip(`ignored  ${ignored}`, width))]);
  return lines;
}

function actionLines(row: WorktreeRow, state: UiState, ctx: RenderContext, width: number, canExpand: boolean): Line[] {
  const { theme } = ctx;
  const blocked = ctx.canAct && !inJob(state, row.id) ? removalBlockReason(row) : null;
  if (blocked && row.verdict === "Broken" && !state.selected.size) return [keyHints(theme, [["enter", "prune"], ...expandHint(state, canExpand)])];
  if (blocked) return wrap(`Can't be removed: ${blocked}`, width).map((text) => [seg(text, { fg: theme.review })]);
  if (ctx.canAct && !inJob(state, row.id)) {
    return [keyHints(theme, [["space", state.selected.has(row.id) ? "deselect" : "select"], ["enter", "remove"], ...expandHint(state, canExpand)])];
  }
  if (!ctx.canAct) return [keyHints(theme, [["R", "remeasure"], ...expandHint(state, canExpand)])];
  return [];
}

const LABEL_WIDTH = 14;

function field(label: string, value: string, width: number, look: Style = {}): Line[] {
  return wrap(value, Math.max(8, width - LABEL_WIDTH)).map((text, index) =>
    [cell(index ? "" : label, LABEL_WIDTH, { dim: true }), seg(text, look)]);
}

function fileField(label: string, items: string[], width: number, look: Style, maxLines = 3): Line[] {
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
  const cacheNote = caches ? `${files.length ? " · " : ""}${countLabel(caches, "cache folder")}` : "";
  return shown + more + cacheNote;
}

function detailLines(row: WorktreeRow | null, state: UiState, ctx: RenderContext, width: number, canExpand: boolean): Line[] {
  const { theme, now } = ctx;
  if (!row) return [[dim("No worktree in view")]];
  const assessment = assess(row);
  const color = verdictColor(theme, row.verdict);
  const lines: Line[] = [
    ...wrap(`${row.repoName} / ${branchLabel(row)}`, width).map((text) => [seg(text, { bold: true })]),
    [seg("● ", { fg: color }), seg(`${row.verdict} · ${statusLabel(row)}`, { fg: color })],
    ...wrap(assessment.reason, width - 2).map((text) => [dim(`  ${text}`)]),
    [],
    [dim("PATH")],
    ...wrap(homePath(row.path, ctx.home), width).map((text) => [seg(text)]),
    [],
    ...field("CREATED BY", TOOL_NAMES[row.tool], width),
    ...field("LAST COMMIT", agoLabel(row.committedAt, now) + (row.headSha ? ` · ${row.headSha.slice(0, 7)}` : ""), width),
    ...field("CHANGES", changesLabel(row), width, changesLabel(row) === "clean" ? { fg: theme.safe } : { fg: theme.review }),
    ...field("UPSTREAM", upstreamLabel(row), width),
    ...(row.locked && assessment.status !== "locked" ? field("LOCK", row.lockReason ?? "no lock reason supplied", width) : []),
    ...field("SIZE", `${sizeLabel(row.sizeKiB)} · ${row.sizeMeasuredAt ? `measured ${agoLabel(row.sizeMeasuredAt, now)}` : "measuring…"}`, width),
  ];
  if (ctx.canAct) lines.push([], ...filesSection(row, state, ctx, width));
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

function progressLine(state: UiState, ctx: RenderContext): Line {
  const { theme, width } = ctx;
  const statuses = state.jobs.flatMap((job) => job.order.map((id) => job.status[id]!));
  const total = statuses.length;
  const done = statuses.filter((status) => status !== "waiting" && status !== "removing").length;
  const failed = statuses.filter((status) => status === "failed" || status === "skipped" || status === "unverified").length;
  const running = state.jobs.flatMap((job) => job.plan.entries).filter((entry) => jobStatus(state, entry.row.id) === "removing");
  const stopping = state.jobs.every((job) => job.stopping);
  const text = `Removing ${Math.min(done + 1, total)} of ${total}` + (running.length ? `: ${branchLabel(running[0]!.row)}` : "")
    + (running.length > 1 ? ` +${running.length - 1} more` : "");
  const barWidth = Math.max(0, Math.min(24, width - textWidth(text) - 40));
  const filled = total ? Math.round((done / total) * barWidth) : 0;
  const left: Line = [seg(spinner(state), { fg: theme.accent }), seg(` ${text}  `)];
  if (barWidth >= 6) left.push(seg("━".repeat(filled), { fg: theme.safe }), dim("━".repeat(barWidth - filled)), seg("  "));
  if (failed) left.push(seg(`${failed} not removed  `, { fg: theme.review }));
  const after = running.length > 1 ? "after current" : "after this one";
  const right: Line = stopping ? [seg(`stopping ${after}`, { fg: theme.review })] : keyHints(theme, [["esc", `stop ${after}`]]);
  return spread(left, right, width);
}

function listFooter(state: UiState, ctx: RenderContext, focus: WorktreeRow | null): Line {
  const { theme, width } = ctx;
  let left: Line;
  if (state.toast) left = toastLine(theme, state.toast);
  else if (state.confirm) left = keyHints(theme, [["y / enter", state.confirm.kind], ["esc", "cancel"]]);
  else if (state.pending) left = [seg(spinner(state), { fg: theme.accent }), seg(` ${state.pending.label}  `), ...keyHints(theme, [["esc", "cancel"]])];
  else if (state.pruning) left = [seg(spinner(state), { fg: theme.accent }), seg(" Pruning…")];
  else if (state.searching) left = [dim("type to filter  "), ...keyHints(theme, [["↑↓", "move"], ["enter", "keep"], ["esc", "clear"]])];
  else if (state.expanded) left = keyHints(theme, [["↑↓", "scroll"], ["i", "back"]]);
  else if (state.selected.size) {
    left = [seg("■ ", { fg: theme.safe }), seg(`${state.selected.size} selected`, { bold: true }),
      dim(` · up to ${sizeLabel(selectedKiB(state, ctx.snapshot))}   `), ...keyHints(theme, [["enter", "remove"], ["esc", "clear"]])];
  } else {
    const action: Array<[string, string]> = focus?.verdict === "Broken"
      ? [["enter", "prune"]] : [["space", "select"], ["enter", "remove"]];
    const view: Array<[string, string]> = [["/", "search"], ["v", state.grouped ? "by verdict" : "by repo"],
      ["s", `sort: ${state.sort} ${state.descending ? "↓" : "↑"}`]];
    left = keyHints(theme, ctx.canAct ? [...action, ["a", "all safe"], ...view] : view);
  }
  return spread(left, quitHint(theme), width, state.toast ? "left" : "right");
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────

function names(entries: RemovalEntry[]): string {
  const labels = entries.map((entry) => branchLabel(entry.row));
  return labels.length <= 2 ? labels.join(" and ") : `${labels.slice(0, 2).join(", ")} +${labels.length - 2} more`;
}

function withConfirm(base: Line[], state: UiState, confirm: Confirm, ctx: RenderContext): Line[] {
  const boxWidth = Math.min(ctx.width - 2, 76);
  const inner = boxWidth - 4;
  const { title, content, answer } = confirm.kind === "prune" ? pruneDialog(confirm, ctx, inner) : removeDialog(confirm, ctx, inner);
  const message = state.toast ? [toastLine(ctx.theme, state.toast), []] : [];
  return overlay(base, box(title, [...content, ...message, answer], " esc cancels ", boxWidth), ctx);
}

function buttons(theme: Theme, verb: string): Line {
  return [seg(` ${verb}  y / enter `, { fg: theme.broken, reverse: true, bold: true }), seg("   "),
    seg("[ "), seg("Cancel  esc", { bold: true }), seg(" ]")];
}

function pruneDialog(confirm: Extract<Confirm, { kind: "prune" }>, ctx: RenderContext, inner: number) {
  const repo = confirm.plan.repoPath.split("/").at(-1);
  return {
    title: `Prune ${countLabel(confirm.plan.records.length, "missing worktree record")} in ${repo}?`,
    content: [
      ...wrap("The folders are already gone; this removes only Git's records of them.", inner).map((text) => [dim(text)]),
      [],
    ],
    answer: buttons(ctx.theme, "Prune"),
  };
}

function removeDialog(confirm: Extract<Confirm, { kind: "remove" }>, ctx: RenderContext, inner: number) {
  const { theme } = ctx;
  const { ready, blocked } = confirm;
  const kib = ready.reduce((sum, entry) => sum + (entry.row.sizeKiB ?? 0), 0);
  const notes: Line[] = [];
  const dirty = ready.filter((entry) => entry.requiresDiscard);
  const warn = (text: string) => wrap(text, inner).map((part) => [seg(part, { fg: theme.review })]);
  if (dirty.length) notes.push(...warn(`! Discards uncommitted changes in ${names(dirty)}`));
  if (blocked.length) {
    notes.push(...warn(blocked.length === 1
      ? `! Skips ${names(blocked)}: ${blocked[0]!.blockedReason}`
      : `! Skips ${names(blocked)}, which changed or can't be removed`));
  }
  if (!dirty.length && !blocked.length) notes.push(...wrap("Nothing uncommitted. Ignored files and caches go with them.", inner).map((text) => [dim(text)]));
  const unmerged = ready.filter((entry) => entry.branchWillBeRetained);
  const merged = ready.filter((entry) => entry.row.branch !== null && !entry.branchWillBeRetained);
  const options: Line[] = [];
  if (unmerged.length) {
    const count = countLabel(unmerged.length, "unmerged branch", "unmerged branches");
    options.push([confirm.deleteUnmerged ? seg(`Also deletes ${count}  `, { fg: theme.review }) : dim(`Keeps ${count}  `),
      key(theme, "D"), dim(confirm.deleteUnmerged ? " keep them" : " delete too")]);
  } else if (merged.length) options.push([dim("Merged branches are deleted.")]);
  options.push([confirm.reap ? seg("Stops processes running inside  ", { fg: theme.review }) : dim("Processes inside keep running  "),
    key(theme, "e"), dim(confirm.reap ? " leave them" : " stop them")]);
  const tail: Line[] = [[], ...notes, [], ...options, []];
  const room = Math.max(1, ctx.height - 3 - tail.length);
  const shown = ready.length > room ? ready.slice(0, room - 1) : ready;
  const sizeWidth = 9;
  const repoWidth = inner >= 50 ? 14 : 0;
  const rows: Line[] = shown.map((entry) => [
    cell(`• ${middle(branchLabel(entry.row), inner - repoWidth - sizeWidth - 3)}`, inner - repoWidth - sizeWidth, entry.requiresDiscard ? { fg: theme.review } : {}),
    cell(entry.row.repoName, repoWidth, { dim: true }),
    cell(sizeLabel(entry.row.sizeKiB), sizeWidth, { dim: true }, "right"),
  ]);
  if (shown.length < ready.length) rows.push([dim(`  +${ready.length - shown.length} more`)]);
  return {
    title: `Remove ${countLabel(ready.length, "worktree")} · up to ${sizeLabel(kib)}?`,
    content: [...rows, ...tail],
    answer: buttons(theme, `Remove ${ready.length}`),
  };
}

function box(title: string, content: Line[], closing: string, boxWidth: number): Line[] {
  const inner = boxWidth - 4;
  const border: Style = { dim: true };
  const heading = ` ${clip(title, Math.max(1, boxWidth - 6))} `;
  return [
    [seg("╭─", border), seg(heading, { bold: true }), seg("─".repeat(Math.max(0, boxWidth - 3 - textWidth(heading))) + "╮", border)],
    ...content.map((line): Line => [seg("│ ", border), ...fitLine(line, inner), seg(" │", border)]),
    [seg("╰" + "─".repeat(Math.max(0, boxWidth - 3 - closing.length)), border), seg(closing, { dim: true }), seg("─╯", border)],
  ];
}

const DIALOG_ANSWER_AND_EDGE = 2;

function fitHeightKeepingEnd(lines: Line[], height: number, kept: number): Line[] {
  if (lines.length <= height) return lines;
  return [...lines.slice(0, Math.max(1, height - kept)), ...lines.slice(-kept)];
}

function overlay(base: Line[], lines: Line[], ctx: RenderContext): Line[] {
  const { width, height } = ctx;
  const boxWidth = lineWidth(lines[0] ?? []);
  const shown = fitHeightKeepingEnd(lines, height, DIALOG_ANSWER_AND_EDGE);
  const y = Math.max(0, Math.floor((height - shown.length) / 2));
  const x = Math.max(0, Math.floor((width - boxWidth) / 2));
  const faded: Line[] = base.map((line) => line.map((item) => seg(item.text, { dim: true })));
  shown.forEach((line, index) => {
    if (y + index >= height) return;
    faded[y + index] = [...sliceLine(faded[y + index]!, 0, x), ...fitLine(line, boxWidth), ...sliceLine(faded[y + index]!, x + boxWidth, width)];
  });
  return faded.map((line) => fitLine(line, width));
}

// ─── Key overlay ──────────────────────────────────────────────────────────────

function helpGroups(_state: UiState): Array<[string, Array<[string, string]>]> {
  return [
    ["MOVE", [["↑↓ j k", "row"], ["pgup pgdn", "page"], ["g G", "first / last"], ["i", "full details"]]],
    ["FIND", [["1-5 ← →", "verdict tab"], ["/", "search as you type"], ["s S", "sort / reverse"], ["v", "group by repo or verdict"]]],
    ["CLEAN UP", [["space", "select row"], ["a", "all Safe in view"], ["enter x", "remove selected or focused"], ["y enter", "confirm in the dialog"], ["D e", "dialog: branches · processes"], ["enter", "on Broken: prune record"]]],
    ["OTHER", [["esc", "undo one step"], ["r", "rescan all repos"], ["R", "remeasure size"], ["q ^C", "quit"]]],
  ];
}

function withHelp(base: Line[], state: UiState, ctx: RenderContext): Line[] {
  const { theme, width, height } = ctx;
  const boxWidth = Math.min(width - 2, 80);
  const inner = boxWidth - 4;
  const groups = helpGroups(state).map(([title, keys]) => [
    ...(title ? [[seg(title, { dim: true, bold: true })]] : [[]]),
    ...keys.map(([name, action]): Line => [cell(name, 11, { fg: theme.accent, bold: true }), seg(action)]),
  ]);
  let content: Line[];
  if (inner >= 60) {
    const half = Math.floor((inner - 2) / 2);
    const leftColumn = groups.filter((_, index) => index % 2 === 0).flatMap((group, index) => index ? [[], ...group] : group);
    const rightColumn = groups.filter((_, index) => index % 2 === 1).flatMap((group, index) => index ? [[], ...group] : group);
    const rows = Math.max(leftColumn.length, rightColumn.length);
    content = Array.from({ length: rows }, (_, index) => [...fitLine(leftColumn[index] ?? [], half), seg("  "), ...(rightColumn[index] ?? [])]);
  } else content = groups.flatMap((group, index) => index ? [[], ...group] : group);
  content.push([], [dim("Colors: "), seg("● safe  ", { fg: theme.safe }), seg("● review  ", { fg: theme.review }),
    seg("● busy  ", { fg: theme.busy }), seg("● broken", { fg: theme.broken })]);
  return overlay(base, box("Keys", content.slice(0, Math.max(1, height - 2)), " ? or esc closes ", boxWidth), ctx);
}

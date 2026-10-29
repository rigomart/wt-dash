import type { RGBA } from "@opentui/core";
import { assess, markerNote, recentAgentMark } from "../core/assess";
import { removalBlockReason, type RemovalEntry } from "../core/actions";
import type { DashboardSnapshot, ToolName, Verdict, WorktreeRow } from "../core/types";
import {
  ageLabel,
  agoLabel,
  branchLabel,
  changesLabel,
  clockLabel,
  countLabel,
  homePath,
  porcelainPath,
  rowsLabel,
  sizeLabel,
  upstreamLabel,
  statusLabel,
} from "./format";
import {
  cell,
  clip,
  fitLine,
  lineWidth,
  middle,
  rule,
  seg,
  sliceLine,
  spread,
  textWidth,
  wrap,
  type Line,
  type Style,
} from "./line";
import {
  ALL_PROJECTS,
  TABS,
  VERDICTS,
  inJob,
  isGrouped,
  jobStatus,
  listScreen,
  listView,
  projectsReady,
  projectsView,
  scopedRows,
  visibleRows,
  worktreeCount,
  type Confirm,
  type ListView,
  type Project,
  type ProjectsView,
  type RunStatus,
  type Screen,
  type Section,
  type Tab,
  type Toast,
  type UiState,
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
export interface Viewport {
  listTop: number;
  projectsTop: number;
  listScope: string;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function render(state: UiState, ctx: RenderContext, viewport: Viewport): Line[] {
  const width = Math.max(20, ctx.width);
  const height = Math.max(8, ctx.height);
  const sized = { ...ctx, width, height };
  const screen = listScreen(state, ctx.snapshot);
  const scope = screen.kind === "project" ? `project:${screen.repoPath}` : screen.kind;
  if (viewport.listScope !== scope) {
    viewport.listScope = scope;
    viewport.listTop = 0;
  }
  const onProjects = state.screen.kind === "projects";
  const showsScanProgress = onProjects && !projectsReady(state, ctx.snapshot);
  const sidebar =
    width >= SIDEBAR_MIN_WIDTH &&
    (showsScanProgress || projectsView(state, ctx.snapshot).projects.length > 1);
  const body = sidebar
    ? renderSidebar(state, sized, viewport)
    : onProjects
      ? renderProjects(state, sized, viewport)
      : renderList(state, sized, viewport);
  const lines = pad(body, height).map((line) => fitLine(line, width));
  if (state.help) return withHelp(lines, state, sized);
  return state.confirm ? withConfirm(lines, state, state.confirm, sized) : lines;
}

const CHROME_LINES = [
  "header",
  "tabs or column titles",
  "meter",
  "bottom rule",
  "status line",
  "key hints",
].length;

const bodyHeightFor = (height: number) => Math.max(1, height - CHROME_LINES);

const SIDEBAR_MIN_WIDTH = 100;

function sidebarWidth(width: number): number {
  return Math.max(28, Math.min(34, Math.floor(width * 0.22)));
}

function bottomPanelHeight(bodyHeight: number): number {
  const lines = Math.min(7, bodyHeight - 5);
  return lines >= 3 ? lines : 0;
}

/** Rows the list shows at once; used for page up/down. */
export function listPageSize(height: number): number {
  const body = bodyHeightFor(height);
  return Math.max(1, body - bottomPanelHeight(body) - 1);
}

interface Body {
  lines: Line[];
  below: number;
}

function withDetails(
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

function pad(lines: Line[], height: number): Line[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push([]);
  return out;
}

const key = (theme: Theme, text: string): Line[number] =>
  seg(text, { fg: theme.accent, bold: true });
const dim = (text: string): Line[number] => seg(text, { dim: true });
const spinner = (state: UiState) => SPINNER[state.frame % SPINNER.length]!;

function keyHints(theme: Theme, pairs: Array<[string, string]>): Line {
  return pairs.flatMap(([name, action], index) => [
    ...(index ? [seg("  ")] : []),
    key(theme, name),
    dim(` ${action}`),
  ]);
}

function quitHint(theme: Theme): Line {
  return keyHints(theme, [
    ["?", "keys"],
    ["q", "quit"],
  ]);
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
  return snapshot.rows
    .filter((row) => state.selected.has(row.id))
    .reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
}

// ─── Main list ────────────────────────────────────────────────────────────────

function renderList(state: UiState, ctx: RenderContext, viewport: Viewport): Line[] {
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

function listColumn(
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

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function renderSidebar(state: UiState, ctx: RenderContext, viewport: Viewport): Line[] {
  const { width, snapshot } = ctx;
  const projects = projectsView(state, snapshot);
  const view = listView(state, snapshot);
  const scope = listScreen(state, snapshot);
  const side = sidebarWidth(width);
  const listCtx = { ...ctx, width: width - side - 3 };
  const bodyHeight = bodyHeightFor(ctx.height);
  const onProjects = state.screen.kind === "projects";
  const waiting = onProjects && !projectsReady(state, snapshot);
  const detailsStrip = !onProjects;
  const list = waiting
    ? { lines: [[], meterLine([], listCtx)], below: 0 }
    : listColumn(state, view, listCtx, bodyHeight, viewport, detailsStrip);
  const sidebar = sidebarLines(state, projects, { ...ctx, width: side }, bodyHeight + 2, viewport);
  return [
    waiting
      ? headerLine(state, ctx, state.screen, [])
      : headerLine(
          state,
          ctx,
          scope,
          scopedRows(state, snapshot),
          scope.kind === "all" ? projects.projects.length : undefined,
        ),
    ...sidebar.map((line, index) => [
      ...fitLine(line, side),
      seg(" │ ", { dim: true }),
      ...fitLine(list.lines[index] ?? [], listCtx.width),
    ]),
    rule(width, list.below ? `↓ ${list.below} more` : "", { dim: true }),
    statusLine(state, ctx),
    listFooter(state, ctx, view.focus, true),
  ];
}

function sidebarLines(
  state: UiState,
  view: ProjectsView,
  ctx: RenderContext,
  height: number,
  viewport: Viewport,
): Line[] {
  const { width, theme } = ctx;
  const active = state.screen.kind === "projects";
  const title: Line = [
    cell("  PROJECTS", width - SIDEBAR_FREE.width, { dim: true }),
    cell(SIDEBAR_FREE.title, SIDEBAR_FREE.width, { dim: true }, "right"),
  ];
  if (!projectsReady(state, ctx.snapshot) && active)
    return pad([title, ...scanProgress(state, ctx)], height);
  const lines = view.entries.map((project) => {
    const focused = project === view.focus;
    const count = String(worktreeCount(project) || (project.pending ? "…" : 0));
    const selected = project.rows.filter((row) => state.selected.has(row.id)).length;
    const mark = selected ? ` ■${selected}` : "";
    const nameWidth = Math.max(
      1,
      width - 2 - SIDEBAR_FREE.width - textWidth(count) - textWidth(mark) - 1,
    );
    const name = middle(project.repoName, nameWidth);
    const parts: Line = [
      focused ? seg("▌ ", { fg: theme.accent, dim: !active }) : seg("  "),
      seg(name, { bold: focused }),
      dim(` ${count}`),
      seg(mark, { fg: theme.safe }),
    ];
    parts.push(seg(" ".repeat(Math.max(0, width - SIDEBAR_FREE.width - lineWidth(parts)))));
    parts.push(
      project.error && !project.rows.length
        ? cell("! failed", SIDEBAR_FREE.width, { fg: theme.review }, "right")
        : SIDEBAR_FREE.cell(project, ctx),
    );
    return fitLine(parts, width, focused && active ? { bg: theme.focusBg } : undefined);
  });
  const card =
    lines.length + 1 + SIDEBAR_CARD_LINES <= height - 1
      ? [[], ...projectCard(state, view, ctx, width - 2).map((line) => [seg("  "), ...line])]
      : [];
  const rows = height - 1 - card.length;
  const focus = view.focus ? view.entries.indexOf(view.focus) : 0;
  let top = viewport.projectsTop;
  if (focus < top) top = focus;
  if (focus >= top + rows) top = focus - rows + 1;
  top = Math.max(0, Math.min(top, lines.length - rows));
  viewport.projectsTop = top;
  return pad([title, ...lines.slice(top, top + rows), ...card], height);
}

const SIDEBAR_CARD_LINES = 7;

function projectCard(
  state: UiState,
  view: ProjectsView,
  ctx: RenderContext,
  width: number,
): Line[] {
  const { theme, now, home, snapshot } = ctx;
  const project = view.focus;
  if (!project) return [];
  const all = project.repoPath === ALL_PROJECTS;
  const lines: Line[] = [
    [seg(clip(project.repoName, width), { bold: true })],
    [
      dim(
        all
          ? countLabel(view.projects.length, "project")
          : middle(homePath(project.repoPath, home), width),
      ),
    ],
  ];
  if (project.error)
    return [
      ...lines,
      ...wrap(`Scan failed: ${project.error}`, width)
        .slice(0, SIDEBAR_CARD_LINES - lines.length)
        .map((text) => [seg(text, { fg: theme.review })]),
    ];
  const rows = project.rows;
  if (!rows.length) {
    const listing = project.pending || (all && snapshot.progress.phase === "scanning");
    return [
      ...lines,
      listing
        ? [seg(spinner(state), { fg: theme.accent }), dim(" listing worktrees…")]
        : [dim("No worktrees")],
    ];
  }
  const dirty = rows.filter((row) => row.changes && changesLabel(row) !== "clean").length;
  const tools = toolCounts(rows);
  const time = (row: WorktreeRow) => Date.parse(row.committedAt ?? "");
  const oldest = rows
    .filter((row) => Number.isFinite(time(row)))
    .reduce<WorktreeRow | null>(
      (best, row) => (!best || time(row) < time(best) ? row : best),
      null,
    );
  const largest = rows.reduce<WorktreeRow | null>(
    (best, row) => ((row.sizeKiB ?? -1) > (best?.sizeKiB ?? -1) ? row : best),
    null,
  );
  const named = (label: string, value: string, row: WorktreeRow): Line => {
    const room = Math.max(1, width - label.length - value.length - 3);
    return [dim(label), seg(value), dim(" · "), dim(middle(branchLabel(row), room))];
  };
  lines.push(
    [
      seg(`${sizeLabel(project.safeKiB)} safe`, { fg: theme.safe }),
      dim(clip(` of ${sizeLabel(project.totalKiB)}`, width)),
    ],
    dirty
      ? [seg(`${countLabel(dirty, "worktree")} uncommitted`, { fg: theme.review })]
      : [seg("nothing uncommitted", { fg: theme.safe })],
    [dim(clip(tools.map(([tool, count]) => `${tool} ${count}`).join(" · "), width))],
  );
  if (oldest) lines.push(named("oldest  ", agoLabel(oldest.committedAt, now), oldest));
  if (largest && largest.sizeKiB !== null)
    lines.push(named("largest ", sizeLabel(largest.sizeKiB), largest));
  return lines.map((line) => fitLine(line, width));
}

/** Branches without a worktree are counted apart: no tool is known to have made them. */
function toolCounts(rows: WorktreeRow[]): Array<readonly [string, number]> {
  const counts: Array<readonly [string, number]> = (Object.keys(TOOL_NAMES) as ToolName[])
    .map(
      (tool) =>
        [
          TOOL_NAMES[tool],
          rows.filter((row) => row.kind === "worktree" && row.tool === tool).length,
        ] as const,
    )
    .filter(([, count]) => count)
    .sort((a, b) => b[1] - a[1]);
  const branches = rows.filter((row) => row.kind === "branch").length;
  return branches ? [...counts, ["no worktree", branches] as const] : counts;
}

function statusLine(state: UiState, ctx: RenderContext): Line {
  const { theme } = ctx;
  if (state.toast) return toastLine(theme, state.toast);
  if (state.pending)
    return [
      seg(spinner(state), { fg: theme.accent }),
      seg(` ${state.pending.label}  `),
      ...keyHints(theme, [["esc", "cancel"]]),
    ];
  if (state.pruning) return [seg(spinner(state), { fg: theme.accent }), seg(" Pruning…")];
  if (state.jobs.length) return progressLine(state, ctx);
  return bannerLine(ctx) ?? [];
}

type SummaryPart = "projects" | "worktrees" | "size" | "sizing";

const SUMMARY_PARTS_BY_WIDTH: SummaryPart[][] = [
  ["projects", "worktrees", "size", "sizing"],
  ["worktrees", "size", "sizing"],
  ["worktrees", "size"],
  ["size"],
  [],
];

function headerLine(
  state: UiState,
  ctx: RenderContext,
  screen: Screen,
  rows: WorktreeRow[],
  projects?: number,
): Line {
  const { snapshot, theme } = ctx;
  const progress = snapshot.progress;
  const total = rows.reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
  const unknown = rows.filter((row) => row.kind === "worktree" && row.sizeKiB === null).length;
  const status: Line =
    progress.phase === "scanning"
      ? [
          seg(spinner(state), { fg: theme.accent }),
          dim(` scanning ${progress.reposDone}/${progress.reposTotal} repos`),
        ]
      : progress.phase === "error"
        ? [seg("scan failed", { fg: theme.broken })]
        : progress.phase === "complete"
          ? [dim(`scanned ${clockLabel(progress.completedAt)}  `), key(theme, "r"), dim(" rescan")]
          : [dim("starting…")];
  const place =
    screen.kind === "project"
      ? (rows[0]?.repoName ?? screen.repoPath.split("/").at(-1) ?? screen.repoPath)
      : screen.kind === "all"
        ? "all projects"
        : null;
  const title: Line = [seg("wt-dash", { bold: true })];
  if (place) title.push(dim(" › "), seg(place, { bold: true }));
  const parts: Record<SummaryPart, string> = {
    projects: projects === undefined ? "" : countLabel(projects, "project"),
    worktrees: rowsLabel(rows),
    size: `up to ${sizeLabel(total)}`,
    sizing: unknown ? `${unknown} sizing` : "",
  };
  const summary = (names: SummaryPart[]): Line => {
    const listing = !rows.length && progress.phase === "scanning";
    const shown =
      projectsReady(state, snapshot) && !listing
        ? names.map((name) => parts[name]).filter(Boolean)
        : [];
    return [dim(shown.map((part) => `${part} · `).join("")), ...status];
  };
  const right =
    SUMMARY_PARTS_BY_WIDTH.map(summary).find(
      (line) => lineWidth(title) + lineWidth(line) + 1 <= ctx.width,
    ) ?? summary([]);
  return spread(title, right, ctx.width, "right");
}

function tabsLine(state: UiState, view: ListView, ctx: RenderContext): Line {
  const { theme, width, snapshot } = ctx;
  const short: Record<Tab, string> = {
    All: "All",
    Safe: "Safe",
    Review: "Rev",
    Busy: "Busy",
    Broken: "Brk",
  };
  const tone: Record<Tab, Style> = {
    All: {},
    Safe: { fg: theme.safe },
    Review: { fg: theme.review },
    Busy: { fg: theme.busy },
    Broken: { fg: theme.broken },
  };
  const left: Line = TABS.flatMap((tab) => {
    const count = view.counts[tab];
    let label = `${width < 64 ? short[tab] : tab} ${count}`;
    if (tab === "Safe" && width >= 100 && view.safeKiB) label += ` · ${sizeLabel(view.safeKiB)}`;
    const look: Style =
      tab === state.tab ? { reverse: true, bold: true } : { ...tone[tab], dim: count === 0 };
    return [seg(` ${label} `, look)];
  });
  let right: Line;
  if (state.searching) {
    right = [
      key(theme, "/ "),
      seg(state.search),
      seg(" ", { reverse: true }),
      dim(`  ${view.rows.length} of ${snapshot.rows.length}`),
    ];
  } else if (state.search) {
    right = [key(theme, "/ "), seg(state.search, { bold: true }), dim("  esc clears")];
  } else right = [key(theme, "/"), dim(" search")];
  return spread(left, right, width, state.searching || state.search ? "right" : "left");
}

function meterLine(rows: WorktreeRow[], ctx: RenderContext): Line {
  const { theme, width } = ctx;
  const kib = (verdict: Verdict) =>
    rows.filter((row) => row.verdict === verdict).reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
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
  return [
    seg(
      `! ${countLabel(errors.length, "repo")} failed to scan: ${repo.split("/").at(-1)}: ${message}`,
      { fg: theme.review },
    ),
  ];
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

function rowSize(row: WorktreeRow): string {
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

interface RowStatus {
  icon: string;
  label: string;
  style: Style;
  done: boolean;
}

/** A row's place in a running removal, or why the last attempt left it in place. */
function removalStatus(state: UiState, id: string, theme: Theme): RowStatus | null {
  const running = jobStatus(state, id);
  const look: Record<RunStatus, RowStatus> = {
    waiting: { icon: "◦", label: "queued", style: { dim: true }, done: false },
    removing: {
      icon: SPINNER[state.frame % SPINNER.length]!,
      label: "removing…",
      style: { fg: theme.accent },
      done: false,
    },
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

const TOOL_NAMES: Record<ToolName, string> = {
  Claude: "Claude Code",
  Codex: "Codex",
  t3: "t3",
  Other: "other",
};

const SUMMARY_FILE_LINES = 2;

function worktreeSummary(
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

function field(label: string, value: string, width: number, look: Style = {}): Line[] {
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

function detailLines(
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
          `${sizeLabel(row.sizeKiB)} · ${row.sizeMeasuredAt ? `measured ${agoLabel(row.sizeMeasuredAt, now)}` : "measuring…"}`,
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

function progressLine(state: UiState, ctx: RenderContext): Line {
  const { theme, width } = ctx;
  const statuses = state.jobs.flatMap((job) => job.order.map((id) => job.status[id]!));
  const total = statuses.length;
  const done = statuses.filter((status) => status !== "waiting" && status !== "removing").length;
  const failed = statuses.filter(
    (status) => status === "failed" || status === "skipped" || status === "unverified",
  ).length;
  const current = state.jobs
    .flatMap((job) => job.plan.entries)
    .find((entry) => jobStatus(state, entry.row.id) === "removing");
  const stopping = state.jobs.every((job) => job.stopping);
  const text =
    `Removing ${Math.min(done + 1, total)} of ${total}` +
    (current ? `: ${branchLabel(current.row)}` : "");
  const barWidth = Math.max(0, Math.min(24, width - textWidth(text) - 40));
  const filled = total ? Math.round((done / total) * barWidth) : 0;
  const left: Line = [seg(spinner(state), { fg: theme.accent }), seg(` ${text}  `)];
  if (barWidth >= 6)
    left.push(
      seg("━".repeat(filled), { fg: theme.safe }),
      dim("━".repeat(barWidth - filled)),
      seg("  "),
    );
  if (failed) left.push(seg(`${failed} not removed  `, { fg: theme.review }));
  const escStopsRemoval = state.screen.kind === "projects";
  const right: Line = stopping
    ? [seg("stopping after this one", { fg: theme.review })]
    : escStopsRemoval
      ? keyHints(theme, [["esc", "stop after this one"]])
      : [];
  return spread(left, right, width);
}

function listFooter(
  state: UiState,
  ctx: RenderContext,
  focus: WorktreeRow | null,
  sidebar: boolean,
): Line {
  const { theme, width } = ctx;
  let left: Line;
  if (state.confirm)
    left = keyHints(theme, [
      ["y / enter", state.confirm.kind],
      ["esc", "cancel"],
    ]);
  else if (state.searching)
    left = [
      dim("type to filter  "),
      ...keyHints(theme, [
        ["↑↓", "move"],
        ["enter", "keep"],
        ["esc", "clear"],
      ]),
    ];
  else if (state.expanded)
    left = keyHints(theme, [
      ["↑↓", "scroll"],
      ["i", "back"],
    ]);
  else if (state.selected.size) {
    left = [
      seg("■ ", { fg: theme.safe }),
      seg(`${state.selected.size} selected`, { bold: true }),
      dim(` · up to ${sizeLabel(selectedKiB(state, ctx.snapshot))}   `),
      ...keyHints(theme, [
        [state.screen.kind === "projects" ? "x" : "enter", "remove"],
        ["esc", "clear"],
      ]),
    ];
  } else if (state.screen.kind === "projects" && !projectsReady(state, ctx.snapshot)) {
    left = [];
  } else if (state.screen.kind === "projects") {
    left = keyHints(theme, [
      [sidebar ? "→" : "enter", sidebar ? "worktrees" : "open"],
      ...(ctx.canAct ? [["a", "select safe"] as [string, string]] : []),
      ["/", "search"],
    ]);
  } else {
    const action: Array<[string, string]> =
      focus?.verdict === "Broken"
        ? [["enter", "prune"]]
        : [
            ["space", "select"],
            ["enter", "remove"],
          ];
    const view: Array<[string, string]> = [
      ["/", "search"],
      ...(state.screen.kind === "all"
        ? [["v", state.grouped ? "by verdict" : "by repo"] as [string, string]]
        : []),
      ["s", `sort: ${state.sort} ${state.descending ? "↓" : "↑"}`],
      ["←", "projects"],
    ];
    left = keyHints(theme, ctx.canAct ? [...action, ["a", "all safe"], ...view] : view);
  }
  return spread(left, quitHint(theme), width, "right");
}

// ─── Projects ─────────────────────────────────────────────────────────────────

interface ProjectColumn {
  title: string;
  width: number;
  cell: (project: Project, ctx: RenderContext) => Line[number];
}

const pendingCell = (width: number) => cell("…", width, { dim: true }, "right");

function countColumn(verdict: Verdict, title: string): ProjectColumn {
  const width = title.length + 2;
  return {
    title,
    width,
    cell: (project, ctx) => {
      if (project.pending) return pendingCell(width);
      const count = project.counts[verdict];
      return count
        ? cell(String(count), width, { fg: verdictColor(ctx.theme, verdict) }, "right")
        : cell("·", width, { dim: true }, "right");
    },
  };
}

function sizeColumn(
  title: string,
  kib: (project: Project) => number,
  rowsCovered: (project: Project) => number,
  width = 11,
): ProjectColumn {
  return {
    title,
    width,
    cell: (project) => {
      if (project.pending || (project.worktrees && project.worktrees === project.unsized))
        return pendingCell(width);
      if (!rowsCovered(project)) return cell("·", width, { dim: true }, "right");
      return cell(sizeLabel(kib(project)), width, { dim: project.unsized > 0 }, "right");
    },
  };
}

const WORKTREES_COLUMN: ProjectColumn = {
  title: "WORKTREES",
  width: 11,
  cell: (project) =>
    project.pending
      ? cell(project.linked === null ? "…" : String(project.linked), 11, { dim: true }, "right")
      : cell(String(project.worktrees), 11, {}, "right"),
};
const SAFE_SIZE_COLUMN = sizeColumn(
  "SAFE SIZE",
  (project) => project.safeKiB,
  (project) => project.counts.Safe,
);
const SIDEBAR_FREE = sizeColumn(
  "FREE",
  (project) => project.safeKiB,
  (project) => project.counts.Safe,
  9,
);
const TOTAL_COLUMN = sizeColumn(
  "TOTAL",
  (project) => project.totalKiB,
  (project) => project.worktrees,
);
const VERDICT_COLUMNS = [
  countColumn("Safe", "SAFE"),
  countColumn("Review", "REVIEW"),
  countColumn("Busy", "BUSY"),
  countColumn("Broken", "BROKEN"),
];

function projectColumns(width: number): ProjectColumn[] {
  const [safe, review] = VERDICT_COLUMNS;
  const options: ProjectColumn[][] = [
    [WORKTREES_COLUMN, ...VERDICT_COLUMNS, SAFE_SIZE_COLUMN, TOTAL_COLUMN],
    [WORKTREES_COLUMN, safe!, review!, SAFE_SIZE_COLUMN, TOTAL_COLUMN],
    [WORKTREES_COLUMN, safe!, SAFE_SIZE_COLUMN],
    [SAFE_SIZE_COLUMN],
  ];
  return (
    options.find((cols) => width - 2 - cols.reduce((sum, col) => sum + col.width, 0) >= 16) ??
    options.at(-1)!
  );
}

function projectLine(
  project: Project,
  cols: ProjectColumn[],
  state: UiState,
  ctx: RenderContext,
  focused: boolean,
): Line {
  const { theme, width } = ctx;
  const nameWidth = Math.max(1, width - 2 - cols.reduce((sum, col) => sum + col.width, 0));
  const selected = project.rows.filter((row) => state.selected.has(row.id)).length;
  const mark = selected ? ` ■ ${selected}` : "";
  const parts: Line = [
    focused ? seg("▌ ", { fg: theme.accent }) : seg("  "),
    seg(middle(project.repoName, Math.max(1, nameWidth - textWidth(mark))), { bold: focused }),
    seg(mark, { fg: theme.safe }),
  ];
  const used = lineWidth(parts);
  parts.push(seg(" ".repeat(Math.max(0, 2 + nameWidth - used))));
  if (project.error && !project.rows.length) {
    parts.push(
      seg(clip(`! scan failed: ${project.error}`, width - 2 - nameWidth), { fg: theme.review }),
    );
  } else for (const col of cols) parts.push(col.cell(project, ctx));
  return fitLine(parts, width, focused ? { bg: theme.focusBg } : undefined);
}

function scanProgress(state: UiState, ctx: RenderContext): Line[] {
  const { snapshot, theme } = ctx;
  const { reposDone, reposTotal } = snapshot.progress;
  const label = ctx.width >= 40 ? "Scanning repositories" : "Scanning";
  const lines: Line[] = [
    [],
    [
      seg("  "),
      seg(spinner(state), { fg: theme.accent }),
      seg(reposTotal ? ` ${label} · ${reposDone} of ${reposTotal}` : " Finding repositories…"),
    ],
  ];
  const barWidth = Math.min(40, ctx.width - 4);
  if (reposTotal && barWidth >= 10) {
    const filled = Math.round((reposDone / reposTotal) * barWidth);
    lines.push([
      seg("  "),
      seg("━".repeat(filled), { fg: theme.accent }),
      dim("━".repeat(barWidth - filled)),
    ]);
  }
  return lines;
}

function projectsBody(
  state: UiState,
  view: ProjectsView,
  ctx: RenderContext,
  height: number,
  viewport: Viewport,
): { lines: Line[]; below: number } {
  if (!projectsReady(state, ctx.snapshot)) return { lines: scanProgress(state, ctx), below: 0 };
  if (!view.projects.length) return { lines: [[], [dim("  No worktrees found.")]], below: 0 };
  const cols = projectColumns(ctx.width);
  const lines = view.entries.map((project) =>
    projectLine(project, cols, state, ctx, project === view.focus),
  );
  if (view.empty) lines.push([], [dim(`  ${countLabel(view.empty, "project")} with no worktrees`)]);
  const focus = view.focus ? view.entries.indexOf(view.focus) : 0;
  let top = viewport.projectsTop;
  if (focus < top) top = focus;
  if (focus >= top + height) top = focus - height + 1;
  top = Math.max(0, Math.min(top, lines.length - height));
  viewport.projectsTop = top;
  return {
    lines: lines.slice(top, top + height),
    below: Math.max(0, view.entries.length - top - height),
  };
}

function renderProjects(state: UiState, ctx: RenderContext, viewport: Viewport): Line[] {
  const { width } = ctx;
  const view = projectsView(state, ctx.snapshot);
  const cols = projectColumns(width);
  const rows = visibleRows(state, ctx.snapshot);
  const top: Line[] = [
    headerLine(state, ctx, state.screen, rows, view.projects.length),
    meterLine(projectsReady(state, ctx.snapshot) ? rows : [], ctx),
    [
      cell("  PROJECT", width - cols.reduce((sum, col) => sum + col.width, 0), { dim: true }),
      ...cols.map((col) => cell(col.title, col.width, { dim: true }, "right")),
    ],
  ];
  const bodyHeight = bodyHeightFor(ctx.height);
  const { lines, below } = withDetails(
    ctx,
    bodyHeight,
    (tableCtx, height) => projectsBody(state, view, tableCtx, height, viewport),
    (panelWidth) =>
      projectsReady(state, ctx.snapshot) ? projectDetails(view, ctx, panelWidth) : [],
  );
  const bottom = rule(width, below ? `↓ ${below} more` : "", { dim: true });
  return [
    ...top,
    ...pad(lines, bodyHeight),
    bottom,
    statusLine(state, ctx),
    listFooter(state, ctx, null, false),
  ];
}

function projectDetails(view: ProjectsView, ctx: RenderContext, width: number): Line[] {
  const { theme, now, home } = ctx;
  const project = view.focus;
  if (!project) return [];
  const where =
    project.repoPath === ALL_PROJECTS
      ? countLabel(view.projects.length, "project")
      : homePath(project.repoPath, home);
  const lines: Line[] = [
    [
      seg(project.repoName, { bold: true }),
      dim(`  ${middle(where, Math.max(1, width - textWidth(project.repoName) - 2))}`),
    ],
  ];
  if (project.error)
    return [
      ...lines,
      ...wrap(`Scan failed: ${project.error}`, width).map((text) => [
        seg(text, { fg: theme.review }),
      ]),
    ];
  const rows = project.rows;
  if (!rows.length)
    return [...lines, [dim(project.pending ? "Listing worktrees…" : "No worktrees")]];
  const tools = toolCounts(rows);
  const dirty = rows.filter((row) => row.changes && changesLabel(row) !== "clean").length;
  const time = (row: WorktreeRow) => Date.parse(row.committedAt ?? "");
  const oldest = rows
    .filter((row) => Number.isFinite(time(row)))
    .reduce<WorktreeRow | null>(
      (best, row) => (!best || time(row) < time(best) ? row : best),
      null,
    );
  const largest = rows.reduce<WorktreeRow | null>(
    (best, row) => ((row.sizeKiB ?? -1) > (best?.sizeKiB ?? -1) ? row : best),
    null,
  );
  const sizing = project.unsized ? ` · ${project.unsized} sizing` : "";
  lines.push(
    ...field(
      "SAFE TO FREE",
      `${sizeLabel(project.safeKiB)} of ${sizeLabel(project.totalKiB)}${sizing}`,
      width,
      { fg: theme.safe },
    ),
    ...field(
      "UNCOMMITTED",
      dirty ? countLabel(dirty, "worktree") : "none",
      width,
      dirty ? { fg: theme.review } : { fg: theme.safe },
    ),
    ...field("MADE BY", tools.map(([tool, count]) => `${tool} ${count}`).join(" · "), width),
  );
  if (oldest)
    lines.push(
      ...field("OLDEST", `${branchLabel(oldest)} · ${agoLabel(oldest.committedAt, now)}`, width),
    );
  if (largest?.sizeKiB !== null && largest)
    lines.push(
      ...field("LARGEST", `${branchLabel(largest)} · ${sizeLabel(largest.sizeKiB)}`, width),
    );
  return lines;
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────

function names(entries: RemovalEntry[]): string {
  const labels = entries.map((entry) => branchLabel(entry.row));
  return labels.length <= 2
    ? labels.join(" and ")
    : `${labels.slice(0, 2).join(", ")} +${labels.length - 2} more`;
}

function withConfirm(base: Line[], state: UiState, confirm: Confirm, ctx: RenderContext): Line[] {
  const boxWidth = Math.min(ctx.width - 2, 76);
  const inner = boxWidth - 4;
  const { title, content, answer } =
    confirm.kind === "prune" ? pruneDialog(confirm, ctx, inner) : removeDialog(confirm, ctx, inner);
  const message = state.toast ? [toastLine(ctx.theme, state.toast), []] : [];
  return overlay(
    base,
    box(title, [...content, ...message, answer], " esc cancels ", boxWidth),
    ctx,
  );
}

function buttons(theme: Theme, verb: string): Line {
  return [
    seg(` ${verb}  y / enter `, { fg: theme.broken, reverse: true, bold: true }),
    seg("   "),
    seg("[ "),
    seg("Cancel  esc", { bold: true }),
    seg(" ]"),
  ];
}

function pruneDialog(
  confirm: Extract<Confirm, { kind: "prune" }>,
  ctx: RenderContext,
  inner: number,
) {
  const repo = confirm.plan.repoPath.split("/").at(-1);
  return {
    title: `Prune ${countLabel(confirm.plan.records.length, "missing worktree record")} in ${repo}?`,
    content: [
      ...wrap("The folders are already gone; this removes only Git's records of them.", inner).map(
        (text) => [dim(text)],
      ),
      [],
    ],
    answer: buttons(ctx.theme, "Prune"),
  };
}

function withLiveSizes(entries: RemovalEntry[], rows: WorktreeRow[]): RemovalEntry[] {
  const live = new Map(rows.map((row) => [row.id, row]));
  return entries.map((entry) => {
    const sizeKiB = live.get(entry.row.id)?.sizeKiB ?? entry.row.sizeKiB;
    return { ...entry, row: { ...entry.row, sizeKiB } };
  });
}

function removeDialog(
  confirm: Extract<Confirm, { kind: "remove" }>,
  ctx: RenderContext,
  inner: number,
) {
  const { theme } = ctx;
  const { ready, blocked } = confirm;
  const sized = withLiveSizes(ready, ctx.snapshot.rows);
  const kib = sized.reduce((sum, entry) => sum + (entry.row.sizeKiB ?? 0), 0);
  const unsized = sized.filter(
    (entry) => entry.row.kind === "worktree" && entry.row.sizeKiB === null,
  ).length;
  const size = [
    kib || !unsized ? `up to ${sizeLabel(kib)}` : "",
    unsized ? `${unsized} sizing` : "",
  ].filter(Boolean);
  const notes: Line[] = [];
  const dirty = ready.filter((entry) => entry.requiresDiscard);
  const warn = (text: string) => wrap(text, inner).map((part) => [seg(part, { fg: theme.review })]);
  const marked = ready.filter((entry) => recentAgentMark(entry.row));
  if (marked.length)
    notes.push(
      ...warn(
        marked.length === 1
          ? `! ${names(marked)}: ${recentAgentMark(marked[0]!.row)}`
          : `! Agents were recently active in ${names(marked)}`,
      ),
    );
  if (dirty.length) notes.push(...warn(`! Discards uncommitted changes in ${names(dirty)}`));
  if (blocked.length) {
    notes.push(
      ...warn(
        blocked.length === 1
          ? `! Skips ${names(blocked)}: ${blocked[0]!.blockedReason}`
          : `! Skips ${names(blocked)}, which changed or can't be removed`,
      ),
    );
  }
  if (!dirty.length && !blocked.length && ready.some((entry) => entry.row.kind === "worktree"))
    notes.push(
      ...wrap("Nothing uncommitted. Ignored files and caches go with them.", inner).map((text) => [
        dim(text),
      ]),
    );
  const unmerged = ready.filter((entry) => entry.branchWillBeRetained);
  const merged = ready.filter((entry) => entry.row.branch !== null && !entry.branchWillBeRetained);
  const bare = unmerged.filter((entry) => entry.row.kind === "branch");
  if (bare.length && !confirm.deleteUnmerged)
    notes.push(...warn(`! Skips ${names(bare)} unless you press D: not merged, and no worktree`));
  const options: Line[] = [];
  if (unmerged.length) {
    const count = countLabel(unmerged.length, "unmerged branch", "unmerged branches");
    options.push([
      confirm.deleteUnmerged
        ? seg(`Also deletes ${count}  `, { fg: theme.review })
        : dim(`Keeps ${count}  `),
      key(theme, "D"),
      dim(confirm.deleteUnmerged ? " keep them" : " delete too"),
    ]);
  } else if (merged.length) options.push([dim("Merged branches are deleted.")]);
  options.push([
    confirm.reap
      ? dim("Stops processes running inside  ")
      : seg("Processes inside keep running  ", { fg: theme.review }),
    key(theme, "e"),
    dim(confirm.reap ? " leave them" : " stop them"),
  ]);
  const tail: Line[] = [[], ...notes, [], ...options, []];
  const room = Math.max(1, ctx.height - 3 - tail.length);
  const shown = sized.length > room ? sized.slice(0, room - 1) : sized;
  const sizeWidth = 9;
  const repoWidth = inner >= 50 ? 14 : 0;
  const rows: Line[] = shown.map((entry) => [
    cell(
      `• ${middle(branchLabel(entry.row), inner - repoWidth - sizeWidth - 3)}`,
      inner - repoWidth - sizeWidth,
      entry.requiresDiscard ? { fg: theme.review } : {},
    ),
    cell(entry.row.repoName, repoWidth, { dim: true }),
    cell(rowSize(entry.row), sizeWidth, { dim: true }, "right"),
  ]);
  if (shown.length < ready.length) rows.push([dim(`  +${ready.length - shown.length} more`)]);
  return {
    title: `Remove ${[rowsLabel(ready.map((entry) => entry.row)), ...size].join(" · ")}?`,
    content: [...rows, ...tail],
    answer: buttons(theme, `Remove ${ready.length}`),
  };
}

function box(title: string, content: Line[], closing: string, boxWidth: number): Line[] {
  const inner = boxWidth - 4;
  const border: Style = { dim: true };
  const heading = ` ${clip(title, Math.max(1, boxWidth - 6))} `;
  return [
    [
      seg("╭─", border),
      seg(heading, { bold: true }),
      seg("─".repeat(Math.max(0, boxWidth - 3 - textWidth(heading))) + "╮", border),
    ],
    ...content.map((line): Line => [seg("│ ", border), ...fitLine(line, inner), seg(" │", border)]),
    [
      seg("╰" + "─".repeat(Math.max(0, boxWidth - 3 - closing.length)), border),
      seg(closing, { dim: true }),
      seg("─╯", border),
    ],
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
    faded[y + index] = [
      ...sliceLine(faded[y + index]!, 0, x),
      ...fitLine(line, boxWidth),
      ...sliceLine(faded[y + index]!, x + boxWidth, width),
    ];
  });
  return faded.map((line) => fitLine(line, width));
}

// ─── Key overlay ──────────────────────────────────────────────────────────────

function helpGroups(_state: UiState): Array<[string, Array<[string, string]>]> {
  return [
    [
      "MOVE",
      [
        ["↑↓ j k", "row"],
        ["pgup pgdn", "page"],
        ["g G", "first / last"],
        ["i", "full details"],
      ],
    ],
    [
      "PROJECTS",
      [
        ["enter →", "open project or all"],
        ["← esc", "back to projects"],
        ["tab", "switch projects / list"],
        ["[ ]", "previous / next project"],
      ],
    ],
    [
      "FIND",
      [
        ["1-5", "verdict tab"],
        ["/", "search as you type"],
        ["s S", "sort / reverse"],
        ["v", "group by repo or verdict"],
      ],
    ],
    [
      "CLEAN UP",
      [
        ["space", "select row"],
        ["a", "all Safe in view or project"],
        ["enter x", "remove selected or focused"],
        ["y enter", "confirm in the dialog"],
        ["D e", "dialog: branches · processes"],
        ["enter", "on Broken: prune record"],
      ],
    ],
    [
      "OTHER",
      [
        ["esc", "undo one step"],
        ["r", "rescan all repos"],
        ["R", "remeasure size"],
        ["q ^C", "quit"],
      ],
    ],
  ];
}

function withHelp(base: Line[], state: UiState, ctx: RenderContext): Line[] {
  const { theme, width, height } = ctx;
  const boxWidth = Math.min(width - 2, 80);
  const inner = boxWidth - 4;
  const groups = helpGroups(state).map(([title, keys]) => [
    ...(title ? [[seg(title, { dim: true, bold: true })]] : [[]]),
    ...keys.map(([name, action]): Line => [
      cell(name, 11, { fg: theme.accent, bold: true }),
      seg(action),
    ]),
  ]);
  let content: Line[];
  if (inner >= 60) {
    const half = Math.floor((inner - 2) / 2);
    const leftColumn = groups
      .filter((_, index) => index % 2 === 0)
      .flatMap((group, index) => (index ? [[], ...group] : group));
    const rightColumn = groups
      .filter((_, index) => index % 2 === 1)
      .flatMap((group, index) => (index ? [[], ...group] : group));
    const rows = Math.max(leftColumn.length, rightColumn.length);
    content = Array.from({ length: rows }, (_, index) => [
      ...fitLine(leftColumn[index] ?? [], half),
      seg("  "),
      ...(rightColumn[index] ?? []),
    ]);
  } else content = groups.flatMap((group, index) => (index ? [[], ...group] : group));
  content.push(
    [],
    [
      dim("Colors: "),
      seg("● safe  ", { fg: theme.safe }),
      seg("● review  ", { fg: theme.review }),
      seg("● busy  ", { fg: theme.busy }),
      seg("● broken", { fg: theme.broken }),
    ],
  );
  return overlay(
    base,
    box("Keys", content.slice(0, Math.max(1, height - 2)), " ? or esc closes ", boxWidth),
    ctx,
  );
}

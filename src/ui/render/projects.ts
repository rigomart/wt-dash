import { ORPHANS, type ToolName, type Verdict, type WorktreeRow } from "../../core/types";
import { agoLabel, branchLabel, changesLabel, countLabel, homePath, sizeLabel } from "../format";
import {
  cell,
  clip,
  fitLine,
  lineWidth,
  middle,
  rule,
  seg,
  textWidth,
  wrap,
  type Line,
} from "../line";
import {
  projectsReady,
  projectsView,
  repoCount,
  visibleRows,
  type Project,
  type ProjectsView,
} from "../selectors";
import { ALL_PROJECTS, type UiState } from "../state";
import { verdictColor } from "../theme";
import { dim, spinner } from "./common";
import { bodyHeightFor, pad, type RenderContext, type Viewport } from "./layout";
import { headerLine, listFooter, meterLine, statusLine } from "./chrome";
import { TOOL_NAMES, field, withDetails } from "./details";

/** Folders count by the tool that made them; branches without a worktree apart, since no tool is known. */
export function toolCounts(rows: WorktreeRow[]): Array<readonly [string, number]> {
  const counts: Array<readonly [string, number]> = (Object.keys(TOOL_NAMES) as ToolName[])
    .map(
      (tool) =>
        [
          TOOL_NAMES[tool],
          rows.filter((row) => row.kind !== "branch" && row.tool === tool).length,
        ] as const,
    )
    .filter(([, count]) => count)
    .sort((a, b) => b[1] - a[1]);
  const branches = rows.filter((row) => row.kind === "branch").length;
  return branches ? [...counts, ["no worktree", branches] as const] : counts;
}

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
export const SIDEBAR_FREE = sizeColumn(
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
  countColumn("Orphaned", "ORPHANED"),
];
const SHORT_VERDICT_COLUMNS = [
  countColumn("Safe", "SAFE"),
  countColumn("Review", "REV"),
  countColumn("Busy", "BUSY"),
  countColumn("Broken", "BRK"),
  countColumn("Orphaned", "ORPH"),
];

function projectColumns(width: number): ProjectColumn[] {
  const [safe, review] = VERDICT_COLUMNS;
  const options: ProjectColumn[][] = [
    [WORKTREES_COLUMN, ...VERDICT_COLUMNS, SAFE_SIZE_COLUMN, TOTAL_COLUMN],
    [WORKTREES_COLUMN, ...SHORT_VERDICT_COLUMNS, SAFE_SIZE_COLUMN, TOTAL_COLUMN],
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

export function scanProgress(state: UiState, ctx: RenderContext): Line[] {
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

export function renderProjects(state: UiState, ctx: RenderContext, viewport: Viewport): Line[] {
  const { width } = ctx;
  const view = projectsView(state, ctx.snapshot);
  const cols = projectColumns(width);
  const rows = visibleRows(state, ctx.snapshot);
  const top: Line[] = [
    headerLine(state, ctx, state.screen, rows, repoCount(view)),
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

/** What the orphans' pseudo-project holds, in place of a repository path: "3 folders no repo knows". */
export function orphansLabel(project: Project): string {
  return `${countLabel(project.worktrees, "folder")} no repo knows`;
}

function projectDetails(view: ProjectsView, ctx: RenderContext, width: number): Line[] {
  const { theme, now, home } = ctx;
  const project = view.focus;
  if (!project) return [];
  const orphans = project.repoPath === ORPHANS;
  const where =
    project.repoPath === ALL_PROJECTS
      ? countLabel(repoCount(view), "project")
      : orphans
        ? orphansLabel(project)
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
  if (orphans) lines.push(...field("SIZE", `up to ${sizeLabel(project.totalKiB)}${sizing}`, width));
  else
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
    );
  lines.push(
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

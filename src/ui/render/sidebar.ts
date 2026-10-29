import { ORPHANS, type WorktreeRow } from "../../core/types";
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
  listScreen,
  listView,
  projectsReady,
  projectsView,
  repoCount,
  scopedRows,
  worktreeCount,
  type ProjectsView,
} from "../selectors";
import { ALL_PROJECTS, type UiState } from "../state";
import { dim, spinner } from "./common";
import { bodyHeightFor, pad, sidebarWidth, type RenderContext, type Viewport } from "./layout";
import { headerLine, listFooter, meterLine, statusLine } from "./chrome";
import { listColumn } from "./list";
import { SIDEBAR_FREE, orphansLabel, scanProgress, toolCounts } from "./projects";

export function renderSidebar(state: UiState, ctx: RenderContext, viewport: Viewport): Line[] {
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
          scope.kind === "all" ? repoCount(projects) : undefined,
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
    // Orphans are never Safe, so they have nothing for FREE, and their long name takes its room.
    const free = project.repoPath === ORPHANS ? 0 : SIDEBAR_FREE.width;
    const nameWidth = Math.max(1, width - 2 - free - textWidth(count) - textWidth(mark) - 1);
    const name = middle(project.repoName, nameWidth);
    const parts: Line = [
      focused ? seg("▌ ", { fg: theme.accent, dim: !active }) : seg("  "),
      seg(name, { bold: focused }),
      dim(` ${count}`),
      seg(mark, { fg: theme.safe }),
    ];
    parts.push(seg(" ".repeat(Math.max(0, width - free - lineWidth(parts)))));
    if (free)
      parts.push(
        project.error && !project.rows.length
          ? cell("! failed", free, { fg: theme.review }, "right")
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
  const orphans = project.repoPath === ORPHANS;
  const lines: Line[] = [
    [seg(clip(project.repoName, width), { bold: true })],
    [
      dim(
        all
          ? countLabel(repoCount(view), "project")
          : orphans
            ? clip(orphansLabel(project), width)
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
  // Orphans have no Git status to free or keep, only folders and their size.
  if (orphans)
    lines.push([
      seg(`up to ${sizeLabel(project.totalKiB)}`, { fg: theme.orphaned }),
      dim(project.unsized ? ` · ${project.unsized} sizing` : ""),
    ]);
  else
    lines.push(
      [
        seg(`${sizeLabel(project.safeKiB)} safe`, { fg: theme.safe }),
        dim(clip(` of ${sizeLabel(project.totalKiB)}`, width)),
      ],
      dirty
        ? [seg(`${countLabel(dirty, "worktree")} uncommitted`, { fg: theme.review })]
        : [seg("nothing uncommitted", { fg: theme.safe })],
    );
  lines.push([dim(clip(tools.map(([tool, count]) => `${tool} ${count}`).join(" · "), width))]);
  if (oldest) lines.push(named("oldest  ", agoLabel(oldest.committedAt, now), oldest));
  if (largest && largest.sizeKiB !== null)
    lines.push(named("largest ", sizeLabel(largest.sizeKiB), largest));
  return lines.map((line) => fitLine(line, width));
}

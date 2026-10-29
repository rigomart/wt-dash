import { fitLine, type Line } from "../line";
import { listScreen, projectsReady, projectsView } from "../selectors";
import type { UiState } from "../state";
import { SIDEBAR_MIN_WIDTH, pad, type RenderContext, type Viewport } from "./layout";
import { renderList } from "./list";
import { renderSidebar } from "./sidebar";
import { renderProjects } from "./projects";
import { withConfirm } from "./dialogs";
import { withHelp } from "./help";

export { listPageSize } from "./layout";
export type { RenderContext, Viewport } from "./layout";

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

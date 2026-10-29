import type { DashboardSnapshot } from "../../core/types";
import type { Line } from "../line";
import type { Theme } from "../theme";

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

const CHROME_LINES = [
  "header",
  "tabs or column titles",
  "meter",
  "bottom rule",
  "status line",
  "key hints",
].length;

export const bodyHeightFor = (height: number) => Math.max(1, height - CHROME_LINES);

export const SIDEBAR_MIN_WIDTH = 100;

export function sidebarWidth(width: number): number {
  return Math.max(28, Math.min(34, Math.floor(width * 0.22)));
}

export function bottomPanelHeight(bodyHeight: number): number {
  const lines = Math.min(7, bodyHeight - 5);
  return lines >= 3 ? lines : 0;
}

/** Rows the list shows at once; used for page up/down. */
export function listPageSize(height: number): number {
  const body = bodyHeightFor(height);
  return Math.max(1, body - bottomPanelHeight(body) - 1);
}

export function pad(lines: Line[], height: number): Line[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push([]);
  return out;
}

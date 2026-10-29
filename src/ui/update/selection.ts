import { removalBlockReason } from "../../core/assess";
import type { WorktreeRow } from "../../core/types";
import { branchLabel, rowsLabel, sizeLabel } from "../format";
import { inJob } from "../selectors";
import type { Context, UiState } from "../state";
import { toast } from "./result";

export function selectBlock(state: UiState, row: WorktreeRow): string | null {
  if (inJob(state, row.id)) return "it is already being removed";
  const reason = removalBlockReason(row);
  return reason;
}

export function toggleSelect(state: UiState, focus: WorktreeRow | null, ctx: Context): UiState {
  if (!ctx.canAct) return toast(state, ctx, "Removal is not available in this session");
  if (!focus) return state;
  const block = selectBlock(state, focus);
  if (block) return toast(state, ctx, `Can't select ${branchLabel(focus)}: ${block}`, "warn", 6000);
  const selected = new Set(state.selected);
  if (selected.has(focus.id)) selected.delete(focus.id);
  else selected.add(focus.id);
  return { ...state, selected };
}

export function selectAllSafe(
  state: UiState,
  rows: WorktreeRow[],
  ctx: Context,
  project?: string,
): UiState {
  if (!ctx.canAct) return toast(state, ctx, "Removal is not available in this session");
  const where = project ? ` in ${project}` : "";
  const safe = rows.filter((row) => row.verdict === "Safe" && !selectBlock(state, row));
  if (!safe.length) return toast(state, ctx, `No Safe worktrees${where || " in this view"}`);
  const selected = new Set(state.selected);
  if (safe.every((row) => selected.has(row.id))) {
    for (const row of safe) selected.delete(row.id);
    return toast({ ...state, selected }, ctx, `Cleared ${rowsLabel(safe, "Safe")}${where}`);
  }
  for (const row of safe) selected.add(row.id);
  const kib = safe.reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
  return toast(
    { ...state, selected },
    ctx,
    `Selected ${rowsLabel(safe, "Safe")}${where} · up to ${sizeLabel(kib)}`,
    "ok",
  );
}

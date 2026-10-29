import type { RemovalResult } from "../../core/actions";
import type { WorktreeRow } from "../../core/types";
import { branchLabel, rowsLabel, sizeLabel } from "../format";
import type { Context, Effect, Result, Tone, UiState } from "../state";
import { quit, same, toast } from "./result";
import { selectBlock } from "./selection";

export function finishJob(
  state: UiState,
  jobId: number,
  result: RemovalResult | null,
  error: string | null,
  ctx: Context,
): Result {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return same(state);
  const failures = { ...state.failures };
  const gone = new Set(state.gone);
  const removed: WorktreeRow[] = [];
  let freed = 0;
  const problems: string[] = [];
  for (const item of result?.items ?? []) {
    if (!job.order.includes(item.id)) continue;
    const row = job.plan.entries.find((entry) => entry.row.id === item.id)!.row;
    if (item.status === "removed") {
      removed.push(row);
      freed += row.sizeKiB ?? 0;
      gone.add(item.id);
      delete failures[item.id];
    } else {
      failures[item.id] = item.error ?? item.status;
      problems.push(branchLabel(row));
    }
  }
  if (error) for (const id of job.order) if (!gone.has(id)) failures[id] = error;
  const measured = result?.freedKiB;
  const space =
    measured !== null && measured !== undefined
      ? `freed ${sizeLabel(Math.max(0, measured))}`
      : `up to ${sizeLabel(freed)} freed`;
  let summary: string;
  let tone: Tone;
  if (error) {
    summary = `Removal stopped: ${error}`;
    tone = "error";
  } else if (!problems.length) {
    summary = `Removed ${rowsLabel(removed)} · ${space}`;
    tone = "ok";
  } else {
    summary = `Removed ${removed.length} of ${job.order.length} · ${problems.length === 1 ? problems[0] : `${problems.length} worktrees`} not removed, see details`;
    tone = "warn";
  }
  const repos = [
    ...new Set(
      job.plan.entries
        .filter((entry) => job.order.includes(entry.row.id))
        .map((entry) => entry.row.repoPath),
    ),
  ];
  const effects: Effect[] = [{ type: "refresh", repos }];
  const jobs = state.jobs.filter((item) => item !== job);
  if (!jobs.length && state.quitAfterJobs) effects.push({ type: "quit" });
  const next = { ...state, jobs, gone, goneSince: ctx.snapshot.generation, failures };
  return { state: toast(next, ctx, summary, tone, 10_000), effects };
}

/** Quitting never interrupts a running `wt remove`; it waits for the current worktree. */
export function quitRequest(state: UiState, ctx: Context): Result {
  if (state.pruning) return same(toast(state, ctx, "Still pruning; try again in a moment", "warn"));
  if (state.jobs.length) {
    return same(
      toast(
        { ...stopJobs(state), quitAfterJobs: true },
        ctx,
        "Quitting after the current worktree is removed",
        "warn",
        60_000,
      ),
    );
  }
  return quit(state);
}

export function stopJobs(state: UiState): UiState {
  return { ...state, jobs: state.jobs.map((job) => ({ ...job, stopping: true })) };
}

/** x removes the selection, or the focused row when nothing is selected. */
export function startRemoval(state: UiState, focus: WorktreeRow | null, ctx: Context): Result {
  if (!ctx.canAct) return same(toast(state, ctx, "Removal is not available in this session"));
  if (state.pending) return same(state);
  let rows = ctx.snapshot.rows.filter((row) => state.selected.has(row.id));
  if (!rows.length) {
    if (!focus) return same(state);
    const block = selectBlock(state, focus);
    if (block)
      return same(toast(state, ctx, `Can't remove ${branchLabel(focus)}: ${block}`, "warn", 6000));
    rows = [focus];
  }
  const token = state.token + 1;
  return {
    state: {
      ...state,
      token,
      toast: null,
      pending: {
        kind: "removal",
        token,
        label: `Checking ${rowsLabel(rows)}…`,
      },
    },
    effects: [{ type: "prepareRemoval", token, rows }],
  };
}

export function startPrune(state: UiState, focus: WorktreeRow | null, ctx: Context): Result {
  if (!ctx.canAct || !focus) return same(state);
  if (state.pending || state.pruning) return same(state);
  if (state.jobs.length)
    return same(toast(state, ctx, "A removal is still running; prune when it finishes"));
  const token = state.token + 1;
  return {
    state: {
      ...state,
      token,
      toast: null,
      pending: { kind: "prune", token, label: `Checking ${focus.repoName} for missing worktrees…` },
    },
    effects: [{ type: "preparePrune", token, repoPath: focus.repoPath }],
  };
}

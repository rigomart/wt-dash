import { branchLabel, countLabel } from "../format";
import { repoName, soleProject, spinning } from "../selectors";
import type { Context, Result, UiEvent, UiState } from "../state";
import { onKey, openScreen } from "./keys";
import { finishJob } from "./removal";
import { same, toast } from "./result";

export function update(state: UiState, event: UiEvent, ctx: Context): Result {
  switch (event.type) {
    case "key":
      return onKey(state, event.key, ctx);
    case "tick": {
      let next = state;
      if (state.toast && ctx.now >= state.toast.until) next = { ...next, toast: null };
      if (spinning(state, ctx.snapshot)) next = { ...next, frame: state.frame + 1 };
      return same(next);
    }
    case "snapshot": {
      let next = state;
      const phase = ctx.snapshot.progress.phase;
      if (!state.scanned && (phase === "complete" || phase === "error"))
        next = { ...next, scanned: true };
      if (ctx.snapshot.generation !== state.generation)
        next = { ...next, generation: ctx.snapshot.generation, files: {} };
      if (ctx.snapshot.progress.phase === "complete") {
        const ids = new Set(ctx.snapshot.rows.map((row) => row.id));
        if ([...state.selected].some((id) => !ids.has(id)))
          next = { ...next, selected: new Set([...state.selected].filter((id) => ids.has(id))) };
        if (state.gone.size && ctx.snapshot.generation > state.goneSince)
          next = { ...next, gone: new Set() };
      }
      if (next.screen.kind === "projects" && !next.keyPressed) {
        const sole = soleProject(ctx.snapshot);
        if (sole) next = openScreen(next, { kind: "project", repoPath: sole });
      }
      return same(next);
    }
    case "files":
      if (event.generation !== state.generation) return same(state);
      return same({ ...state, files: { ...state.files, [event.id]: event.state } });
    case "planReady": {
      if (state.pending?.kind !== "removal" || state.pending.token !== event.token)
        return same(state);
      const ready = event.plan.entries.filter((entry) => !entry.blockedReason);
      const blocked = event.plan.entries.filter((entry) => entry.blockedReason);
      if (!ready.length) {
        const first = blocked[0];
        return same(
          toast(
            { ...state, pending: null },
            ctx,
            first
              ? `Can't remove ${branchLabel(first.row)}: ${first.blockedReason}`
              : "Nothing to remove",
            "warn",
            8000,
          ),
        );
      }
      return same({
        ...state,
        pending: null,
        toast: null,
        help: false,
        confirm: {
          kind: "remove",
          openedAt: ctx.now,
          plan: event.plan,
          ready,
          blocked,
          deleteUnmerged: false,
          reap: true,
        },
      });
    }
    case "planFailed":
      if (state.pending?.token !== event.token) return same(state);
      return same(
        toast(
          { ...state, pending: null },
          ctx,
          `Couldn't check the selection: ${event.error}`,
          "error",
          8000,
        ),
      );
    case "progress": {
      const job = state.jobs.find((item) => event.id in item.status);
      if (!job) return same(state);
      const next = { ...job, status: { ...job.status, [event.id]: event.status } };
      return same({ ...state, jobs: state.jobs.map((item) => (item === job ? next : item)) });
    }
    case "removalDone":
      return finishJob(state, event.jobId, event.result, null, ctx);
    case "removalFailed":
      return finishJob(state, event.jobId, null, event.error, ctx);
    case "pruneReady":
      if (state.pending?.kind !== "prune" || state.pending.token !== event.token)
        return same(state);
      if (!event.plan.records.length) {
        return same(
          toast(
            { ...state, pending: null },
            ctx,
            `Nothing to prune in ${repoName(event.plan.repoPath)}`,
          ),
        );
      }
      return same({
        ...state,
        pending: null,
        toast: null,
        help: false,
        confirm: { kind: "prune", openedAt: ctx.now, plan: event.plan },
      });
    case "pruneFailed":
      if (event.token !== null && state.pending?.token !== event.token) return same(state);
      return same(
        toast(
          { ...state, pending: null, pruning: false },
          ctx,
          `Prune failed: ${event.error}`,
          "error",
          8000,
        ),
      );
    case "pruneDone":
      return {
        state: toast(
          { ...state, pruning: false },
          ctx,
          `Pruned ${countLabel(event.plan.records.length, "record")} in ${repoName(event.plan.repoPath)}`,
          "ok",
        ),
        effects: [{ type: "refresh", repos: [event.plan.repoPath] }],
      };
  }
}

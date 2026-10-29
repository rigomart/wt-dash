import { readFiles } from "../git/status";
import { removeBatch } from "./execute";
import { planRemoval } from "./plan";
import { previewPrune, pruneRecords } from "./prune";
import type { ActionOptions, ActionService, PrunePlan, RemovalPlan } from "./types";

export function createActionService(options: ActionOptions): ActionService {
  let removalPlan: RemovalPlan | null = null;
  let prunePlan: PrunePlan | null = null;
  let pruning = false;
  let queue: Promise<unknown> = Promise.resolve();
  let removals = 0;

  return {
    inspectFiles: (row) => readFiles(row, options.runner),
    async prepareRemoval(rows) {
      if (pruning) throw new Error("Cleanup is running");
      if (!rows.length) throw new Error("Select at least one worktree");
      removalPlan = await planRemoval(rows, options);
      return removalPlan;
    },
    async executeRemoval(plan, choices, onProgress, shouldStop) {
      if (pruning) throw new Error("Cleanup is running");
      if (plan !== removalPlan) throw new Error("Removal preview is stale");
      removalPlan = null;
      removals++;
      const run = queue.then(() => removeBatch(plan, choices, options, onProgress, shouldStop));
      queue = run.catch(() => {});
      try {
        return await run;
      } finally {
        removals--;
      }
    },
    async preparePrune(repoPath) {
      if (pruning || removals) throw new Error("Cleanup is running");
      prunePlan = await previewPrune(repoPath, options.runner);
      return prunePlan;
    },
    async executePrune(plan) {
      if (pruning || removals) throw new Error("Cleanup is running");
      if (plan !== prunePlan) throw new Error("Prune preview is stale");
      pruning = true;
      prunePlan = null;
      try {
        await pruneRecords(plan, options.runner);
      } finally {
        pruning = false;
      }
    },
  };
}

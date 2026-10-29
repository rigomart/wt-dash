import { dryPrune, pruneNow } from "../git/worktrees";
import type { CommandRunner } from "../types";
import type { PrunePlan } from "./types";

export async function previewPrune(repoPath: string, runner: CommandRunner): Promise<PrunePlan> {
  return { repoPath, records: await dryPrune(repoPath, runner) };
}

export async function pruneRecords(plan: PrunePlan, runner: CommandRunner): Promise<void> {
  const current = await dryPrune(plan.repoPath, runner);
  if (JSON.stringify(current) !== JSON.stringify(plan.records))
    throw new Error("Prunable records changed; preview again");
  if (!current.length) return;
  await pruneNow(plan.repoPath, runner);
}

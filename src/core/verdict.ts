import { assess } from "./assess";
import type { Verdict, WorktreeFacts } from "./types";

/** Compatibility entry point; all rules live in assess. */
export function verdictFor(row: WorktreeFacts): { verdict: Verdict; reason: string } {
  const { verdict, reason } = assess(row);
  return { verdict, reason };
}

import type { Style } from "../line";
import { jobStatus } from "../selectors";
import type { RunStatus, UiState } from "../state";
import type { Theme } from "../theme";
import { SPINNER } from "./common";

interface RowStatus {
  icon: string;
  label: string;
  style: Style;
  done: boolean;
}

/** A row's place in a running removal, or why the last attempt left it in place. */
export function removalStatus(state: UiState, id: string, theme: Theme): RowStatus | null {
  const running = jobStatus(state, id);
  const look: Record<RunStatus, RowStatus> = {
    waiting: { icon: "◦", label: "queued", style: { dim: true }, done: false },
    removing: {
      icon: SPINNER[state.frame % SPINNER.length]!,
      label: "removing…",
      style: { fg: theme.accent },
      done: false,
    },
    removed: { icon: "✓", label: "removed", style: { fg: theme.safe }, done: true },
    failed: { icon: "✗", label: "removal failed", style: { fg: theme.broken }, done: false },
    skipped: { icon: "!", label: "not removed", style: { fg: theme.review }, done: false },
    unverified: { icon: "?", label: "check result", style: { fg: theme.review }, done: false },
  };
  if (running) return look[running];
  if (state.failures[id]) return { ...look.failed, icon: "✗" };
  return null;
}

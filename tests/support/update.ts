import type { RemovalEntry } from "../../src/core/actions";
import type { DashboardSnapshot, WorktreeRow } from "../../src/core/types";
import {
  initialState,
  type Context,
  type Key,
  type UiEvent,
  type UiState,
} from "../../src/ui/state";
import { update } from "../../src/ui/update";

export function row(
  id: string,
  sizeKiB: number,
  overrides: Partial<WorktreeRow> = {},
): WorktreeRow {
  return {
    id,
    repoPath: "/repos/alpha",
    repoName: "alpha",
    path: `/repos/alpha/worktrees/${id}`,
    branch: id,
    headSha: "abcdef1",
    committedAt: "2026-09-28T00:00:00Z",
    createdAt: "2026-09-27T00:00:00Z",
    kind: "worktree",
    marker: null,
    markerSetAt: null,
    tool: "Claude",
    changes: {
      staged: false,
      modified: false,
      untracked: false,
      renamed: false,
      deleted: false,
      conflicted: false,
    },
    upstreamAhead: 0,
    mainState: "integrated",
    lockReason: null,
    mainAhead: null,
    defaultBranch: "main",
    mainBase: "main",
    locked: false,
    prunable: false,
    operation: null,
    sizeKiB,
    sizeMeasuredAt: null,
    verdict: "Safe",
    reason: "Integrated",
    ...overrides,
  };
}

export function context(rows: WorktreeRow[]): Context {
  const snapshot: DashboardSnapshot = {
    generation: 1,
    repos: [],
    rows,
    errors: {},
    fatalError: null,
    progress: {
      phase: "complete",
      reposTotal: 1,
      reposDone: 1,
      startedAt: null,
      completedAt: null,
    },
  };
  return { snapshot, now: 1_000, pageSize: 10, canAct: true, canExpand: true };
}

export function press(
  state: UiState,
  ctx: Context,
  ...keys: Array<string | Partial<Key>>
): UiState {
  for (const item of keys) {
    const key: Key =
      typeof item === "string"
        ? {
            name: item.length === 1 ? item.toLowerCase() : item,
            char: item.length === 1 ? item : "",
            ctrl: false,
          }
        : { name: "", char: "", ctrl: false, ...item };
    state = update(state, { type: "key", key }, ctx).state;
  }
  return state;
}

export function openedWorktreeList(ctx: Context): UiState {
  const state = update(initialState(), { type: "snapshot" }, ctx).state;
  return state.screen.kind === "projects" ? press(state, ctx, "g", "return") : state;
}

export function send(state: UiState, ctx: Context, event: UiEvent) {
  return update(state, event, ctx);
}

export const entry = (item: WorktreeRow, overrides: Partial<RemovalEntry> = {}): RemovalEntry => ({
  row: item,
  blockedReason: null,
  localFiles: [],
  ignoredFiles: [],
  disposableIgnored: 0,
  requiresDiscard: false,
  branchWillBeRetained: false,
  ...overrides,
});

export const beta = (id: string, sizeKiB: number, overrides: Partial<WorktreeRow> = {}) =>
  row(id, sizeKiB, {
    repoName: "beta",
    repoPath: "/repos/beta",
    path: `/repos/beta/worktrees/${id}`,
    ...overrides,
  });

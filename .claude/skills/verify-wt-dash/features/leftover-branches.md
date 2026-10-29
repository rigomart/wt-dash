# Leftover branches

Local branches without a worktree (other than main) are listed as rows whose size column reads `branch`, with the same verdicts. A merged one older than a day is Safe; an unmerged one is Review and its removal deletes it only if you press `D` in the dialog.

## Entry points and variants

- A project's list and "All projects"; the remove dialog. Wide and narrow.

## Preconditions

- Focus: these keys act on a list. After `up` the projects are focused on `api`; Tab (wide) or Enter (narrow) focuses `api`'s list, footer `space select  enter remove …`.
- A fresh instance: `api › leftover/hotfix` (merged, Safe) and `api › leftover/spike` (unmerged, Review). Removal is destructive: `down --purge` and `up` before rerunning.

## Checks

1. `api` reads `7 worktrees and 2 branches`; `leftover/hotfix` sits in SAFE with `merged  Its commits are already in main  3d  branch`, and `leftover/spike` in REVIEW with `unmerged commits  1 commit isn't in main  3d  branch`.
2. The sidebar details of `api` include `no worktree 2`.
3. Selecting `leftover/spike` and pressing Enter opens `Remove 1 branch · up to 0 KB?` with `! Skips leftover/spike unless you press D: not merged, and no worktree` and `Keeps 1 unmerged branch  D delete too`.
4. `D` turns that into `Also deletes 1 unmerged branch  D keep them` and drops the skip warning. Reopening the dialog starts again at `Keeps`.
5. `D` then `y`: `✓ Removed 1 branch · freed 0 KB`; `state` no longer lists `leftover/spike` in `api` → `branches`, and the last `removalsLog` entry has `"path": null`, `"flags": ["-D"]`, `"branchOutcome": "deleted"`.
6. On a fresh instance, `y` without `D` shows `! Removed 0 of 1 · leftover/spike not removed, see details`; the row reads `✗ leftover/spike  removal failed`, its strip `Last removal failed: Deleting the unmerged branch was not confirmed`; `state` still lists the branch and `removalsLog` has no entry for it.

## Traps

- A skipped branch is not written to `removals.log`; prove a skip with `state`.

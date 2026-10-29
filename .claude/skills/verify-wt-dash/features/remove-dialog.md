# Remove dialog and removal

Enter or `x` opens one confirmation dialog listing each row and its size, the total, which rows would lose uncommitted changes, and what happens to branches and processes. `D` toggles deleting unmerged branches, `e` toggles leaving processes running. `y` or Enter confirms, Esc cancels. Removal runs in the background, and every attempt is logged to `~/.cache/wt-dash/removals.log` (the instance's HOME).

## Entry points and variants

- Enter or `x` with a selection, or on a focused row with no selection. Wide and narrow.
- From the projects screen, `x` removes the selection.

## Preconditions

- Focus: these keys act on a list. After `up` the projects are focused on `api`; Tab (wide) or Enter (narrow) focuses `api`'s list, footer `space select  enter remove …`.
- A fresh instance. Removal is destructive: `down --purge` and `up` before rerunning these checks.

## Checks

1. Space on `api › feature/assets`, then `x`: the dialog title is `Remove 1 worktree · up to 12.0 MB?`, it lists `• feature/assets  api  12.0 MB`, and reads `Nothing uncommitted. Ignored files and caches go with them.`, `Merged branches are deleted.`, `Stops processes running inside  e leave them`, and `Remove 1  y / enter    [ Cancel  esc ]`.
2. `e` turns the line into `Processes inside keep running  e stop them`; `e` again restores it.
3. Esc closes the dialog and keeps the selection (`■ 1 selected`).
4. With `feature/dirty-form` also selected the dialog shows `! Discards uncommitted changes in feature/dirty-form`.
5. Enter twice in one `send-keys` (open, then Enter within 400 ms) leaves the dialog open; Enter sent after the dialog has shown confirms.
6. `y` removes: the status line (line 31 wide, 23 narrow) shows `Removing 1 of 1: feature/assets` with a spinner, then `✓ Removed 1 worktree · freed 12.0 MB`; the row is gone and the tabs count one fewer.
7. `state` shows the worktree gone from `git worktree list` and its branch gone from `git branch`; the last `removalsLog` entry has that branch, `exitCode: 0`, `branchOutcome: "deleted"`, and `flags: ["--reap"]` (or `[]` when `e` left processes running; a dirty worktree adds `"-f"`).
8. The developer's own `~/.cache/wt-dash/removals.log` is unchanged (compare its `ls -l` before and after).

## Traps

- A local removal finishes in under a second; the `Removing …` line is gone by the next capture unless you poll for it.
- The summary toast stays 10 s, so a second removal inside that time may show the previous summary.
- After a removal the app rescans on its own; `scanned HH:MM` changes.
- A removal in `web` also drops the Broken `feature/gone` record, so `Broken` goes to 0 there; see [blocked-rows.md](blocked-rows.md).

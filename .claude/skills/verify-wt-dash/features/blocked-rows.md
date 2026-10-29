# Blocked rows

A locked worktree, one with a rebase, merge or conflicts in progress, and a worktree whose folder is gone cannot be selected or removed. The app says why and what to do next. Enter on a Broken row offers to prune Git's record instead.

## Entry points and variants

- Space, Enter and `x` on a blocked row; `a` (never selects them); details `i`. Wide and narrow.

## Preconditions

- Focus: these keys act on a list. After `up` the projects are focused on `api`; Tab (wide) or Enter (narrow) focuses `api`'s list, footer `space select  enter remove …`.
- A fresh instance. Pruning is destructive: `down --purge` and `up` before rerunning check 5.

## Checks

1. Space on `api › feature/locked` shows the toast `! Can't select feature/locked: it's locked (agent session); unlock it first`, and the row keeps `–`.
2. Enter on it shows `! Can't remove feature/locked: it's locked (agent session); unlock it first`, and no dialog opens.
3. `i` on it shows `● Review · locked`, `Locked: agent session`, and `Can't be removed: it's locked (agent session); unlock it first`.
4. Space on `web › feature/rebase` (tab 4) shows `! Can't select feature/rebase: finish or abort the rebase first`, and `x` shows `! Can't remove feature/rebase: finish or abort the rebase first`; its section reads `‖ BUSY  1 worktree · 28 KB · finish the Git operation first`.
5. Enter on `web › feature/gone` (tab 5) opens `Prune 1 missing worktree record in web?` with `The folders are already gone; this removes only Git's records of them.` and `Prune  y / enter`. `y` shows `✓ Pruned 1 record in web`, the Broken tab reads `Broken 0`, and `state` no longer lists the worktree. Its branch stays, so `feature/gone` comes back as a branch row (`web` then reads `5 worktrees and 1 branch`).

## Traps

- A prune is not written to `removals.log`; prove it with `state`.
- Removing any other worktree in `web` also drops `feature/gone`'s record: after removing `feature/bundle` or `fix/header`, `web` reads `Broken 0` and `feature/gone` is a branch row (seen twice). Run check 5 on a fresh seed before removing anything in `web`.

# Remove dialog and removal

Enter or `x` opens one confirmation dialog listing each row and its size, the total, which rows would lose uncommitted changes or ignored files that aren't caches, which have running processes, and what happens to branches and processes. `D` toggles deleting unmerged branches, `e` toggles leaving processes running. `y` or Enter confirms, Esc cancels. Removal runs in the background, and every attempt is logged to `~/.cache/wt-dash/removals.log` (the instance's HOME).

## Entry points and variants

- Enter or `x` with a selection, or on a focused row with no selection. Wide and narrow.
- From the projects screen, `x` removes the selection.

## Preconditions

- Focus: these keys act on a list. After `up` the projects are focused on `api`; Tab (wide) or Enter (narrow) focuses `api`'s list, footer `space select  enter remove …`.
- A fresh instance. Removal is destructive: `down --purge` and `up` before rerunning these checks.

## Checks

1. Space on `api › feature/assets` (fresh seed: its only ignored paths are caches), then `x`: the dialog title is `Remove 1 worktree · up to 12.0 MB?`, it lists `• feature/assets  api  12.0 MB`, shows no `Deletes ignored files` note, and reads `Nothing uncommitted. Ignored files and caches go with them.`, `Merged branches are deleted.`, `Stops processes running inside  e leave them`, and `Remove 1  y / enter    [ Cancel  esc ]`.
2. `e` turns the line into `Processes inside keep running  e stop them`; `e` again restores it.
3. Esc closes the dialog and keeps the selection (`■ 1 selected`).
4. With `feature/dirty-form` also selected the dialog shows `! Discards uncommitted changes in feature/dirty-form`.
5. Enter twice in one `send-keys` (open, then Enter within 400 ms) leaves the dialog open; Enter sent after the dialog has shown confirms.
6. `y` removes: the status line (line 31 wide, 23 narrow) shows `Removing 1 of 1: feature/assets` with a spinner, then `✓ Removed 1 worktree · freed 12.0 MB`; the row is gone and the tabs count one fewer.
7. `state` shows the worktree gone from `git worktree list` and its branch gone from `git branch`; the last `removalsLog` entry has that branch, `exitCode: 0`, `branchOutcome: "deleted"`, and `flags: ["--reap"]` (or `[]` when `e` left processes running; a dirty worktree adds `"-f"`).
8. A worktree with uncommitted changes on a branch that `main` has moved past (Worktrunk lists it `behind`, integration reason `ancestor`; arrange it with Git as in [rescan.md](rescan.md): a worktree on a new branch from `main`, a commit on `main`, an edit in the worktree, then `r`): its dialog reads `Merged branches are deleted.`, not `Keeps 1 unmerged branch`, and after `y` the branch is gone from `git branch` and the `removalsLog` entry has `flags: ["-f", "--reap"]` and `branchOutcome: "deleted"` (#23).
9. Ignored files that aren't caches are named (#45). Arrange them as the instance's user: `git config --global core.excludesFile "$HOME/.gitignore_global"` with `.env*` and `*.db` in that file, then create `.env.local`, `.env.prod`, `.env.test` and `dev.db` in `api`'s `feature/assets` worktree (under `paths.worktrees`; it already holds `node_modules/` and `dist/`) and `dev.db` in `feature/login`, and press `r`. With only `feature/assets` selected the dialog shows `! Deletes ignored files in feature/assets: .env.local, .env.prod +2 more` (two names, then the rest counted), keeps `Nothing uncommitted. Ignored files and caches go with them.`, and never mentions `node_modules` or `dist`. With `feature/login` also selected the note reads `! Deletes ignored files in feature/assets and feature/login`, and past two worktrees it shortens like the uncommitted note. `web › feature/bundle`, whose only ignored paths are `node_modules/` and `dist/`, shows no such note. Check wide and narrow; `y` still removes (`flags: ["--reap"]`).
10. Running processes (#44): with a server running in `api › feature/assets` and found by a scan (arrange it as in [details.md](details.md) check 9), its dialog reads `Running in feature/assets: 1 process · :8765` on the line under `Stops processes running inside  e leave them`, and keeps it when `e` turns that line into `Processes inside keep running  e stop them`. With three such worktrees selected it reads `Processes are running in agent/old-session, feature/assets +1 more`. After `y` with processes stopped, the server's pid is gone (`kill -0 <pid>` fails), `lsof -nP -iTCP:8765 -sTCP:LISTEN` prints nothing, and the `removalsLog` entry has `flags: ["--reap"]`.
11. The confirm button is a solid red block whose text contrasts with it in both themes (#58), never reverse video. Through `t capture-pane -p -e -t app | cat -v` the button reads `^[[0;1m^[[38;2;0;0;0m^[[48;2;229;83;75m Remove 1  y / enter ` (bold black on a light red) with no `7` (reverse) attribute. On a tmux server whose `window-style` is `fg=#24292f,bg=#ffffff` (`t set -g window-style …` while the app runs; the app follows the switch) it turns `38;2;255;255;255` on `48;2;198;40;40` (white on a darker red); `fg=#c5c8c6,bg=#1d1f21` turns it back. Render each with `image` (`--theme light` for the white one): light or dark text on a red block, never red text. The prune dialog's `Prune  y / enter` is the same button. Check wide and narrow.
12. The developer's own `~/.cache/wt-dash/removals.log` is unchanged (compare its `ls -l` before and after).

## Traps

- A local removal finishes in under a second; the `Removing …` line is gone by the next capture unless you poll for it.
- The summary toast stays 10 s, so a second removal inside that time may show the previous summary.
- After a removal the app rescans on its own; `scanned HH:MM` changes.
- A removal in `web` also drops the Broken `feature/gone` record, so `Broken` goes to 0 there; see [blocked-rows.md](blocked-rows.md).

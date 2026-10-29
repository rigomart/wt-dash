# Narrow table layout

Below 100 columns the projects fill a table with a column per verdict, Safe size and total; Enter opens one; the focused project's or row's details sit in a strip under the table or list.

## Entry points and variants

- `up --variant narrow` (80x24), or `resize-window -x 80 -y 24` on a running instance (the app redraws on resize).

## Preconditions

- A fresh instance.

## Checks

1. Right after `up --variant narrow`, line 1 reads `wt-dash    16 worktrees and 2 branches · up to 16.4 MB · scanned HH:MM  r rescan`, the focused row is `▌ api` (not "All projects"), and the footer is `enter open  a select safe  / search`.
2. The header row is `PROJECT  WORKTREES  SAFE  REVIEW  BUSY  BROKEN  SAFE SIZE  TOTAL`, followed by `All projects 16 7 8 2 1 16.1 MB 16.4 MB`, `api 7 4 5 · · 12.1 MB 12.2 MB`, `web 6 2 2 1 1 4.0 MB 4.1 MB`, `docs 3 1 1 1 · 12 KB 40 KB` (spacing aside; `·` means zero).
3. Under the table: `1 project with no worktrees` (the seeded `tools` repo, which the wide sidebar does not mention).
4. Up to "All projects" (`▌ All projects`): the strip reads `SAFE TO FREE  16.1 MB of 16.4 MB · 1 sizing`, `UNCOMMITTED   3 worktrees`, `MADE BY       other 16 · no worktree 2`, `LARGEST       feature/assets · 12.0 MB`.
5. With `api` focused (the start; Down from "All projects"), Enter opens `wt-dash › api` with tabs `All 9  Safe 4  Review 5  Busy 0  Broken 0` and the footer `space select  enter remove  a all safe  / search  s sort: size ↓  ? keys  q quit`.
6. Long branch names are cut in the middle: `feature/n…-endpoint`.

## Traps

- `resize-window` takes effect at once, but wait for a narrow-only text (`PROJECT ` header) before reading; the first capture after a resize may still be the old frame.

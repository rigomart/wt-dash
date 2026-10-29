# Rescan r

`r` rescans every repository from any screen, keeping the current rows on screen until fresh ones arrive, and picks up worktrees and branches changed outside the app.

## Entry points and variants

- `r` on the projects screen and in a list. Wide and narrow.

## Preconditions

- A fresh instance, plus a worktree created outside the app with Git as the instance's user (a supported path for arranging state):
  `eval "<env → exports>"; git -C "$HOME/../projects/docs" worktree add -q -b feature/external "$HOME/../worktrees/docs.feature-external" main`

## Checks

1. Before `r`, `docs` reads `docs 3` and no row named `feature/external` exists.
2. Right after `r`, line 1 shows a spinner and `scanning 0/4 repos` (the 4 seeded repos, `tools` included).
3. When line 1 reads `scanned HH:MM` again, the sidebar reads `docs 4` and `All projects 17`, and in `docs` the row `feature/external` is in REVIEW with `no new commits  Created just now, so it may s…`.

## Traps

- The scan of the seed takes well under a second; poll for `scanning` right after the key, every 50 ms, or it is missed.
- Run the `eval` and the `git` in the same shell call: each call starts a new shell.

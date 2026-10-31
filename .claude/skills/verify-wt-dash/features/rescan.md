# Rescan r

`r` rescans every repository from any screen, keeping the current rows on screen until fresh ones arrive, and picks up worktrees and branches changed outside the app.

## Entry points and variants

- `r` on the projects screen and in a list; `R` on a focused worktree in a list. Wide and narrow.

## Preconditions

- A fresh instance, plus a worktree created outside the app with Git as the instance's user (a supported path for arranging state):
  `eval "<env → exports>"; git -C "$HOME/../projects/docs" worktree add -q -b feature/external "$HOME/../worktrees/docs.feature-external" main`

## Checks

1. Before `r`, `docs` reads `docs 3` and no row named `feature/external` exists.
2. Right after `r`, line 1 shows a spinner, initially `scanning 0/0 repos` until discovery finishes, then `scanning 0/4 repos` (the 4 seeded repos, `tools` included).
3. When line 1 reads `scanned HH:MM` again, the sidebar reads `docs 4` and `All projects 17`, and in `docs` the row `feature/external` is in REVIEW with `no new commits  Created just now, so it may s…`.
4. Once sizes settle, another `r` keeps the saved sizes. Paths still being measured remain marked as sizing until their own pending measurements finish; failed measurements stop being marked even when their size is unknown. Fresh-cache checks can share one snapshot update across a short display frame.
5. On `api › feature/assets`, add a 2 MiB file at the worktree root outside the app, then `r`. Its displayed size grows from `12.0 MB` to `14.0 MB` once sizing finishes. A root-level untracked file also moves this row to REVIEW; find and focus it again before the next check.
6. Add a 2 MiB file under the existing `node_modules/pkg/` folder. `r` keeps the cached size while the worktree root and `node_modules` timestamps are unchanged and the measurement is under 24 hours old. `R` on the focused worktree always measures again: the toast reads `Measuring feature/assets…`, then the row reads `16.0 MB`. Repeat in the other layout, adding another 2 MiB: `R` then shows `18.0 MB`.
7. After remeasurement finishes, `r` and a restart on the same sandbox retain the latest measured size. The instance's `sizes.json` agrees with the row. If an older scan measurement finishes after a newer manual measurement, it cannot replace that newer result in the row or saved cache. A failed newer measurement keeps the prior saved value; it does not revive a superseded result.

## Traps

- The scan of the seed takes well under a second; poll for `scanning` right after the key, every 50 ms, or it is missed.
- Run the `eval` and the `git` in the same shell call: each call starts a new shell.
- Size-cache writes may be combined, but awaiting a measurement still waits for its cache write attempt, and closing flushes pending writes. Filesystem write failures leave the measured size visible.

# Worktree list and verdicts

A project's rows are grouped into Safe, Review, Busy and Broken sections. Each row shows a checkbox (or `–` when blocked), its branch, its Git status, the reason behind the verdict, its age and its size (`branch` for a branch without a worktree).

## Entry points and variants

- A single project (focus it in the sidebar, or open it) and "All projects", wide and narrow.

## Preconditions

- A fresh instance. The expected verdict, status and reason of every seeded row are in `env` → `seed`.

## Checks

1. In `api`, section headers read `✓ SAFE  3 worktrees and 1 branch · 12.1 MB · can go` and `? REVIEW  4 worktrees and 1 branch · 148 KB · needs a look`.
2. Every seeded row appears once, in the section of its seeded verdict, with its seeded status. Compare each row on "All projects" (18 rows) against `seed`.
3. The reason column is the seeded reason without its final period, cut with `…` when narrow: `feature/login` shows `Its commits are already in main`; a locked row shows its lock reason only (`agent session`, `no reason given`).
4. Agent marks: `api › agent/refactor` is Review with `An agent was working here <age>` (a mark under a day old); `api › agent/old-session` is Safe (its mark is 3 days old).
5. Fresh worktree: `api › feature/new-endpoint` is Review, `no new commits`, `Created <age>, so it may s…`.
6. `web` shows `‖ BUSY  1 worktree · 28 KB · finish the Git operation first` and `✗ BROKEN  1 worktree · 0 KB · folder missing; prune the record`, the Broken row with age `?` and size `…`.
7. Blocked rows (`feature/locked`, `docs/locked-bare`, `feature/rebase`, `docs/conflict`, `feature/gone`) show `–` instead of `□`.
8. Section colors, read with `capture-pane -p -e`: the header escape before `✓ SAFE` is `38;5;2` (green), `? REVIEW` `38;5;3`, `‖ BUSY` `38;5;4`, `✗ BROKEN` `38;5;1`. How they look is checked by eye on a PR image.

## Traps

- Ages tick: `just now` becomes `1m ago` within a minute. Match the stable part of the text.
- On Linux the real binary sees backdated worktrees as new: `feature/login` and `docs/typos` are Review there, and `env` → `seed` says so (`backdatesOnDisk: false`).

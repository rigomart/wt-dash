# Projects screen

wt-dash opens on its projects: an "All projects" entry first, then each repository with linked worktrees, most worktrees first, with how much space its Safe rows free. Moving through the projects shows each one's rows and details right away.

## Entry points and variants

- Wide (120x32): projects in a sidebar, the focused project's rows to the right, its details under the projects.
- Narrow (80x24): see [narrow-table.md](narrow-table.md).
- Keys: ↑/↓ or j/k move; Enter, → or Tab open the list; ← or Tab come back; `[`/`]` previous/next project from the list.

## Preconditions

- A fresh instance (`up`), nothing removed yet.

## Checks

1. Right after `up`, line 1 reads `wt-dash › api` and `7 worktrees and 2 branches · up to 12.2 MB · scanned HH:MM  r rescan`; the focused sidebar row is `▌ api 7` with `12.1 MB`, `api`'s rows show on the right without focus, and the footer reads `→ worktrees  a select safe  / search`.
2. The sidebar lists, in order: `All projects 22  16.2 MB`, `api 7  12.1 MB`, `web 6  4.0 MB`, `worker 6  72 KB`, `docs 3  12 KB` (`worker` ties `web` and sorts after it by name). The repo `tools` (no worktrees) is not listed.
3. Up to "All projects", once GitHub has answered: line 1 reads `wt-dash › all projects` with `4 projects · 22 worktrees and 3 branches · up to 16.5 MB · scanned HH:MM`, with no `sizing` or `checking GitHub`; line 2 tabs read `All 25  Safe 12  Review 10  Busy 2  Broken 1  Orphaned 0`.
4. The details under the sidebar for "All projects": `4 projects`, `16.2 MB safe of 16.5 MB`, `3 worktrees uncommitted`, `other 22 · no worktree 3`.
5. Focusing `web`: details read `4.0 MB safe of 4.1 MB`, `1 worktree uncommitted`, `other 6`, `largest 4.0 MB · feat…ndle`.
6. Tab moves into the list: the footer starts `space select  enter remove`; ← brings back `→ worktrees  a select safe` in the footer.
7. From web's list, `]` shows `wt-dash › worker` with tabs `All 7  Safe 5  Review 2  Busy 0  Broken 0  Orphaned 0`, and `]` again `wt-dash › docs` with `All 3  Safe 1  Review 1  Busy 1  Broken 0  Orphaned 0`; `[` steps back to `wt-dash › worker`, then `wt-dash › web`.

## Traps

- Sizes other than `feature/assets` (12.0 MB) and `feature/bundle` (4.0 MB) are a few KB from `du` and were measured on macOS APFS; on another file system compare them with `state`/`du`, not these numbers.
- `web › feature/gone` (Broken, folder missing) has no size, so its size column shows `…`; its `du` fails at once and the header does not count it as `sizing` (#24). `N sizing` counts worktrees with no size whose `du` is running right now, whatever the verdict: a failed `du` (folder gone, unreadable subfolder) stops counting, and `r` or `R` counts it again while it reruns. A seeded scan finishes in under a second.

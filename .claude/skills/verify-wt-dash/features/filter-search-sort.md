# Filter, search and sort

In a worktree list, 1–5 show All, Safe, Review, Busy or Broken; `/` searches by repo, branch, tool or path as you type; `s` cycles the sort and `S` reverses it; `v` groups "All projects" by repo instead of verdict. Esc steps back one thing at a time.

## Entry points and variants

- A single project's list and the "All projects" list, wide and narrow.

## Preconditions

- A fresh instance, with a list focused: after `up` the projects are focused on `api`; Tab (wide) or Enter (narrow) focuses its list, footer `space select  enter remove …`.

## Checks

1. In `api`, `3` leaves only `? REVIEW  4 worktrees and 1 branch`; `5` shows `No Broken worktrees. Press 1 to see all.`; `1` shows every section again.
2. `/` opens the search: line 2 ends with `/    9 of 18` (rows in view of all rows). Typing `spike` (send it with `send-keys -l`) leaves one row, `leftover/spike`, the tabs read `All 1  Safe 0  Review 1  Busy 0  Broken 0`, and line 2 ends `/ spike   1 of 18`.
3. Enter keeps the search: line 2 ends with `/ spike  esc clears`. Esc alone clears it: line 2 ends with `/ search` and the tabs are back to `All 9`.
4. `s` cycles the footer label `s sort: size ↓` → `s sort: age ↓` → `s sort: repo ↑` → `s sort: size ↓`; `S` turns `size ↓` into `size ↑`.
5. With `size ↓` on "All projects", the Safe section starts `feature/assets` (12.0 MB) then `feature/bundle` (4.0 MB); with `size ↑` it starts `docs/typos`, and `leftover/hotfix` (branch) stays last either way.
6. `v` on "All projects" replaces the verdict sections with repo groups, the first reading `▸ api  7 worktrees and 2 branches · 12.2 MB  4 safe  5 review`, each row with a colored `●`, and the footer shows `v by repo`; `v` again restores them. In a single project, `v` shows the toast `Grouping by repo works in the all-projects view`.
7. Search matches the name a tool is shown by (#43). After `git worktree add -b try/gemini <api>/.gemini/worktrees/try-gemini main` as the instance's user and `r`, typing `gemini cli` leaves one row, `try/gemini`, and line 2 ends `/ gemini cli   1 of <all rows>`. The path holds `.gemini` but not `gemini cli`, so only the tool's name matches.

## Traps

- Send Escape on its own and wait for its effect before the next key. `send-keys Escape 3` arrives as Alt+3: the search stays and the tab does not change (reproduced twice). A person's keystrokes never arrive that close together.
- The footer always contains `/ search`; do not use it as the sign that a search was cleared. Read line 2.

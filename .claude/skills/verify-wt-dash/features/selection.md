# Selection and a

Space selects or unselects the focused row. `a` selects every Safe row in view (in a list) or in the focused project or all projects (on the projects), and pressing it again unselects them. Rows that are Review because they are new or carry a recent agent mark are left out. Selections carry across screens and resizes, and Esc clears them.

## Entry points and variants

- `a` with the projects focused (a project, or "All projects") and with a list focused; Space in a list. Wide and narrow.
- Focus: after `up`, the projects are focused on `api` (wide footer `→ worktrees`, narrow `enter open`). Tab (wide) or Enter (narrow) focuses `api`'s list (footer `space select  enter remove …`).

## Preconditions

- A fresh instance, nothing selected.

## Checks

1. Projects focused on `api` (the start of either variant): `a` shows `✓ Selected 3 Safe worktrees and 1 branch in api · up to 12.1 MB` and the footer `■ 4 selected · up to 12.1 MB   x remove  esc clear`. The wide sidebar row reads `▌ api 7 ■4`. Esc clears it: the footer returns to `→ worktrees  a select safe  / search` (wide) or `enter open  a select safe  / search` (narrow).
2. List focused in `api`: `a` shows `✓ Selected 3 Safe worktrees and 1 branch · up to 12.1 MB` and the footer `■ 4 selected · up to 12.1 MB   enter remove  esc clear`. The four Safe rows show `■`; `feature/new-endpoint` and `agent/refactor` stay `□`.
3. List focused, continuing: Space on `feature/dirty-form` marks it `■` and the footer reads `■ 5 selected · up to 12.1 MB`.
4. Moving to `web` (`]`, list focused), then back to the projects (←) and up to "All projects", keeps the marks: the sidebar reads `All p…jects 16 ■5` and `api 7 ■5`, and the footer `■ 5 selected · up to 12.1 MB   x remove  esc clear`.
5. Projects focused on "All projects", continuing: `a` selects every Safe row, including those already selected: `✓ Selected 6 Safe worktrees and 1 branch in every project · up to 16.1 MB`, footer `■ 8 selected · up to 16.1 MB   x remove  esc clear`.
6. Same focus, `a` again: `Cleared 6 Safe worktrees and 1 branch in every project`, and `feature/dirty-form` stays selected: footer `■ 1 selected · up to 44 KB`.
7. List focused with a selection and no search: Esc clears it, and the footer returns to `space select  enter remove  a all safe`.
8. A selection survives `resize-window` both ways: `■ 1 selected` before, narrow and wide again.

## Traps

- The footer says which focus you are in: `x remove` with the projects focused, `enter remove` with a list focused. Wait on what the new state should show, not on a footer from before.
- Clear the selection before switching variants, or the next variant starts with it.

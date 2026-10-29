# Details i

`i` in a list replaces the list with the focused row's full details; `i` again goes back. The strip under the list always shows a short version of the focused row.

## Entry points and variants

- `i` in a single project's list and in "All projects". Wide (strip under the list, beside the sidebar) and narrow (strip under the list).

## Preconditions

- Focus: these keys act on a list. After `up` the projects are focused on `api`; Tab (wide) or Enter (narrow) focuses `api`'s list, footer `space select  enter remove …`. The strip (check 3) shows with either focus.
- A fresh instance.

## Checks

1. On `api › feature/assets`, `i` shows `api / feature/assets`, `● Safe · merged`, `Merging it into main would change nothing.`, a `PATH` block with the worktree path from `seed`, `CREATED BY    other`, `CHANGES       clean`, `UPSTREAM      no tracking branch`, `SIZE          12.0 MB · measured <age>`, `UNCOMMITTED   none`, `IGNORED       2 cache folders`, and the footer `↑↓ scroll  i back`.
2. `i` again returns to the list with the same row focused.
3. The strip under the list for `api › agent/old-session` reads `agent/old-session  ● Safe · merged`, its path, `other · last commit <age> · <sha> · clean · no tracking branch`, and `Agent mark from 3d ago, likely stale.`
4. For `api › feature/locked`, details read `Locked: agent session` and `Can't be removed: it's locked (agent session); unlock it first`.

## Traps

- The strip shows `checking files…` for a moment after focus moves; wait for `nothing uncommitted` or `ignored` before reading it.
- Long paths are cut in the middle with `…` in the strip; read the full path from `i`, which wraps it.

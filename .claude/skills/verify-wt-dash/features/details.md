# Details i

`i` in a list replaces the list with the focused row's full details; `i` again goes back. The strip under the list always shows a short version of the focused row.

## Entry points and variants

- `i` in a single project's list and in "All projects". Wide (strip under the list, beside the sidebar) and narrow (strip under the list).

## Preconditions

- Focus: these keys act on a list. After `up` the projects are focused on `api`; Tab (wide) or Enter (narrow) focuses `api`'s list, footer `space select  enter remove …`. The strip (check 3) shows with either focus.
- A fresh instance.

## Checks

1. On `api › feature/assets`, `i` shows `api / feature/assets`, `● Safe · merged`, `Merging it into main would change nothing.`, a `PATH` block with the worktree path from `seed`, `CREATED BY    other`, `COMMITS       1 ahead of main · <n> behind · +1 line`, `MESSAGE       Change feature-assets.txt`, `CHANGES       clean`, `UPSTREAM      no tracking branch`, `SIZE          12.0 MB · measured <age>`, `UNCOMMITTED   none`, `IGNORED       2 cache folders`, and the footer `↑↓ scroll  i back`.
2. `i` again returns to the list with the same row focused.
3. The strip under the list for `api › agent/old-session` reads `agent/old-session  ● Safe · merged`, its path, `1 commit ahead of main · +1 · “Change agent-old-session.txt”`, `other · last commit <age> · <sha> · clean · no tracking branch`, and `Agent mark from 3d ago, likely stale.`, in both variants.
4. The strip names what a row holds beyond main: `api › feature/new-endpoint` reads `no commits beyond main` with no subject, and the branch row `api › leftover/spike` reads `1 commit ahead of main · +1 · “Change leftover-spike.txt”`.
5. Notes left on a branch show in both places. After `git config branch.<branch>.description` and `wt config state vars set <key>=<value> --branch <branch>` as the instance's user, and `r`: the strip shows a line under the commits line with the description's first line and each var, joined by `·` (`Spike: try GraphQL` for `leftover/spike`); `i` shows `DESCRIPTION` with every non-blank line of the description, then `VARS` with one `key: value` per line. A row with no notes has no such line or fields.
6. On a marked row that also has notes, such as `api › agent/old-session` after `wt config state vars set task=cleanup --branch agent/old-session`, the strip still shows `Agent mark from 3d ago, likely stale.`, above `nothing uncommitted`.
7. For `api › feature/locked`, details read `Locked: agent session` and `Can't be removed: it's locked (agent session); unlock it first`.

## Traps

- The strip shows `checking files…` for a moment after focus moves; wait for `nothing uncommitted` or `ignored` before reading it.
- `SIZE` reads `… · measuring…` only while the row's `du` runs; a worktree whose `du` failed (folder gone, unreadable subfolder) reads `SIZE          not measured` (#24).
- `COMMITS` counts `behind` against main as it stands, and the seed's later builders move main, so match the ahead count and lines, not the behind number.
- Long paths are cut in the middle with `…` in the strip; read the full path from `i`, which wraps it.

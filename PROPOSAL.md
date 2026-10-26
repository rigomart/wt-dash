# wt-dash: proposal

A local terminal dashboard that shows every git worktree on this machine in one interactive table, says which ones are safe to delete, and deletes them in bulk. It is a thin layer over [Worktrunk](https://worktrunk.dev) (`wt`), not a replacement for it.

## Why

Worktrees get created by Claude Code, Codex and t3 lines, each in its own place. There is no single view of them, and they are heavy because each one carries its own `node_modules`.

What this looks like in practice:

- A machine can easily accumulate dozens of worktrees across the repos under `~/projects`, many GB by `du`, nearly all of it `node_modules`.
- Locations: `<repo>/.claude/worktrees/*` (Claude Code), `~/.codex/worktrees/*/<repo>` (Codex), `~/.t3-lines/lines/worktrees/*` (t3).
- In an active repo, most worktrees often belong to PRs that are already merged.

`wt list` answers "what's the state of this repo's worktrees" well, but it works on one repo at a time, shows no sizes, and has no cross-repo bulk selection. `wt switch` has an interactive picker for one repo; the gap is an interactive view across repos with sizes and cleanup guidance.

## Non-goals

- Creating or switching worktrees. `wt switch` does that.
- Replacing `wt`. Every status fact that `wt` computes comes from `wt`; every deletion goes through `wt remove`.
- Platforms other than macOS.

## Environment

- macOS (Apple Silicon or Intel) and Git.
- `wt` v0.80.0 or newer, e.g. via Homebrew tap `max-sixty/worktrunk/wt`. Worktrunk's shell integration wraps `wt` in a shell function; the dashboard must call the binary directly (`command wt` / absolute path `/opt/homebrew/bin/wt`), never the shell function.
- `gh`, authenticated, for repos hosted on GitHub.
- Bun as the JS runtime.
- Optionally, the Worktrunk Claude Code plugin. Its hooks set branch markers: `🤖` on prompt submit, `💬` on notification, cleared on session end.

## Architecture

```
Bun CLI
 ├─ core (no UI dependency)
 │   ├─ discover repos       find ~/projects -maxdepth 3 -name .git -type d
 │   ├─ per repo, in parallel (concurrency ~4):
 │   │    wt -C <repo> list --format=json [--full]   → status, lock, markers, open PR, CI
 │   │    gh pr list -R <owner/name> --state all ...   → merged / closed PRs by branch
 │   ├─ per worktree, background queue:
 │   │    du -sk <path>                              → size (cached)
 │   │    ps -p <pid> -o lstart=                     → is the locking session alive?
 │   └─ remove: wt -C <repo> remove -y --format=json [--reap] [-D] [-f] <branch…>
 └─ terminal UI consumes core snapshots and updates
```

Keep discovery, verdicts, and later removal behind a UI-independent core interface so a browser or native UI can be added without rewriting those rules. Run the terminal UI with `bun run start`.

## Data sources

### 1. `wt list` (source of truth for status)

`wt -C <repo> list --format=json` returns schema 2: `{schema, repo, collected, items[]}`. JSON Schema: <https://worktrunk.dev/schema/list-v2.json>. Full field docs: `wt list --help`.

- Assert `schema == 2`. If not, show a banner ("wt JSON schema changed") and stop rather than misreport. Worktrunk is pre-1.0 and changed this format between 0.12 and 0.80.
- Keep only items that have a `worktree` object and `worktree.main == false`.
- Fields used:
  - `branch` (null for detached HEAD; Codex creates some of these), `head.short_sha`, `head.subject`, `head.committed_at`
  - `worktree.path`, `worktree.locked.reason`, `worktree.prunable.reason`, `worktree.detached`, `worktree.operation`
  - `worktree.changes.{staged,modified,untracked,renamed,deleted,conflicted}`
  - `default_branch.{ahead,behind}`, `display.state` (`empty`, `integrated`, `would_conflict`, `ahead`, `behind`, `diverged`, `same_commit`, `orphan`), `default_branch.integration.reason`
  - `upstream.{ahead,behind}` (absent = never pushed)
  - `marker` (`🤖` / `💬`)
  - With `--full`: `pr` (open PR only) and `checks`. `--full` hits the network. Load the table without it first, then fill these in.
- `repo.forge.{owner,name}` gives the GitHub repo for the `gh` call.

### 2. `gh pr list` (merged/closed PRs)

`wt` only reports open PRs. Worktrunk's integration check does catch most squash merges now (`patch_id_match`, `merge_adds_nothing`), but not all: a branch like `feature/login` can be merged as PR #12 and still show `would_conflict`. One call per repo:

```
gh pr list -R <owner>/<name> --state all --limit 300 \
  --json number,state,headRefName,mergedAt,closedAt,url
```

Join on `headRefName == branch`. If several PRs share a branch name, take the most recent. Cache per repo for ~5 minutes.

### 3. Size

`du -sk <worktree path>`, run in a background queue (concurrency 2–3; `node_modules` trees are slow). Cache in `~/.cache/wt-dash/sizes.json` keyed by path, with a timestamp. Show a spinner until known, and allow per-row and global refresh.

Sizes are **estimates**: Bun and pnpm install packages as APFS clones, so `du` counts shared blocks once per worktree. Label the total "up to X GB". After a deletion batch, report the actual change in free space from `df -k /System/Volumes/Data` measured before and after.

### 4. Is the agent still there?

Two signals, in order of trust:

1. **Lock + live PID.** Claude Code locks its worktrees with a reason like `claude session login (pid 98703 start Sat Sep 26 21:37:34 2026)`. Parse the pid and start time and check `ps -p <pid> -o lstart=`. A match means a live session; a missing process or different start time means a stale lock.
2. **Marker.** `🤖` = working, `💬` = waiting on the user. It's cleared only on a clean session end, so a crash leaves it stale. Show it, but don't treat it as proof the session is alive.

## Row model and verdict

Each row is one worktree with: repo, branch, path (shortened with `~`), which tool created it (from the path: `.claude/worktrees` → Claude, `~/.codex` → Codex, `~/.t3-lines` → t3, else other), age (from `head.committed_at`), size, local changes, unpushed commits, relation to main, PR (#, state, link), agent status, and a **verdict**.

Verdict, first match wins:

| Verdict | Rule |
|---|---|
| **Busy** | locked and the locking PID is alive, **or** `worktree.operation` is set, **or** `changes.conflicted` |
| **Broken** | `worktree.prunable` present (folder or `.git` gone) |
| **Safe** | clean working tree **and** (`display.state` ∈ {`empty`, `integrated`} **or** PR state is `MERGED`) **and** no unpushed commits beyond what's merged |
| **Probably safe** | PR `CLOSED` (not merged) and clean, **or** a stale lock that is otherwise Safe |
| **Review** | anything with uncommitted changes, unpushed commits, or no PR and not integrated |

Show the reason for the focused row's verdict in the detail panel (e.g. "PR #12 merged 5d ago", "integrated: patch_id_match", "3 untracked files", "session pid 98703 alive").

## UI

One terminal screen, one table, dense and keyboard-friendly. Show a short key guide in the footer and a detail panel for the focused row.

- **Header:** worktree count, total size ("up to X GB"), how much the Safe rows add up to, last refresh time, and refresh key.
- **Filters:** verdict, repo, tool, and text search on branch/path through keyboard controls.
- **Sorting:** size (default, descending), age, repo, verdict.
- **Grouping toggle:** by repo, or flat.
- **Row:** selection mark, verdict, repo, branch, tool, age, size, changes (`+!?` style), main ↑↓, PR state, and agent status (🤖/💬/live/stale). The detail panel shows the full path, reason, and available actions: copy path or `cd` command, open in Finder or editor, and open the PR in a browser.
- **Bulk bar:** "Select all Safe", then "Remove selected (N, up to X GB)".
- Use the terminal's color theme. No horizontal scroll at laptop widths; hide low-value columns first.

## Removal

1. The user selects rows and presses Remove. A confirmation panel lists every row, grouped:
   - Safe rows: listed plainly.
   - Anything with uncommitted changes, untracked files, or unpushed commits: listed separately, unchecked by default, and naming what will be lost. For untracked/ignored files, show the output of `git -C <path> status --porcelain --ignored`, trimmed and excluding `node_modules`, so things like `.env` and `.dev.vars` are visible.
   - Busy rows can't be selected at all.
2. On confirm, run per repo, in one call:
   `wt -C <repo> remove -y --reap --foreground --format=json <branch…>`
   - Add `-D` only for branches whose PR is merged or that the user explicitly confirmed. Without it, `wt` keeps unmerged branches (`branch_outcome: "retained_unmerged"`).
   - Add `-f` only for rows the user explicitly confirmed despite local changes.
   - Detached-HEAD worktrees have no branch name. Pass the worktree path instead if `wt remove` accepts it; otherwise fall back to `git -C <repo> worktree remove <path>` for those rows only.
   - `--foreground` so the result reports the real `branch_outcome` instead of `deferred`.
3. Stream progress per row: removing, then removed or failed. Show `branch_outcome` in plain words.
4. Afterwards: `git -C <repo> worktree prune`, re-scan the affected repos, and show "Freed X GB" from the `df` difference.
5. Append every removal to `~/.cache/wt-dash/removals.log` (timestamp, repo, branch, path, flags, outcome).

"Broken" rows get a single **Prune** action (`git -C <repo> worktree prune`).

## Safety requirements

- Do not open a network listener. Only local terminal input can request actions.
- Never delete anything except through `wt remove` / `git worktree remove` / `git worktree prune`. No `rm -rf` on paths.
- Never pass `-f` or `-D` without the per-row confirmation described above.
- Never remove a main worktree or a Busy row, even if the UI asks. Enforce this in the core action service, not just in the UI.
- Pass paths and branch names as separate command arguments (`Bun.spawn([...])`), never through a shell string.

## Milestones

1. **Read-only terminal table.** Discovery, `wt list`, sizes, verdicts, filters, sorting. Use it for a day before building deletion.
2. **Merged PRs and live sessions.** The `gh` join, `--full` data, lock PID check.
3. **Removal.** Confirmation panel, `wt remove`, progress, log, freed-space report, prune.
4. *(Optional)* A `bin/wt-dash` launcher that starts the terminal UI.

## Acceptance checks (against a real machine)

Numbers below will have drifted by the time you run this; confirm them with `git worktree list` and `gh pr list` first, and check that the dashboard matches.

- All worktrees under `~/.codex/worktrees` appear, attributed to their parent repos.
- A detached-HEAD Codex worktree appears and doesn't crash anything.
- Worktrees for merged PRs show as Safe. A squash-merged branch that `wt` still reports as `would_conflict` is Safe via the `gh` join.
- A Claude Code worktree such as `my-app/.claude/worktrees/login` shows as Busy while its locking Claude session PID is alive, and as a stale lock once it isn't.
- Worktrees with local changes are never pre-selected, and removing one requires the extra confirmation.
- The table shows its first rows within ~2 s; sizes and PR data fill in afterwards.
- The first milestone has no removal action; later removal is available only after the confirmation flow is built.
- Removing a Safe worktree: the folder is gone, the branch is deleted, the row disappears after re-scan, and the log file has an entry.

## Open questions

- Scan roots: is `~/projects` (depth 3) enough, or are there repos elsewhere?
- Editor for "Open in editor" (VS Code `code`, Cursor `cursor`, or `$EDITOR`)?

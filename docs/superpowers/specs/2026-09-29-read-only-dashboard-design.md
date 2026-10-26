# Read-only worktree dashboard design

## Purpose and scope

Build the first wave of [PROPOSAL.md](../../../PROPOSAL.md): a local terminal dashboard for occasional cleanup. A user should be able to find large, old, and questionable Git worktrees across repositories without running commands in each one. This wave shows facts and conservative verdicts; removal is a later wave.

Run the interface with `bun run start` in a terminal. The scanner and verdict rules must have no terminal or OpenTUI dependency. A later browser or native interface can consume the same service without duplicating repository discovery, Worktrunk parsing, size checks, or verdict logic.

## Architecture and data flow

The core exposes a typed dashboard service with `getSnapshot()`, `subscribe(listener)`, `refresh()`, `refreshSize(worktreeId)`, and `close()`. A snapshot contains normalized worktree rows, scan progress, per-repository errors, size timestamps, and a generation number. Subscribers receive a current snapshot immediately and updated snapshots as work finishes. Refresh increments the generation, so late results from an older scan cannot replace newer data. Filtering, grouping, and sorting operate on normalized rows through pure functions that any UI can reuse.

1. Walk `~/projects` to depth 3 and find directories containing a `.git` directory. Each is a repository to scan. `wt list` on its main checkout discovers associated worktrees even when their paths are under `~/.codex` or `~/.t3-lines`.
2. Run `/opt/homebrew/bin/wt -C <repo> list --format=json` with separate process arguments, up to four repositories at once. Accept only schema 2. Keep rows with a `worktree` object whose `main` value is false. Key each row by repository path and worktree path; a null branch is valid for detached HEAD.
3. Publish repository rows as each scan finishes. A repository failure appears in the snapshot while other repositories continue. An unsupported Worktrunk schema stops the scan with a prominent error instead of presenting partial status as current.
4. Measure each worktree with `du -sk <path>` in a background queue of at most two processes. Store size and measurement time in `~/.cache/wt-dash/sizes.json`. Cached values appear immediately with their age; new measurements replace them as they finish. Per-row size refresh remeasures one path.

The terminal adapter uses [OpenTUI Core](https://opentui.com/docs/getting-started/quickstart/) for rendering and keyboard input. It owns the terminal session, subscribes to the core service, and contains no Git or verdict rules. It restores the terminal when the user quits or the process receives an interrupt. The core can be exercised without a terminal.

## Row model and verdict

Each row contains repository, branch or detached commit, full path, tool inferred from path, HEAD commit time, approximate size, local changes, upstream commits, relation to the default branch, Worktrunk marker, and a verdict with a plain-language reason. The UI shortens values only for display; the core preserves full values. Unknown values stay visibly unknown.

The first wave uses only local Worktrunk facts for verdicts. Rules run in this order:

1. **Busy:** an operation is in progress or files have merge conflicts.
2. **Broken:** Worktrunk reports a prunable worktree.
3. **Review:** a lock, `🤖` or `💬` marker, local changes, commits ahead of the upstream, or missing status prevents a confident verdict. A lock or marker is not proof of a live process; the reason says session status has not been checked yet.
4. **Safe:** the worktree is clean and Worktrunk reports `empty` or `integrated` relative to the default branch.
5. **Review:** every remaining row.

The **Probably safe** category is reserved for the later PR and live-session wave. Merged PRs and live session checks will be added then, so a worktree whose safety depends on a merged PR remains **Review** for now. A Safe label in this wave is a local assessment, not an automated deletion decision.

Sizes are estimates. The total and Safe subtotal are labeled “up to” because APFS clones can make `du` overstate recoverable space.

## Terminal interaction

The screen shows counts, total estimated size, Safe subtotal, scan progress, last refresh time, and errors above a scrollable table. The table defaults to largest first and shows verdict, repository, branch, tool, age, size, changes, and relation to the default branch. A focused-row panel shows the full path, marker, and verdict reason. Narrow terminals hide lower-priority columns while keeping the focused row readable.

The footer shows available keys. Arrow keys or `j`/`k` move focus, `/` searches branch and path, `f` opens verdict/repository/tool filters, `s` changes sort order, `g` toggles repository grouping, `r` refreshes, `R` remeasures the focused row, and `q` quits. Search and filter state stay in the terminal adapter; all choices apply to the latest core snapshot. Loading, empty, narrow-terminal, and error states are explicit. There are no removal keys or commands in this wave.

## Local boundaries

The application opens no network listener. The core starts only known read-only commands (`wt list` and `du`) and passes every argument separately without a shell. Command errors become visible status, not an empty or Safe row. Tests inject a command runner so they never invoke removal commands or modify real worktrees.

## Verification

Unit tests cover schema rejection, detached worktrees, missing fields, verdict precedence, stale scan updates, tool attribution, and filtering/sorting. Tests use small Worktrunk JSON fixtures and temporary directories. A manual acceptance check starts the TUI, verifies first rows within about two seconds, and compares listed paths against `wt list` for local repositories. It checks Codex paths, terminal resize, filters, refresh, and terminal restoration on quit. No acceptance check removes or prunes a worktree.

## Later waves

The next wave adds merged and closed PR data, Worktrunk's `--full` details, and a live-process check for locks to the core. The removal wave adds a separately reviewed action service and confirmation flow. A browser or native UI can then subscribe to the same core service or a thin transport adapter; the verdict and removal rules stay in the core.

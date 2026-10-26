# wt-dash

A macOS terminal dashboard for reviewing and cleaning up Git worktrees across repositories. See disk usage, find work already merged, and remove worktrees after a confirmation. Works with worktrees created by Worktrunk, Codex, Claude, and other tools.

## Install and run

Supports macOS 13 (Ventura) or newer on Apple Silicon and Intel Macs. Requires Git and [Worktrunk](https://worktrunk.dev/) 0.80.0 or newer. The first release is being prepared; see [release instructions](docs/RELEASING.md) for GitHub downloads and Homebrew packaging.

To build and install from this source checkout, use [Bun](https://bun.com/) 1.3.14 (the runtime pinned for release builds):

```sh
brew install worktrunk
bun install --frozen-lockfile
bun run build
bun run install:local
export PATH="$HOME/.local/bin:$PATH"
wt-dash --doctor ~/projects
wt-dash ~/projects
```

The installed executable includes Bun and the terminal UI, so it runs independently of the source checkout. Worktrunk is found on PATH, with standard Apple Silicon and Intel Homebrew locations as fallbacks. Its shell integration is not needed by the dashboard. Git must be on PATH; `xcode-select --install` installs Apple's command line tools if needed.

By default, the dashboard scans `~/projects`. Supply one or more repository or parent folders to scan elsewhere:

```sh
wt-dash ~/code ~/work
wt-dash . --depth 0
wt-dash --wt-path /custom/bin/wt ~/code
wt-dash --help
```

The default search depth is two folder levels below each supplied root. Discovery looks for `.git` directories, skips symlinked subfolders, inaccessible subfolders, installed dependencies, and common build output. Supply the main repository folder rather than a linked worktree or bare repository. Worktrunk supplies all worktrees linked to each discovered repository, including worktrees stored outside the scan folders under Codex, Claude, and t3 directories. The dashboard opens no network listener.

`--doctor` checks platform support, scan-folder access, Git, and the Worktrunk version without opening the UI. Help and version output work even when those dependencies are missing. Running the dashboard itself requires an interactive terminal.

## Keys

| Key | Action |
|---|---|
| ↑/↓ or j/k, PgUp/PgDn, g/G | Move, page, jump to the first or last worktree |
| 1–5, ←/→ | Switch the verdict tab: All, Safe, Review, Busy, Broken |
| / | Search repo, branch, tool, and path as you type; ↑/↓ still move, Enter keeps the search, Esc clears it |
| s / S | Cycle size, age, and repo sorting within each section / reverse the order |
| v | Switch sections between verdicts and repos |
| Space | Select or deselect the focused worktree; a blocked row says why |
| a | Select all Safe worktrees in view; press again to clear them |
| Enter (or x) | Remove the selected worktrees, or the focused one when nothing is selected; on a Broken worktree, prune its record. Asks once in a dialog |
| y or Enter / Esc | In the confirm dialog: remove / cancel; `D` also deletes unmerged branches, `e` stops processes inside. Enter is ignored for a moment after the dialog opens, so a double press cannot confirm it |
| i | Show the focused worktree's full details in place of the list; ↑/↓ scroll, `i` or Esc returns |
| Esc | Undo one step: cancel a pending check, clear search, collapse details, clear selection, reset the tab, stop a running removal after the current worktree |
| r / R | Rescan repositories / remeasure the focused worktree |
| ? | Show every key |
| q, Ctrl-C | Quit and restore the terminal |

The list is split into sections, one per verdict: Safe, Review, Busy, and Broken, in that order, each with its count and size. `v` switches to one section per repo; inside a repo, Safe worktrees come first and a dot shows each row's verdict. Each row shows its Git status and, when the terminal is wide enough, the reason behind it. The focused row opens in place to show its path, last commit, changes, upstream, files, and the keys that apply, or why it can't be removed. A locked row preserves Git's full lock reason; `i` shows every detail and scrolls when they do not fit. The line under the tabs is a meter of disk space by verdict. Colors come from the terminal's own palette: green for Safe, yellow for Review, blue for Busy, red for Broken. Messages appear in the footer and fade after a few seconds.

| Verdict | STATUS | Removal |
|---|---|---|
| Safe | `no new commits` / `merged` | Allow with confirmation |
| Review | `uncommitted changes` / `unpushed commits` / `unmerged commits` / `behind main` / `unrelated history` | Allow with confirmation |
| Review | `locked` | Block; show Git's full lock reason |
| Busy | `rebase in progress` / `unresolved conflicts` | Block |
| Broken | `folder missing` | Offer pruning |
| Review | `status unknown` | Block |

Other Git operations, such as cherry-pick, also show an in-progress status and block removal. In-progress operations and unresolved conflicts take priority, followed by missing folders, locks, unknown status, uncommitted changes, unpushed commits, and the relation to the default branch. The STATUS label names the fact; details add the specifics in one sentence, such as the commit count, the comparison base, or a predicted merge conflict. A blocked row says what to do next, for example "finish or abort the rebase first".

**Safe** means the Git data supports cleanup: Worktrunk reports clean content already integrated into, or identical to, the default branch. Status and removal eligibility come from the same assessment. Processes and agent markers are not checked. Locks always block removal, regardless of their age or wording; unlocking is a manual action. PR status is not checked. Details name the comparison base and integration evidence when relevant.

The focused row lists its uncommitted changes and gives a short, dimmed summary of its ignored files. Sizes are estimates. The totals say “up to” because shared disk blocks can make `du` overstate recoverable space. Size measurements and timestamps are cached at `~/.cache/wt-dash/sizes.json`.

Removing takes one question. Enter checks the selection (or the focused row) with Worktrunk and opens a confirm dialog over the list: each worktree and its size, the total, which ones would lose uncommitted or untracked changes, and which ones were skipped because they changed or cannot be removed. Unmerged branches are kept unless you press `D`; the existing `e` option explicitly requests that Worktrunk stop processes inside. Ignored files, such as `.env` copies, local databases, and caches, are removed with the worktree without a separate question, the same way Worktrunk treats them. `y` or Enter starts the removal in the background: the worktrees leave the list at once, a progress line above the footer counts through them, the list stays usable, and a message reports the freed space when the batch ends. You can confirm more removals while one runs; they queue and run in order. Rows that could not be removed come back with a note in their details. Only the affected repositories are rescanned afterward. Locks, Git operations, unresolved conflicts, missing folders, and unknown Git status block removal. Removal uses Worktrunk, checks Git facts and local files again immediately before acting, and records attempts in `~/.cache/wt-dash/removals.log`.

Removal skips Worktrunk hooks. The confirmation covers worktree and branch cleanup; it does not run project-defined cleanup commands. The dashboard explicitly requests Worktrunk JSON version 2 without changing the user's settings.

The scanner, verdicts, and selectors live in `src/core` and have no terminal UI dependency. `src/ui/terminal.ts` subscribes to that service, so another interface can use the same data and rules.

## Verify

```sh
bun test
bun run typecheck
bun run build
python3 scripts/smoke-test.py dist/wt-dash
```

For development, run `bun run start -- ~/code`. GitHub Actions runs the tests and standalone terminal check on Apple Silicon and Intel Macs. See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance. Licensed under [MIT](LICENSE); compiled releases include third-party notices.

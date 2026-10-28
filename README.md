# wt-dash

See every Git worktree on your Mac or Linux machine in one terminal dashboard, find the ones you can safely delete, and remove them in bulk.

Coding agents create worktrees constantly. Claude Code keeps them in `.claude/worktrees`, Codex in `~/.codex/worktrees`, and other tools elsewhere. Each one carries its own `node_modules`, and nothing cleans them up. A few weeks of agent work can leave dozens of worktrees and many gigabytes behind.

wt-dash scans your repositories, lists every linked worktree with its size and Git state, and sorts them by how safe they are to delete. Select what you want gone, confirm once, and the removal runs in the background while you keep working.

It is built on [Worktrunk](https://worktrunk.dev/): Worktrunk computes the Git facts and performs every removal.

## Install

```sh
brew install rigomart/tap/wt-dash
```

This installs Worktrunk too. wt-dash needs Git and Worktrunk 0.80.0 or newer, and runs on:

- macOS 13 (Ventura) or newer, on Apple Silicon and Intel Macs
- Linux with glibc, on arm64 and x64. Alpine and other musl-based distributions are not supported.

Where Homebrew has no prebuilt Worktrunk, including all Intel Macs and Linux, Homebrew compiles it from source. That takes a few minutes. Run `ldd --version` to check a Linux system: glibc reports "GNU libc" on its first line.

Archives for direct download are attached to each [GitHub release](https://github.com/rigomart/wt-dash/releases). Each holds the `wt-dash` executable; put it in a folder on your PATH. The macOS binary is not signed or notarized, so macOS blocks a copy downloaded with a browser until you allow it under System Settings → Privacy & Security. Homebrew installs avoid this.

### Linux without Homebrew

1. Install Worktrunk with `cargo install worktrunk`, with `sudo pacman -S worktrunk` on Arch Linux, or from a [Worktrunk release](https://github.com/max-sixty/worktrunk/releases).
2. Download the archive for your processor from the [latest release](https://github.com/rigomart/wt-dash/releases/latest): `linux-x64` if `uname -m` prints `x86_64`, `linux-arm64` if it prints `aarch64`.
3. Extract it and put `wt-dash` on your PATH, then check the setup:

```sh
tar -xzf wt-dash-v*-linux-x64.tar.gz
mkdir -p ~/.local/bin
mv wt-dash ~/.local/bin/
wt-dash --doctor ~/projects
```

If your shell cannot find `wt-dash`, add `~/.local/bin` to your PATH.

## Usage

```sh
wt-dash                  # scan ~/projects
wt-dash ~/code ~/work    # scan other folders
wt-dash . --depth 0      # just the current repository
wt-dash --doctor         # check Git, Worktrunk, and folder access without opening the UI
```

wt-dash looks for repositories up to two folder levels below each folder you give it (`--depth` changes this). Point it at main repositories or the folders that contain them. Worktrees stored elsewhere still show up, because Worktrunk lists every worktree linked to a repository wherever it lives.

| Option                             | Effect                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| `--depth <n>`                      | Folder levels to search below each root, 0–20 (default 2) |
| `--wt-path <path>`                 | Use a specific Worktrunk executable                       |
| `--doctor`                         | Check the setup and exit                                  |
| `-h`, `--help` / `-v`, `--version` | Show help or the version                                  |

## Verdicts

Every worktree gets one of four verdicts. The list groups them into sections, and each row shows its Git status and the reason behind it.

| Verdict    | Status                                                                                  | Removal                            |
| ---------- | --------------------------------------------------------------------------------------- | ---------------------------------- |
| **Safe**   | no new commits, merged                                                                  | Allowed                            |
| **Review** | uncommitted changes, unpushed commits, unmerged commits, behind main, unrelated history | Allowed after you read the warning |
| **Review** | locked, status unknown                                                                  | Blocked                            |
| **Busy**   | rebase, merge, or cherry-pick in progress; unresolved conflicts                         | Blocked                            |
| **Broken** | folder missing                                                                          | Offers to prune Git's record       |

**Safe** means Worktrunk reports clean content already integrated into, or identical to, the default branch. wt-dash does not check pull request status or running processes. A lock always blocks removal, however old; unlock it yourself with `git worktree unlock` if it is stale.

A blocked row says what to do next, for example "finish or abort the rebase first".

## Keys

wt-dash opens on its projects: each repository with linked worktrees, with how much space its Safe worktrees take, and an "All projects" entry first. Projects with the most worktrees come first. They appear as soon as wt-dash has counted each repository's worktrees, which it reads from Git's records without running Git, and each project's rows fill in as Worktrunk lists them. The first project is listed first, and the project whose worktrees took the most space at the last run goes second; their sizes are also measured ahead of the rest. If the scan finds only one project, wt-dash opens it directly.

On terminals at least 100 columns wide, the projects sit in a sidebar and the worktrees of the focused one fill the rest of the screen, so moving through the projects shows each one's worktrees right away. Press → to move into the list and ← to come back. The focused project's details sit under the projects in the sidebar, and the focused worktree's details in a short strip under the list. On narrower terminals the projects fill a table with a column for each verdict, Enter opens one, and the details of the focused project or worktree stay in a strip under the table or list.

On the projects:

| Key             | Action                                                   |
| --------------- | -------------------------------------------------------- |
| ↑/↓ or j/k      | Move                                                     |
| Enter, → or Tab | Open the focused project, or every project together      |
| /               | Search every project by repo, branch, tool, or path      |
| a               | Select every Safe worktree in the focused project or all |
| x               | Remove the selection                                     |
| Esc             | Clear the selection, then stop a running removal         |

In a worktree list:

| Key        | Action                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| ↑/↓ or j/k | Move                                                                        |
| 1–5        | Show all, Safe, Review, Busy, or Broken                                     |
| ← or Tab   | Back to the projects                                                        |
| [ / ]      | Previous / next project                                                     |
| /          | Search by repo, branch, tool, or path                                       |
| Space      | Select the focused worktree                                                 |
| a          | Select every Safe worktree in view                                          |
| Enter or x | Remove the selection, or the focused worktree                               |
| i          | Show full details for the focused worktree                                  |
| s / S      | Change the sort (size, age, repo) / reverse it                              |
| v          | Group by verdict or by repo (all-projects list)                             |
| R          | Remeasure the focused worktree                                              |
| Esc        | Step back: clear the search, selection, or tab, then return to the projects |

Everywhere, `r` rescans every repository, `?` shows every key, and `q` quits. Selections carry across screens.

## Removing worktrees

Enter opens one confirmation dialog. It lists each worktree and its size, the total, and which ones would lose uncommitted or untracked changes. Press `y` or Enter to go ahead, or Esc to cancel.

- **Branches are kept** unless they are merged. Press `D` in the dialog to delete unmerged branches too.
- **Processes are left alone** unless you press `e`, which asks Worktrunk to stop processes running inside.
- **Ignored files go with the worktree.** That includes `.env` copies, local databases, and caches, the same way Worktrunk treats them.
- **Every removal is checked again** just before it runs: if its Git status, commit, or lock changed since you confirmed, or a rebase or merge is in progress, it is skipped and comes back with a note. Whether its branch is merged is checked again when that repository's removals start, and again for that worktree if its default or upstream branch moved since. Worktrunk makes the final call on deleting the branch.
- **Worktrunk hooks are skipped.** Project-defined cleanup commands do not run.

Removals run in the background, and you can queue more while one is going. Each attempt is logged to `~/.cache/wt-dash/removals.log`.

## Good to know

- Sizes come from `du` and are cached in `~/.cache/wt-dash/sizes.json`. A worktree is measured again only when its saved size is more than a day old, or when files were added or removed at the top level of the worktree or its `node_modules` folder. Press `R` to remeasure the focused worktree now. Totals read "up to" because disk blocks shared between files can make `du` overstate the space you get back.
- wt-dash runs Git and Worktrunk locally. It makes no network requests of its own and never changes your Worktrunk settings.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to build from source, run the tests, or cut a release.

## License

[MIT](LICENSE). Release archives include notices for bundled third-party code.

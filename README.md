# wt-dash

See every Git worktree on your Mac or Linux machine in one terminal dashboard, find the ones you can safely delete, and remove them in bulk.

Coding agents create worktrees constantly. Claude Code keeps them in `.claude/worktrees`, Codex in `~/.codex/worktrees`, Cursor in `~/.cursor/worktrees`, and other tools elsewhere. Each one carries its own `node_modules`, and nothing cleans them up. A few weeks of agent work can leave dozens of worktrees and many gigabytes behind.

wt-dash scans your repositories, lists every linked worktree with its size and Git state, along with local branches left behind without a worktree, and sorts them by how safe they are to delete. Select what you want gone, confirm once, and the removal runs in the background while you keep working.

It is built on [Worktrunk](https://worktrunk.dev/): Worktrunk computes the Git facts and removes every worktree a repository knows. Orphaned folders, which no repository knows, wt-dash deletes itself.

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

Every worktree gets one of five verdicts. The list groups them into sections, and each row shows its Git status and the reason behind it.

| Verdict      | Status                                                                                                                                                       | Removal                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| **Safe**     | no new commits, merged                                                                                                                                       | Allowed                             |
| **Review**   | uncommitted changes, unpushed commits, unmerged commits, behind main, unrelated history; no new commits, under a day old; an agent marked it in the last day | Allowed after you read the warning  |
| **Review**   | locked, status unknown                                                                                                                                       | Blocked                             |
| **Busy**     | rebase, merge, or cherry-pick in progress; unresolved conflicts                                                                                              | Blocked                             |
| **Broken**   | folder missing                                                                                                                                               | Offers to prune Git's record        |
| **Orphaned** | repository gone, unknown to its repo, Git record gone; no worktree inside                                                                                    | Allowed; wt-dash deletes the folder |

**Safe** means Worktrunk reports clean content already integrated into, or identical to, the default branch. A branch with nothing beyond the default branch, either the same commit or one the default branch has since moved past, looks that way the moment its worktree is created. So, like `wt step prune`, wt-dash calls such a worktree Safe only once it is a day old. Until then it is Review, with a reason such as "Created 2h ago, so it may still be in use", and `a` leaves it out. Its age comes from when Git created its folder under `.git/worktrees`; if that can't be read, it stays Review. A branch whose own commits reached the default branch through a squash or rebase merge is Safe at any age. A lock always blocks removal, however old; unlock it yourself with `git worktree unlock` if it is stale.

wt-dash does not check pull request status or running processes. It does read agent marks: Worktrunk's agent plugins, such as the one `wt config plugins claude install` adds, mark a branch 🤖 while an agent works in it and 💬 while it waits for input, and clear the mark when the session ends. A worktree that would be Safe but carries a mark set in the last day is Review instead, with a reason such as "An agent was working here 20m ago", so `a` leaves it out; you can still remove it. A mark whose time can't be read counts as recent. An older mark is probably left over from a session that didn't end cleanly, so it only shows in the details, as "Agent mark from 28d ago, likely stale". Marks belong to a branch name, so renaming a branch drops its mark.

### Orphaned folders

Git and Worktrunk find a worktree only through its repository, so a worktree folder whose link to its repository broke is invisible to both. wt-dash looks for these in the folders coding agents keep worktrees in: `.claude/worktrees` inside each scanned repository, `~/.codex/worktrees`, and t3's `~/.t3/worktrees` and `~/.t3-lines/lines/worktrees`. It lists them under an "Orphaned folders" entry, last on the projects screen and in "All projects", with their size and why no repository knows them:

- The repository was deleted or moved: "Its repository at ~/old/app no longer exists."
- The repository is still there but no longer records the worktree, for example after a re-clone or a prune: "Its repository at ~/code/app no longer lists it."
- A Codex folder (`~/.codex/worktrees/<id>`) holding only its `.codex-worktree-name` file, left behind when its worktree was removed.

A worktree whose link to its repository still works is never listed, wherever that repository lives. Moving a repository breaks that link but keeps its record of the worktree: if the repository is in a scan folder, its worktrees are not listed, and `git worktree repair` run in it fixes them; if it lives elsewhere, wt-dash can't see the record and lists them as orphaned. When a scanned repository's records can't be read, the folders they might hold are left out rather than offered for deletion. Rows are named by their folder and the one above it, such as `abcd/app` for `~/.codex/worktrees/abcd/app`. `a` selects Safe rows only, so it leaves orphaned folders out.

### Branches without a worktree

Removing a worktree often leaves its branch behind. wt-dash lists these local branches too, other than the default branch. Their size column reads "branch", since there is no folder to measure, and they get the same verdicts:

- A branch merged into the default branch, by any route, is Safe once it is a day old, like `wt step prune`. Its age comes from its oldest reflog entry, or else from when Git last wrote it. If neither can be read, or it is younger, it is Review.
- A branch with unmerged commits or unrelated history is Review, and is only deleted if you press `D` in the confirmation dialog.
- A recent agent mark makes it Review, as for a worktree.

A blocked row says what to do next, for example "finish or abort the rebase first".

### Which tool made a worktree

wt-dash names the tool that made each worktree from the folder it sits in, with the default folders below. The tool shows in the details and the strip, the projects count worktrees by tool, and `/` finds a tool's worktrees by its name. Anything else, including a tool's worktrees moved to a folder of your choosing, reads "other".

| Tool         | Default folder                                                               |
| ------------ | ---------------------------------------------------------------------------- |
| Claude Code  | `<repo>/.claude/worktrees/<name>`                                            |
| Codex        | `~/.codex/worktrees/<id>/<repo>`                                             |
| t3           | `~/.t3/worktrees/<repo>/<branch>`, and the older `.t3-lines/lines/worktrees` |
| Cursor       | `~/.cursor/worktrees/…`                                                      |
| Conductor    | `~/conductor/workspaces/<repo>/<name>`                                       |
| Windsurf     | `~/.windsurf/worktrees/<repo>/<name>`                                        |
| Gemini CLI   | `<repo>/.gemini/worktrees/<name>`                                            |
| Claude Squad | `~/.claude-squad/worktrees/<name>`                                           |
| Superset     | `~/.superset/worktrees/…`                                                    |
| Worktrunk    | `<repo>.<branch>` beside the repository, Worktrunk's default `worktree-path` |

## Keys

wt-dash opens on its projects: each repository with linked worktrees, with how much space its Safe worktrees take, and an "All projects" entry first. Projects with the most worktrees come first. They appear as soon as wt-dash has counted each repository's worktrees, which it reads from Git's records without running Git, and each project's rows fill in as Worktrunk lists them: its worktrees first, then its branches without a worktree once every project's worktrees are in, since those branches can take most of a listing when Worktrunk's cache is cold. The first project is listed first, on its own, and the project whose worktrees took the most space at the last run goes second; their sizes are also measured ahead of the rest. If the scan finds only one project, wt-dash opens it directly.

On terminals at least 100 columns wide, the projects sit in a sidebar and the worktrees of the focused one fill the rest of the screen, so moving through the projects shows each one's worktrees right away. Press → to move into the list and ← to come back. The focused project's details sit under the projects in the sidebar, and the focused worktree's details in a short strip under the list. On narrower terminals the projects fill a table with a column for each verdict, Enter opens one, and the details of the focused project or worktree stay in a strip under the table or list. A worktree's strip says what it holds, such as `3 commits ahead of main · +16 · “Document the per-IP rate limits”`: its commits beyond the default branch, the lines they add and remove, and the latest one's subject. `i` adds how far the default branch has moved on since. Notes left on a branch show under that line and in `i`: its Git description (`git branch --edit-description`) and any Worktrunk vars (`wt config state vars set ticket=API-142`), which a Worktrunk hook or an agent can set when it creates the worktree.

On the projects:

| Key             | Action                                              |
| --------------- | --------------------------------------------------- |
| ↑/↓ or j/k      | Move                                                |
| Enter, → or Tab | Open the focused project, or every project together |
| /               | Search every project by repo, branch, tool, or path |
| a               | Select every Safe row in the focused project or all |
| x               | Remove the selection                                |
| Esc             | Clear the selection, then stop a running removal    |

In a worktree list:

| Key        | Action                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| ↑/↓ or j/k | Move                                                                        |
| 1–6        | Show all, Safe, Review, Busy, Broken, or Orphaned                           |
| ← or Tab   | Back to the projects                                                        |
| [ / ]      | Previous / next project                                                     |
| /          | Search by repo, branch, tool, or path                                       |
| Space      | Select the focused worktree                                                 |
| a          | Select every Safe row in view                                               |
| Enter or x | Remove the selection, or the focused worktree                               |
| i          | Show full details for the focused worktree                                  |
| s / S      | Change the sort (size, age, repo) / reverse it                              |
| v          | Group by verdict or by repo (all-projects list)                             |
| R          | Remeasure the focused worktree                                              |
| Esc        | Step back: clear the search, selection, or tab, then return to the projects |

Everywhere, `r` rescans every repository, `?` shows every key, and `q` quits. Selections carry across screens.

## Removing worktrees

Enter opens one confirmation dialog. It lists each worktree and its size, the total, and which ones would lose uncommitted or untracked changes. Press `y` or Enter to go ahead, or Esc to cancel.

- **Branches are kept** unless they are merged. Press `D` in the dialog to delete unmerged branches too. An unmerged branch without a worktree is skipped unless you press `D`, since deleting it is all its removal does.
- **Processes running inside are stopped**, such as dev servers, watchers, and language servers, so they don't hold the folder open. Worktrunk leaves interactive shells and terminal editors alone. Press `e` in the dialog to leave every process running.
- **Ignored files go with the worktree.** That includes `.env` copies, local databases, and caches, the same way Worktrunk treats them.
- **Every removal is checked again** just before it runs: if its Git status, commit, or lock changed since you confirmed, it was created again at the same path, a rebase or merge is in progress, or an agent marked it since the preview, it is skipped and comes back with a note. A branch without a worktree is skipped if it moved, was deleted, or now has a worktree, or if a worktree folder has the same name as the branch, because Worktrunk would remove that worktree instead. Whether its branch is merged is checked again when that repository's removals start, and again for that worktree if its default or upstream branch moved since. Worktrunk makes the final call on deleting the branch.
- **Worktrunk hooks are skipped.** Project-defined cleanup commands do not run.
- **Orphaned folders are deleted by wt-dash**, because Worktrunk can't remove a folder no repository knows. Just before, it checks that the folder is still the one you confirmed and is still orphaned for the same reason, and skips it otherwise. The dialog does not check the files inside an orphaned folder; they go with it. Processes running inside are not stopped. Deleting a Codex worktree also deletes its `<id>` folder when nothing but the name file is left.

Removals run in the background, and you can queue more while one is going. Each attempt is logged to `~/.cache/wt-dash/removals.log`.

## Good to know

- Sizes come from `du` and are cached in `~/.cache/wt-dash/sizes.json`. A worktree is measured again only when its saved size is more than a day old, or when files were added or removed at the top level of the worktree or its `node_modules` folder. Press `R` to remeasure the focused worktree now. Totals read "up to" because disk blocks shared between files can make `du` overstate the space you get back.
- wt-dash runs Git and Worktrunk locally. It makes no network requests of its own and never changes your Worktrunk settings.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to build from source, run the tests, or cut a release.

## License

[MIT](LICENSE). Release archives include notices for bundled third-party code.

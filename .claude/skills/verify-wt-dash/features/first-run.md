# First run without folders

`wt-dash` with no folder scans `~/projects`, `~/code`, `~/dev`, `~/src` and `~/work` where they exist, and follows the worktrees in the agents' folders in the home folder (`~/.codex/worktrees`, `~/.t3/worktrees` and the others in `AGENT_FOLDERS`, `src/core/worktrunk/list.ts`) back to their repositories, wherever those live. A missing default folder is skipped; a missing folder given on the command line is still an error. A scan that finds nothing names the folders it scanned, and `--doctor` counts the repositories each one finds.

## Entry points and variants

- `bun src/index.ts` with no folder, and `bun src/index.ts --doctor`, run with `HOME` set to a sandbox home. The stack always passes the scan root, so start this run yourself in the instance's tmux server, replacing the `app` session: `t kill-session -t app; t new-session -d -s app -x 120 -y 32 -c "$HOME" -e HOME="$HOME" "$(command -v bun) $PWD/src/index.ts"; t resize-window -t app -x 120 -y 32`.
- Wide (120x32) and narrow (80x24, `t resize-window -t app -x 80 -y 24`).

## Preconditions

- A fresh instance (`up`). Its `HOME` (`env` → `paths.home`) has no `projects` folder; the seed lives outside it, so the seeded repos are not found here.
- In the same shell call as the `eval` of `env` → `exports`, with Git as the instance's user: a repo at `$HOME/code/app` with a worktree on branch `codex-abcd` at `$HOME/.codex/worktrees/abcd/app`, and a repo at `$HOME/elsewhere/lib`, outside every scan folder, with a worktree on `codex-efgh` at `$HOME/.codex/worktrees/efgh/lib`. Give each repo one commit first (`git init -q`, add a file, commit).
- For checks 4–6, an empty folder `$HOME/empty`, a second home `$HOME/../home2` holding only empty `code` and `.codex/worktrees` folders, and a third, empty one, `$HOME/../home3`. Start the app with `-e HOME=<that home>`.

## Checks

1. `--doctor` exits 0 and prints `Scan folders:` / `  <home>/code  1 repository` / `Agent worktree folders:` / `  <home>/.codex/worktrees  2 repositories` / `Repositories found: 2` / `Search depth: 2` / `Setup checks passed.`
2. The app opens on the projects, not an error: wide, line 1 reads `wt-dash › app` with `1 worktree · up to 8 KB`; the sidebar lists `All projects 2`, `▌ app 1`, `lib 1`; the list shows `□ codex-abcd` in REVIEW (`no new commits`); the details read `~/code/app` and `Codex 1`. Focusing `lib` shows `~/elsewhere/lib` and `□ codex-efgh`; "All projects" shows both rows.
3. Narrow: the table lists `All projects 2`, `app 1`, `lib 1`, each with `REV 1`.
4. `bun src/index.ts $HOME/empty`: the projects read `No worktrees found in ~/empty.` then `Scan other folders with: wt-dash <folder>`, wide and narrow.
5. No folder, `HOME=home2`: `No worktrees found in ~/code and ~/.codex/worktrees.`; `--doctor` lists both folders with `0 repositories` and `Repositories found: 0`.
6. No folder, `HOME=home3`: `No worktrees found, and no folder to scan exists.`; `--doctor` prints `Scan folders: none of ~/projects, ~/code, ~/dev, ~/src, ~/work exists` and `Agent worktree folders: none of the known ones exists`, and exits 0. `--doctor $HOME/projects` (given, missing) still fails with `Scan folder not found: …` and exit 1. Other setups (no Worktrunk, no Git, small terminals, a light theme) are in [setups.md](setups.md).

## Traps

- Never run it without `HOME` pointing into the sandbox: the default sources are under the home folder, so it would scan the developer's own repositories.
- The worktrees read `Created Nm ago, so it may still be in use`; match the stable part.
- After `new-session` and `resize-window`, wait about a second before an `image`: an earlier capture can hold two frames side by side. `image` can also render a stale page when reusing an `--out` name; use a new name. If `image` fails with a socket path that is too long, set `AGENT_BROWSER_SOCKET_DIR=/tmp/ab`.
- `stack.ts doctor` reports the replaced `app` session as unhealthy; `down --purge` cleans it up as usual.

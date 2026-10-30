# Remembered repositories

Every repository a run finds, from any source (the default scan folders, the agents' worktree folders, or folders given on the command line), is saved to `$XDG_STATE_HOME/wt-dash/repos.json`, or `~/.local/state/wt-dash/repos.json` when `XDG_STATE_HOME` is unset. A run without folders lists the saved repositories as well as what its own scan finds. A run with folders shows only those folders and only adds to the file. A saved repository whose folder is gone or no longer holds a `.git` folder is dropped at the next scan; one that can't be read (permission denied) stays in the file but is not listed until it can be. A missing, unreadable or corrupt file reads as empty and is rewritten. `--doctor` without folders reports the file and its count as `Saved repositories:`.

## Entry points and variants

- `up`'s own run (`bun src/index.ts <scan root>`, a run with a folder), and runs you start yourself in the instance's tmux server, replacing the `app` session, from the instance's `HOME` with its `XDG_STATE_HOME`: `t kill-session -t app; t new-session -d -s app -x 120 -y 32 -c "$HOME" -e HOME="$HOME" -e XDG_STATE_HOME="$XDG_STATE_HOME" "$(command -v bun) $PWD/src/index.ts [folder]"; t resize-window -t app -x 120 -y 32`.
- `bun src/index.ts --doctor`, with and without a folder, run from `$HOME` after the `eval` of `env` → `exports`.
- Wide (120x32) and narrow (80x24).

## Preconditions

- A fresh instance (`up`). Its `HOME` has no default scan folder and no agent folder, so a run without folders finds only saved repositories.
- For check 4, with Git as the instance's user: a repo at `$HOME/elsewhere/lib` with one commit and a worktree on `feature/lib` at `$HOME/elsewhere/lib.feature-lib`.
- For check 7, a home with nothing in it, `$HOME/../home3`, started with `-e HOME=<home3> -e XDG_STATE_HOME=<home3>/.local/state`.

## Checks

1. After `up`, `$XDG_STATE_HOME/wt-dash/repos.json` is `{"repos": [...]}` listing the scan root's `api`, `docs`, `tools` and `web`, sorted, as real paths. The app shows only the scan root's projects, as before.
2. A run without folders: wide, the sidebar lists `All projects 16`, `▌ api 7`, `web 6`, `docs 3`; narrow, the table lists the same rows and `1 project with no worktrees`.
3. `--doctor` without folders prints `Scan folders: none of ~/projects, ~/code, ~/dev, ~/src, ~/work exists`, `Agent worktree folders: none of the known ones exists`, then `Saved repositories:` / `  <home>/.local/state/wt-dash/repos.json  4 repositories` / `Repositories found: 4`, and exits 0. `--doctor <scan root>` prints no `Saved repositories` section and `Repositories found: 4` from the folder alone.
4. `bun src/index.ts $HOME/elsewhere` opens on `lib` alone (`wt-dash › lib`, `□ feature/lib`); the file now holds five repos. A run without folders then lists `lib 1` under `docs 3`, with `All projects 17`.
5. Move `$HOME/elsewhere/lib` away and delete the `.git` folder of the scan root's `tools`, then press `r` in a run without folders: `lib` is gone, `All projects 16`, and the file holds only `api`, `docs` and `web`.
6. Write `{oops` to the file and start a run with the folder `<scan root>/web`: it opens `wt-dash › web` with no error, and the file holds only `web`, as valid JSON. `chmod 000` the file and start the same run: the same result, with the file readable again. No `repos.json.tmp-*` file is left in its folder.
7. A run without folders in `home3`: the projects read `No worktrees found, and no folder to scan exists.`, `Scan other folders with: wt-dash <folder>`, `wt-dash remembers the repositories it finds, and lists them in every run without folders.` (wrapped after `every run` in narrow) and `To forget them, delete ~/.local/state/wt-dash/repos.json`. `home3` has no `.local/state/wt-dash` folder afterwards: a run that finds nothing creates no file.

## Traps

- Never start a run without `HOME` and `XDG_STATE_HOME` both pointing into the sandbox: the developer's own `repos.json` would be read and written. The instance env sets `XDG_STATE_HOME` to `<home>/.local/state`; a run with another `HOME` needs its own `XDG_STATE_HOME` too.
- Checks 5 and 6 change the file and the seed; run the other checks first, or start again from `down --purge` and `up`.
- `stack.ts doctor` reports the replaced `app` session as unhealthy; `down --purge` cleans it up as usual.

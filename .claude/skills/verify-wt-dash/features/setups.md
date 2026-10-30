# Setups a first run meets

What a new user sees when their machine differs from the developer's: Worktrunk missing, too old or built another way, Git missing, a folder that can't be scanned, a very small terminal, a light terminal theme. A setup problem stops wt-dash before the dashboard opens with one message on stderr and exit 1, in the UI and in `--doctor` alike; nothing is drawn.

## Entry points and variants

- `bun src/index.ts --doctor` run from your shell, and `bun src/index.ts` in tmux, each with `HOME` and `PATH` set for the setup.
- Run the UI on a tmux server of your own, never by adding a session to the instance's: tmux 3.6a's server crashes on `new-session` there (the stack sets `window-size manual`), which also kills the instance's app. For example `tmux -L wt-dash-setups-<name> new-session -d -s <case> -x 120 -y 32 -c "$H" /usr/bin/env HOME="$H" PATH="$P" /bin/sh -c "$(command -v bun) $PWD/src/index.ts <args>; echo EXIT=\$?; exec /bin/sleep 600"`, then `resize-window` to the size. Pass `PATH` through `env` like this: tmux runs a plain command string with your login shell, which can reset `PATH`.
- Wide (120x32) and narrow (80x24) for each UI check; the startup messages are the same in both, only wrapped.
- `tmux -L <that socket> kill-server` when done; `down --purge` does not know about it.

## Preconditions

- A fresh instance (`up`) for its sandbox, its seed (`env` → `paths.scanRoot`) and its env (`env` → `exports`). Build every setup under `env` → `paths.sandbox`, so `down --purge` deletes it:
  - `home-std`: a repo at `code/app` with one commit and a worktree on `codex-abcd` at `.codex/worktrees/abcd/app`, made with Git as the instance's user.
  - Stub folders, each with a `git` symlink to the real Git and a `wt` script that prints one line for `--version` and otherwise runs the real `wt` (`exec /opt/homebrew/bin/wt "$@"`): `wt v0.79.2` (old), `wt 0.80.0` (crates.io build), `wt v0.80.0-3-gabc1234` (build past a tag), `wt abc1234` (Nix build), and one whose `wt` writes `dyld: Library not loaded: libgit2.dylib` to stderr and exits 134.
  - A folder with only a `wt` symlink to the real one, for "no Git".
  - `cli/`: a file `afile`, a folder `locked` with mode 000, and symlinks `loop1 → loop2`, `loop2 → loop1`.
- `PATH` for a stub is `<stub folder>:/usr/bin:/bin:/usr/sbin:/sbin`; for "no Git", `<wt-only folder>:/bin:/usr/sbin:/sbin` (`/usr/bin` holds Apple's `git`).

## Checks

1. No `wt` on PATH but Homebrew's at `/opt/homebrew/bin/wt`: `--doctor` exits 0 with `Worktrunk: wt v0.80.0 (/opt/homebrew/bin/wt)`. With that file hidden too (`sandbox-exec -p '(version 1)(allow default)(deny file-read* (literal "/opt/homebrew/bin/wt") (subpath "/opt/homebrew/Cellar/wt"))' …`): `Worktrunk was not found. Install it with: brew install worktrunk, or cargo install worktrunk` / `Or supply its executable with --wt-path /path/to/wt`, exit 1.
2. `--wt-path <missing file>`, and `--wt-path <a folder>`: `Worktrunk was not found at <path>, given with --wt-path.` / `Supply the path of the wt executable, or leave --wt-path out to look for it on PATH.`, exit 1.
3. `wt v0.79.2`: `Worktrunk 0.80.0 or newer is required; found wt v0.79.2 at <stub>/wt.` / `Update it with: brew upgrade worktrunk, or cargo install worktrunk`, exit 1, and the UI prints the same and draws nothing. A pre-release of the minimum, `wt v0.80.0-rc.1`, is rejected the same way.
4. `wt 0.80.0`, `wt v0.80.0-3-gabc1234` and `wt v0.81.0-rc.1`: `--doctor` exits 0 with `Worktrunk: <that line> (<stub>/wt)`, and the UI opens on `wt-dash › app` with `□ codex-abcd` in REVIEW, wide and narrow.
5. `wt abc1234`: `Could not read Worktrunk's version from <stub>/wt --version, which printed: wt abc1234` / `wt-dash needs Worktrunk 0.80.0 or newer. Install a release with: brew install worktrunk, or cargo install worktrunk`, exit 1. The failing `wt`: `Worktrunk could not run: <stub>/wt (dyld: Library not loaded: libgit2.dylib). Check the installation with <stub>/wt --version.`, exit 1.
6. No Git: `Git was not found on PATH. Install Apple's command line tools: xcode-select --install`, exit 1, in `--doctor` and the UI.
7. A folder given that can't be scanned, each with `Supply a folder, for example: wt-dash ~/code` under it and exit 1: `afile` → `Not a folder: <path>`; `locked` → `Scan folder can't be read (permission denied): <path>`; `loop1` → `Scan folder is a symbolic link loop: <path>`; a missing one → `Scan folder not found: <path>`. A folder holding a symlink loop (`cli` itself, `--depth 20`) scans: `--doctor` exits 0 with `Repositories found: 0`.
8. Small terminals, on the seed (`HOME` the instance's, the scan root as argument), started at 120x32 and resized with `resize-window` to 80x24, 60x20, 40x12 and back to 120x32: each size draws one frame with the header on line 1 and the key hints on the last line, no text from an earlier size, and the app keeps running. At 40x12 the projects show `PROJECT  SAFE SIZE`; Enter opens the list with short tabs (`Rev 5  Busy 0  Brk 0`). Resizing through 120x32, 30x8, 80x24, 40x12, 15x5, 100x30 and 60x20 eight times, 50 ms apart, then to 120x32 leaves the same screen as before.
9. `?` at 80x24 shows the keys in two columns with every label whole: `all Safe in view / project`, `remove selected or focused`, `dialog: unmerged branches`, `dialog: leave processes`, and `Colors:` above the bottom border. At 72x24 it keeps two columns (`OTHER`, `quit` and `Colors:` still show) with the longer labels cut at the border; at 60x20 and 40x12 one column is cut at the bottom with no way to scroll (a known gap).
10. A light theme: on a tmux server started with `-f <file>` holding `set -g window-style "fg=#24292f,bg=#ffffff"` (tmux answers the app's background query with white), focus the list (Tab). The focused row's background is `48;2;223;227;234` in `capture-pane -e`, not the dark `48;2;43;48;59`. Render it with `image --from <capture> --theme light`: the focused row is a light bar with dark text.

## Traps

- Never run it with `HOME` outside the sandbox: with no folder given it scans the home folder's code folders.
- On this machine `/opt/homebrew/bin/wt` exists, so leaving `wt` off PATH alone does not hide Worktrunk (check 1).
- `image` can render the previous image's page tiled into the new one (several copies of the screen at another width). Look at every PNG; render again under a new `--out` name until the screen shows once.
- The light render uses macOS Terminal's Basic palette; a dim span's background is drawn lighter than the terminal would draw it, since dim is opacity in the HTML.

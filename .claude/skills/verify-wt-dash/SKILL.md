---
name: verify-wt-dash
description: Prove a user-visible change to wt-dash, the Git worktree dashboard TUI (bun src/index.ts, OpenTUI), by driving the real app in tmux on an isolated, seeded sandbox and checking exact screen text and Git state. Use for any change to what the dashboard shows or does (verdicts, lists, keys, the remove dialog, removals, layouts), to re-verify a feature, or to make PR images of the terminal.
---

# Verify wt-dash

## What proof is

Proof is driving the change in the real app, on an isolated instance, and checking exact values: what the terminal shows right after each key, and what Git and `removals.log` hold afterwards. Unit tests and lint do not replace it. `features/` says what to prove for each feature ([index](features/README.md)); it never says which keys to press, so work the steps out from the screen each time. Three commands do most of it:

```sh
bun .claude/skills/verify-wt-dash/stack.ts up --name <task>       # seed, start in tmux, wait until listed
bun .claude/skills/verify-wt-dash/stack.ts env --name <task>      # shell preamble, tmux commands, paths
bun .claude/skills/verify-wt-dash/stack.ts down --name <task> --purge
```

Every stack command prints one JSON object, `{"ok":true,...}` or `{"ok":false,"error":"...","hint":"..."}`; `--help` lists them. The stack only manages the instance. You drive with tmux.

## Isolation

An instance is a name (1–24 of `a-z0-9-`; use one per task, such as the branch topic) and everything under `.verify/<name>/` (gitignored):

- `sandbox/`: its own HOME (so its own `~/.cache/wt-dash/sizes.json` and `removals.log`), Git config, Worktrunk config (`WORKTRUNK_CONFIG_PATH` and friends), the scan root `sandbox/projects/` with the seeded repos, and their worktrees in `sandbox/worktrees/`.
- A tmux server on its own socket, `tmux -L wt-dash-verify-<name>-<checkout hash>`, holding one session, `app`, running `bun src/index.ts sandbox/projects` from this checkout with the instance env. The hash keeps the same name in two checkouts apart; `env` prints the exact socket.
- `logs/` (`app.log` is the app's stderr, `stack.log` every up/down) and `evidence/`.

There are no ports. Two agents in one checkout only need different names. Never drive the developer's own wt-dash, `~/projects` or `~/.cache/wt-dash`, and never drive an instance you did not start: `list` shows what exists. `up` refuses an instance started on another branch; recreate it with `down --purge` then `up`.

## Users and test data

There are no users. The data is the seed, built by `tests/support/fixture.ts` with real Git and Worktrunk: four repos under the scan root, one of which (`tools`) has no worktrees. `env --full` → `seed` lists every row with the verdict, status and reason the fixture expects; read it compactly with `bun .claude/skills/verify-wt-dash/stack.ts env --name <task> --full | jq -c '.seed[] | [.repo, .branch, .verdict, .status, .reason]'`. On macOS:

| Repo | Row (kind)                 | Verdict         | Status               | Notes                              |
| ---- | -------------------------- | --------------- | -------------------- | ---------------------------------- |
| api  | feature/assets             | Safe            | merged               | 12.0 MB of ignored files           |
| api  | feature/login              | Safe            | merged               | 3 days old                         |
| api  | agent/old-session          | Safe            | merged               | 💬 mark 3 days old, "likely stale" |
| api  | leftover/hotfix (branch)   | Safe            | merged               | no worktree                        |
| api  | agent/refactor             | Review          | merged               | 🤖 mark set at seed time           |
| api  | feature/new-endpoint       | Review          | no new commits       | created at seed time; AGE `3d`     |
| api  | feature/dirty-form         | Review          | uncommitted changes  |                                    |
| api  | feature/locked             | Review, blocked | locked               | reason "agent session"             |
| api  | leftover/spike (branch)    | Review          | unmerged commits     | no worktree                        |
| web  | fix/header, feature/bundle | Safe            | merged               | bundle is 4.0 MB                   |
| web  | feature/search             | Review          | unmerged commits     | 2 commits                          |
| web  | feature/cache              | Review          | unpushed commits     | local bare `origin`                |
| web  | feature/rebase             | Busy, blocked   | rebase in progress   |                                    |
| web  | feature/gone               | Broken          | folder missing       |                                    |
| docs | docs/typos                 | Safe            | merged               | 3 days old                         |
| docs | docs/conflict              | Busy, blocked   | unresolved conflicts |                                    |
| docs | docs/locked-bare           | Review, blocked | locked               | no reason                          |

The list's AGE column (`now`, `3d`) is the age of the row's last commit, not of the worktree; verdict reasons such as "Created just now" use when the worktree was created. So `feature/new-endpoint`, made at seed time on top of a main commit dated 3 days back, reads `3d` beside `Created just now, so it may s…`: expected, and `i` shows the same split (`LAST COMMIT   3d ago`). The worktrees made by the fixture's squash-merge builders read `now` because their own commits are new.

`up --seed <file>` builds the sandbox with a module's default export instead (a `SeedModule` from `stack.ts`); `scripts/readme-images/seed.ts`, the README's made-up projects, is one. Its rows differ from this table, and `state` lists only repos under its scan root.

Assume nothing beyond this table, and only what `state` shows after you change things. Removals are real, so a check that removes rows starts from a fresh seed: `down --purge`, then `up` (half a second). To arrange other state, use Git or `wt` as the instance's user, through a supported path, in the same shell call as the `eval` of `env` → `exports` (it reads `env --full`), as [features/rescan.md](features/rescan.md) does. Never edit `.git` files or the cache to fake the behavior under test.

On Linux, backdating a worktree does not move its birth time, so the real binary sees `feature/login` and `docs/typos` as new (Review, "Created just now…"); `env` reports `backdatesOnDisk: false` and `env --full` → `seed` already expects that. This skill was only run on macOS.

## Prove a change

1. `up --name <task>` (add `--variant narrow` for 80x24). It prints `"ok":true` once line 1 shows `scanned HH:MM`.
2. Read the feature files the change touches, from the [index](features/README.md).
3. Drive the new behavior on every entry point and in every variant it touched: wide (120x32, sidebar) and narrow (80x24, table) are built from different code. Check right after each key.
4. Rerun the checks of each touched feature, from a fresh seed where a check removes rows.
5. When the change is visible, take the PR images (below), and a before image of the same state when it alters an existing screen.
6. If behavior changed, update those feature files in the same change; a new feature gets a file and an index row.
7. Report (see Proof standards), then `down --name <task> --purge`.

## Re-verify a feature

1. `up --name <task>`, then `env --name <task> --full` for the socket and the seed.
2. For each variant the feature lists, resize (`commands.resizeWide` / `resizeNarrow` from `env`) or `up --variant`. Clear any selection first (Esc): it survives the resize.
3. Drive every check in the feature's file on each entry point and variant, purging and re-upping before checks that need a fresh seed.
4. Report each check by number: PASS with the exact text observed, FAIL with expected and observed, or INCONCLUSIVE with the step and its output.
5. `down --name <task> --purge`.

## Driving

The driver is tmux, run from your own shell. Each Bash call starts a new shell, so begin every call that drives with the preamble from `env`:

```sh
eval "$(bun .claude/skills/verify-wt-dash/stack.ts env --name <task> | jq -r .preamble)"
```

It defines `t` (tmux on the instance socket), `screen` (plain text of the pane), and `wait_for '<text>'` / `wait_gone '<text>'`, which poll the screen every 100 ms for 10 s and fail with `TIMEOUT`. They read; only `t send-keys` presses keys.

- **Keys**: `t send-keys -t app Down` (also `Up`, `Left`, `Right`, `Enter`, `Escape`, `Space`, `Tab`, `BTab`, `PageUp`, `PageDown`), letters as themselves (`a`, `x`, `D`, `S`), quote punctuation (`'/'`, `'['`, `']'`, `'?'`). Type text with `t send-keys -t app -l 'spike'`.
- **Read the screen before the first key.** Focus decides what a key does, and keys sent on a guess land somewhere else (a removal then removes the wrong row). After `up`, both variants start on the projects with `api` focused, never on "All projects" and never in a list:
  - wide: line 1 `wt-dash › api`, the sidebar row `▌ api 7`, `api`'s rows shown on the right but not focused, footer `→ worktrees  a select safe  / search`. Tab or → moves focus into the list (footer `space select  enter remove …`).
  - narrow: the table with `▌ api` focused, footer `enter open  a select safe  / search`. Enter opens `api`'s list.

  The same key reads differently by focus: `a` with the projects focused says `Selected … in api` and the footer offers `x remove`; in a list it says `Selected …` and the footer offers `enter remove`. Feature files name the focus each check needs.

- **One key, then wait for its effect, then read.** A capture right after `send-keys` can still show the previous frame. Wait for text that only the new state has: the screen title on line 1 (`wt-dash › web`), a dialog title, a toast. Before waiting for something to go, confirm it was there.
- **Locate by text and line.** Line 1 is the header (screen title, counts, `scanned HH:MM`); line 2 the tabs and search in a list; the second-last line the status (toasts, removal progress); the last line the key hints. The focused row starts with `▌`, a selected row has `■`, an unselectable one `–`. In the wide layout everything right of the sidebar's `│` is the list: `screen | sed 's/^.*│ //'` reads it alone.
- **Exact values.** Compare whole lines or exact substrings (`grep -F`), never "something changed". Colors: `t capture-pane -p -e -t app` keeps the escapes (Safe `38;5;2`, Review `38;5;3`, Busy `38;5;4`, Broken `38;5;1`).
- **Git state** after an action: `bun .claude/skills/verify-wt-dash/stack.ts state --name <task>` prints `{"ok":true,"name":…,"repos":{"<repo>":{"worktrees":[{"path","branch","head","locked"?,"prunable"?,"exists"}],"branches":["…"]}},"removalsLog":[{"timestamp","repo","branch","path","flags","exitCode","branchOutcome","error",…}]}`. `repos` is an object keyed by repo name (`api`, `web`, `docs`, `tools`), not an array; the main checkout is the first worktree; `branch` is null for a detached HEAD (`feature/rebase` mid-rebase); `removalsLog` is the last 20 lines of the instance's `removals.log`, oldest first (`--log <n>` for more). For example `state --name <task> | jq -c '.repos.api.branches, [.repos.web.worktrees[].branch], .removalsLog[-1]'`.
- **Watch it yourself** (optional, read-only): `t attach -r -t app` from a real terminal.

Worked example, [leftover-branches.md](features/leftover-branches.md) checks 3 and 4, as run:

```sh
eval "$(bun .claude/skills/verify-wt-dash/stack.ts env --name demo | jq -r .preamble)"
t send-keys -t app Tab;   wait_for 'space select'
t send-keys -t app 3;     wait_for 'needs a look'
for _ in 1 2 3 4 5 6; do screen | grep -q '▌ □ leftover/spike' && break; t send-keys -t app Down; sleep 0.15; done
t send-keys -t app Space; wait_for '■ leftover/spike'
t send-keys -t app Enter; wait_for 'Remove 1 branch'
screen | grep -F 'Keeps 1 unmerged branch  D delete too'
t send-keys -t app D;     wait_for 'Also deletes 1 unmerged branch  D keep them'
screen | grep -c 'Skips leftover/spike'      # 0: the warning is gone
```

## Proof standards

- Drive the real user path: keys in the running app. Never call `src/core` services, write to `sizes.json`, `removals.log` or `.git` to produce the behavior under test, or run `wt remove` in place of the app. Arranging a precondition with Git or `wt` as the instance's user is fine.
- Check right after each key, not only the final screen: a toast, a dialog line or the focused row can change and change back.
- A removal or prune is proven twice: the screen (toast, row gone, counts) and `state` (the worktree and branch gone from Git, the `removals.log` entry with its `flags`, `exitCode` and `branchOutcome`). A skipped or pruned row writes no log entry; prove those with `state`.
- Query `state` only for what the screen cannot show. Compare exact entries, never substrings, and only the instance's own repos.
- Drive every path the change touched: each entry point (Enter, `x`, the projects screen, the list) and each layout (wide sidebar, narrow table). Name any path changed but not driven.
- The report carries what was driven, since none of it is in the diff: each check by number or by what it proved, the entry points and variants, the exact values observed, and the PR images.
- An entry point that cannot be reached is reported with the step tried and the unmet precondition, never as verified through another path.
- A check that could not run is INCONCLUSIVE, never a pass. If the same step fails twice, stop that item, report it INCONCLUSIVE with the failing step and its output, and move on.
- Before calling something an app bug or writing a rule about the app, reproduce it a second way (another key, slower keys, `state`, a fresh seed). A tmux behavior is not app behavior: see Escape below.

### PR images

A change a user can see gets PR images: one per changed state and per variant, cropped to the change, named `<feature>-<state>-<variant>`. Get to the state, then (here the dialog of the worked example after `D`):

```sh
bun .claude/skills/verify-wt-dash/stack.ts image --name <task> --out leftover-branches-delete-unmerged-wide --rows 12-20 --cols 23-98
```

It saves the pane with colors (`evidence/<out>.ansi`), renders rows and columns (1-based, inclusive; omit both for the whole screen) as HTML in a fixed dark palette (`--theme light` for a white background and macOS Terminal's default colors), and screenshots it with agent-browser at 2x into `evidence/<out>.png`, printing its pixel size. Find the crop from `screen | cat -n` (rows) and the line's text (columns). For a state that does not last (a toast, removal progress), capture it at once with `t capture-pane -p -e -t app > .verify/<task>/evidence/<out>.ansi` and render it later with `--from` that file. Look at every PNG before attaching it. For a before image, revert the change's files in the working tree, `down` and `up` the instance (the app reads its source at start), take the same image with a `-before` suffix, restore the files, and confirm `git status` matches what it was. The report lists the PR images apart from other evidence, each with one line saying what it proves.

## Doctor and cleanup

- `doctor --name <task>`: read-only. Fails only when the instance is unusable: another branch than at `up`, the sandbox or tmux server gone, the app exited, the window not at its variant's size, or line 1 not showing `scanned`. A new commit since `up` is not a failure. It also prints the app log tail.
- `up` on a stopped instance restarts the app on the same data; on a running one it reuses it, resizing to `--variant` when given.
- `down --name <task> [--purge] [--dry-run]`: kills the instance's tmux server, then any process left in the app's process group whose command line names the instance folder (never by name), and closes the agent-browser session if one is open. `--purge` also deletes `sandbox/`, `instance.json` and `tmux.conf`. `logs/` and `evidence/` survive both; `--dry-run` lists what it would do.
- Run `down` after every failed attempt too. `list` shows every instance under `.verify/` and whether it runs.

## Gotchas

- **Escape followed closely by a key is Alt+key.** `t send-keys -t app Escape 3` (or two quick calls) reaches the app as Alt+3: the Escape is lost. Send Escape alone, wait for its effect, then the next key.
- **The remove dialog ignores Enter for 400 ms after it opens** (`y` is never ignored). `send-keys Enter Enter` opens it and leaves it open; wait for the dialog before confirming with Enter.
- **Toasts last 2.5–10 s** (most 4 s; removal summaries 10 s; "Can't select" 6 s) on the status line. Read them right after the key, and do not mistake an earlier toast for a new one.
- **Spinners and progress** (`⠼ scanning 0/4 repos`, `Removing 1 of 1: …`) change every 120 ms and a local scan or removal ends in under a second; poll every 50 ms right after the key to catch them, and never compare whole screens while one is up.
- **A removal in `web` drops the Broken `feature/gone` record** (it becomes a branch row; seen twice). Prove anything about Broken rows before removing in `web`, or on a fresh seed.
- **`sizing` is gone within a second of `scanned`** on the seed. To see it, add a worktree with a large folder (a few hundred thousand files) as the instance's user and press `r`: `1 sizing` shows while `du` runs. A worktree whose saved size went stale keeps its old size while re-measured, so it never reads `sizing`. A worktree whose `du` fails (an unreadable subfolder, a missing folder) stops reading `sizing` once it fails.
- **Selections and screen survive a resize.** `resize-window` keeps the selection, the open project and the focus (a row selected wide is still `■ 1 selected` narrow, and back). Clear the selection (Esc) before switching variants, or the next variant's checks start with it.
- **Ages tick.** `just now` becomes `1m ago`; reasons such as "Created just now, so it may still be in use" change with them. Match the stable part.
- **Truncation.** The list cuts reasons and long branch names with `…` (`feature/n…-endpoint` at 80 columns) and drops the reason's final period; the sidebar and strip cut paths in the middle. Read full values from `i` or `state`.
- **The wide sidebar never mentions `tools`** (no worktrees); only the narrow table says `1 project with no worktrees`.
- **zsh does not split a variable into words**: `T="tmux -L x"; $T ls` fails with "command not found". Use the preamble's `t` function.
- **Paths are real paths.** The sandbox lives in the checkout, so paths are what `env` prints. A worktree added under a macOS temp folder (`/var/folders/...`) shows in the app and in `state` as `/private/var/folders/...`. Add worktrees under `env` → `paths.worktrees`: `down --purge` deletes only the sandbox, so one outside it stays behind until you `git worktree remove` it.
- **Do not run `wt config show`** to inspect the instance's Worktrunk settings: per the developer it runs the claude CLI (its `--full` runs commit-generation checks). Read `$HOME/.config/worktrunk/config.toml` from `env` → `paths.home`.
- **tmux 3.6a's server exits at start** ("server exited unexpectedly") when `set -g window-size manual` is in the config file; the stack sets it after creating the session. To watch, attach read-only (`t attach -r -t app`), so no stray key reaches the app.
- **tmux in CI** was not checked; this skill is for local agents on macOS (tmux at `/opt/homebrew/bin/tmux`).

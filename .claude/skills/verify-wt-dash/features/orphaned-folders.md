# Orphaned folders

Worktree folders that no repository knows are listed under an "Orphaned folders" entry, last on the projects screen and counted in "All projects". Each row is named by its folder, with the folder above unless that is the agent's `worktrees` folder (`abcd/app`, `ef01`), and sits in the `○ ORPHANED` section with its size and why no repository knows it. Space selects one, `a` leaves them out, and Enter or `x` removes them through the usual dialog; wt-dash deletes the folder itself and logs it.

## Entry points and variants

- The "Orphaned folders" entry (sidebar or narrow table), "All projects", tab 6. Wide and narrow.

## Preconditions

- A fresh instance has no orphans. Arrange them as the instance's user, in one shell call with the `eval` of `env` → `exports`, under `$HOME` (the sandbox's):
  - an orphaned worktree: `git init -q -b main "$HOME/old/app" && git -C "$HOME/old/app" commit -q --allow-empty -m init && mkdir -p "$HOME/.codex/worktrees/abcd" && touch "$HOME/.codex/worktrees/abcd/.codex-worktree-name" && git -C "$HOME/old/app" worktree add -q -b codex/abcd "$HOME/.codex/worktrees/abcd/app"`, a few MB in it (`mkdir -p …/app/node_modules/pkg && head -c 3000000 /dev/zero > …/app/node_modules/pkg/blob.bin`), then `rm -rf "$HOME/old/app"`;
  - an empty Codex shell: `mkdir -p "$HOME/.codex/worktrees/ef01" && touch "$HOME/.codex/worktrees/ef01/.codex-worktree-name"`;
  - a live worktree of a repository outside the scan folder: `git init -q -b main "$HOME/elsewhere/lib" && git -C "$HOME/elsewhere/lib" commit -q --allow-empty -m init && git -C "$HOME/elsewhere/lib" worktree add -q -b codex/9a9a "$HOME/.codex/worktrees/9a9a/lib"`.
- Then `r`, and wait for `scanned HH:MM`.

## Checks

1. The sidebar ends with `Orphaned folders 2` (no FREE cell) and reads `All projects 18`; the live `lib` worktree is not listed anywhere (search `lib` finds nothing).
2. Focused, the entry's card reads `Orphaned folders`, `2 folders no repo knows`, `up to 2.9 MB`, `Codex 2`, `largest 2.9 MB · abcd/app`, and line 1 reads `wt-dash › Orphaned folders` with `2 orphaned folders · up to 2.9 MB`.
3. Its list shows `○ ORPHANED  2 orphaned folders · 2.9 MB · no repository knows it`, then `□ abcd/app  repository gone  Its repository at ~/old/app …  ?  2.9 MB` and `□ ef01  no worktree inside  Codex left this folder be…  ?  0 KB`. Tabs read `All 2  Safe 0  Review 0  Busy 0  Broken 0  Orphaned 2`; the header escape before `○ ORPHANED` is `38;5;5` (magenta).
4. The strip for `abcd/app` reads `abcd/app  ● Orphaned · repository gone`, `~/.codex/worktrees/abcd/app`, `Its repository at ~/old/app no longer exists.`, `Codex · 2.9 MB · measured …`; `i` shows `PATH`, `CREATED BY    Codex` and `SIZE`, and no LAST COMMIT, CHANGES, UPSTREAM or files.
5. Narrow: the table's last row is `Orphaned folders  2  ·  ·  ·  ·  2  ·  2.9 MB`, and its strip `Orphaned folders  2 folders no repo knows`, `SIZE  up to 2.9 MB`, `MADE BY  Codex 2`, `LARGEST  abcd/app · 2.9 MB`.
6. `a` in the orphans' list says `No Safe worktrees in this view`; Space on `abcd/app` shows `■ abcd/app`.
7. Enter on `abcd/app` opens `Remove 1 orphaned folder · up to 2.9 MB?` with `• abcd/app  2.9 MB` and `No repository tracks abcd/app, so wt-dash deletes it itself, unchecked, with everything inside.` (wrapped), and no `Stops processes running inside` line. `y` shows `✓ Removed 1 orphaned folder · freed …`; the list keeps only `ef01`. `$HOME/.codex/worktrees/abcd` is gone (the `<id>` folder held only its name file), and `state` → `removalsLog[-1]` is `{"repo":"<home>/old/app","branch":null,"path":"<home>/.codex/worktrees/abcd/app","flags":[],"exitCode":null,"branchOutcome":null,"orphan":true,"error":null}` plus its timestamp.
8. After `r`, `abcd/app` does not come back.
9. With a clean worktree selected too (Space on `api › feature/assets`), the dialog reads `Remove 1 worktree and 1 orphaned folder`, `Nothing uncommitted in the worktrees. Ignored files and caches go with them.`, and offers `e` again.

## Traps

- Removing an orphan is real: start check 7 from freshly arranged orphans.
- The orphans live in the sandbox HOME, which `down --purge` deletes; never arrange them in your own `~/.codex`.
- At 80 columns line 1 drops the row counts when they don't fit (`up to 2.9 MB · scanned …` only).

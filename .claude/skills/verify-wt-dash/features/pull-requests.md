# Pull requests merged on GitHub

A row Git can't show merged (unmerged commits, behind main) in a repository on github.com is checked against GitHub through the user's `gh`, one GraphQL request per repository plus one more for a stacked pull request. A merged pull request holding the row's tip commit, or a commit with the same files, or bringing it in from a pull request merged into another branch, makes the row Safe with status `merged on GitHub` and a reason naming the pull request. Otherwise the row stays Review and its reason says what GitHub found or why it wasn't asked. Line 1 reads `checking GitHub` while a request is out. Proofs are kept in `~/.cache/wt-dash/pull-requests.json`, so a proven commit isn't asked about again. Removing a proven row deletes its branch without `D`, and the dialog names the pull request. `--offline` never asks; `--doctor` reports the GitHub line.

## Entry points and variants

- The `worker` project's list and "All projects", `i` on a `worker` row, the remove dialog (Enter, `x`). Wide and narrow.
- `--offline` through `up --app-args=--offline`; `--doctor` as the instance's user.
- The fake gh, set with `stack.ts gh --name <task> --mode <mode> --delay <ms>` on a running instance (from its next call), or `up --gh-mode <mode> --gh-delay <ms>` before the first scan. Its log is `env` → `paths.ghCalls`, one JSON line per call.

## Preconditions

- A fresh instance. `worker` is the seed's GitHub repository (`https://github.com/acme/worker.git`, served from a local bare repository). Its rows, with the pull requests the fake holds (`env --full` → `seed`, each `worker` row's `github`):

  | Row                 | Builder               | Once GitHub answers                                                                 |
  | ------------------- | --------------------- | ----------------------------------------------------------------------------------- |
  | feature/squashed    | prMergedWorktree      | Safe, `PR #1 merged <day> with this exact commit.`                                  |
  | feature/revised     | prMergedEarlierCommit | Safe, `PR #2 merged <day> with this exact commit.`                                  |
  | feature/rebased     | prTreeMatch           | Safe, `PR #3 merged <day> with the same files.`                                     |
  | feature/stacked     | prStacked (#4, #5)    | Safe, `PR #5 merged <day> and brought in this commit from a stacked pull request.`  |
  | feature/after-merge | prMissingCommit       | Review, `… PR #6 merged <day> without this commit.`                                 |
  | leftover/squashed   | prMergedBranch, 3d    | Safe (branch)                                                                       |
  | feature/no-pr       | pushed, no PR         | Review, `1 commit isn't in main. No merged pull request on GitHub has this commit.` |

  `<day>` is the seed day, such as `Nov 6`. Before GitHub answers, or when it can't be asked, every row is Review with `seed` → `github.gitOnly`'s reason (`1 commit isn't in main, and merging would conflict.` and the like).

- The first scan after `up` asks GitHub. To watch it, start a fresh instance with `up --gh-delay 8000`: each call then waits 8 s (two calls, so about 16 s). Keep the delay under 15 s, gh's timeout, or rows read `Not checked against GitHub: GitHub didn't answer.`

## Checks

1. Fresh instance, `up --gh-delay 8000`, wide: `up`'s header already reads `… · checking GitHub · scanned HH:MM`. In `worker` (projects focused, Down twice) line 1 reads `wt-dash › worker   6 worktrees and 1 branch · up to 136 KB · checking GitHub · scanned HH:MM`, tabs `All 7  Safe 0  Review 7`, every row `unmerged commits`, the sidebar `worker 6  ·`. When `checking GitHub` goes, the tabs read `All 7  Safe 5  Review 2`, `✓ SAFE  4 worktrees and 1 branch · 72 KB · can go` lists `feature/stacked`, `feature/rebased`, `feature/revised`, `feature/squashed` and `leftover/squashed` with `merged on GitHub  PR #<n> merged <day> …`, and the sidebar reads `worker 6  72 KB`. `paths.ghCalls` holds 2 lines.
2. Same in narrow (`--variant narrow`, Enter on `worker`): the rows read `unmerged commits` and then `merged on GitHub` as in check 1, but line 1 never shows `checking GitHub` (see Traps).
3. `i` on each `worker` row shows the reason in full on the line under `● <verdict> · <status>`, matching the table above: `PR #1 merged <day> with this exact commit.`, `PR #3 merged <day> with the same files.`, `PR #5 merged <day> and brought in this commit from a stacked pull request.`, `2 commits aren't in main, and merging would conflict. PR #6 merged <day> without this commit.` (wrapped), `1 commit isn't in main. No merged pull request on GitHub has this commit.`. Wide and narrow.
4. A rescan asks only about the rows not proven: after `r`, the last line of `paths.ghCalls` carries `oid0`/`oid1` and `head0=feature/after-merge`, `head1=feature/no-pr`, and the proven rows stay Safe while `checking GitHub` shows.
5. A Review row's dialog keeps its branch: `x` on `feature/after-merge` reads `Keeps 1 unmerged branch  D delete too`.
6. `x` on `feature/squashed` (wide): `Remove 1 worktree · up to 12 KB?`, `• feature/squashed  worker  12 KB`, `Deletes branch feature/squashed: merged on GitHub as PR #1` in place of `Merged branches are deleted.`, and no `Keeps 1 unmerged branch`. `y` shows `✓ Removed 1 worktree · freed …`; `state` has no `feature/squashed` in `repos.worker.worktrees` or `branches`, its folder is gone from `paths.worktrees`, and the last `removalsLog` entry has `"branch":"feature/squashed","flags":["-D","--reap"],"exitCode":0,"branchOutcome":"deleted","branchProof":{"pr":1}`.
7. Narrow, Space on `leftover/squashed` and `feature/revised`, Enter: `Remove 1 worktree and 1 branch · up to 16 KB?` with `Deletes 2 branches merged on GitHub: feature/revised (PR #2) and` / `leftover/squashed (PR #7)`. Enter removes both: `✓ Removed 1 worktree and 1 branch`; the `removalsLog` entries are `feature/revised` with `flags: ["-D","--reap"]`, `branchProof: {"pr":2}` and `leftover/squashed` with `flags: ["-D"]`, `branchProof: {"pr":7}`, both `branchOutcome: "deleted"`.
8. Offline: a fresh instance with `up --app-args=--offline` shows all 7 `worker` rows Review (`Safe 0  Review 7`), `i` reads `<git reason> Not checked against GitHub: offline.` (`1 commit isn't in main. Not checked against GitHub: offline.` on `feature/no-pr`), line 1 never shows `checking GitHub`, and `paths.ghCalls` stays empty (`gh` → `calls: 0`). Wide and narrow.
9. Offline after an online run: `down`, `up --app-args=` (online; proofs cached), `down`, `up --app-args=--offline`: the five proven rows are Safe again from the cache, `feature/after-merge` and `feature/no-pr` read `Not checked against GitHub: offline.`, and no call is added.
10. Signed out: a fresh instance with `up --gh-mode signed-out`: all 7 rows Review, `i` reads `… Not checked against GitHub: gh isn't signed in.` (wide and narrow), one call logged. On a running instance, `gh --mode signed-out` then `r` gives the same note on `feature/after-merge` and `feature/no-pr` while the cached proofs stay Safe.
11. `--doctor <scan root>` as the instance's user prints `GitHub: checks merged pull requests with gh at <sandbox>/gh/bin/gh` between the Worktrunk line and `Scan folders:`, and `Repositories found: 5`; with `--offline`, `GitHub: off (--offline)`; with the fake's folder left off PATH, `GitHub: gh not found; rows Git can't prove merged stay Review`. Each exits 0, and none adds a line to `paths.ghCalls`.

## Traps

- Under 100 columns or so, line 1 drops `checking GitHub` for width (as it drops `sizing`), in a list and on the projects table, and the rows don't say they are being checked: in narrow, only the rows turning Safe show that the check ran. Check `checking GitHub` wide.
- Proofs are cached in `paths.pullRequests`. To watch rows turn Safe again, start from a fresh seed (`down --purge`, `up --gh-delay …`); a rescan or restart shows them Safe at once.
- `up` returns as soon as line 1 reads `scanned`, which is before GitHub answers when the fake is delayed. Wait for `checking GitHub` to go before comparing `worker` against `seed`.
- With focus not yet moved in a list, the focused row is the first one, so it changes when the rows re-sort as GitHub answers; once you have moved, focus follows the row.
- The merge day is the local day the seed ran; `seed` holds it as worded then. An instance kept past midnight still matches, since the pull requests' `mergedAt` doesn't move.

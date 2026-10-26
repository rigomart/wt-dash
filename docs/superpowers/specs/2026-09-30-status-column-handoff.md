# STATUS column and session checks: handoff

Status: ready to implement, with four open questions (see "Open questions").
Base: `main` at `3560bbc`. Written 2026-09-30 from a review of the dashboard against live data.

## For the implementing agent

Read this document, then the two earlier specs in this folder, then:

- `src/core/verdict.ts`: verdict rules.
- `src/ui/format.ts`: `whyLabel` (line 57), `sessionLabel`, `upstreamLabel`, `blockedLabel`.
- `src/core/actions.ts`: `removalBlockReason` (line 46) and the `stamp` freshness check (line 42).
- `src/core/worktrunk.ts`: the parser. The lock reason is dropped at line 76.
- `src/core/dashboard.ts`: the scan loop (around line 107).
- `src/ui/render.ts`: columns (line 183), header (line 192), row (line 207), details fields (around line 335).

Rules:

- Never change real worktrees, locks, or markers. Tests use the injected command runner and temporary repositories, as the existing tests do.
- Replacing Worktrunk with plain git is out of scope; the owner deferred it. Keep `wt list --format=json` as the source of rows.
- Items that depend on an open question: ask the owner, or build with the recommended default and say so in your report.
- Finish with `bun test` and `bun run typecheck` passing, plus the read-only acceptance checks at the end of this document.

## Problem

On a machine that runs agents daily, a scan can show nearly every worktree as `Review`, and most of them cannot be removed because of a lock or an agent marker. Most of those locks and markers are left over from sessions that have ended. The dashboard can't tell stale from live, so it reports them all as possible activity.

The WHY column makes this worse:

- It shows only the first matching condition, so a lock hides unmerged commits and a marker hides a predicted conflict with main.
- Its labels name raw signals ("locked", "waiting on you") rather than the current situation. "waiting on you" on a marker set in March is misleading.
- It mixes three kinds of statements (activity, unsaved work, why a row is safe), so a stale lock reads as seriously as unmerged work.
- The name "WHY" only makes sense as an answer to the colored verdict dot.

## Validated findings

Each item was checked against the code and against live data on 2026-09-30.

1. **The label shows only the first match.** The order in `whyLabel` is: git operation, merge conflicts, prunable, locked, marker, unknown status, local changes, unpushed, main relation. Real merge conflicts rank above markers, so markers can't hide them. What markers do hide is `would_conflict` (a predicted conflict with main).
2. **The lock reason is dropped.** Worktrunk's JSON includes `worktree.locked.reason`, for example `claude session login (pid 24621 start Wed Sep 23 15:55:03 2026)`. The parser stores only `locked: boolean`.
3. **Stale locks exist.** None of the processes named in the locks is running:

   | Worktree | Process in the lock | Processes working inside |
   |---|---|---|
   | my-app `feature/login` | 24621, gone | none |
   | api `feature/search` | 98703, gone | none |
   | web `feature/onboarding` | 69262, gone | 12 (node, biome, workerd, zsh: a dev server) |

   A dead owner is therefore not enough to call a worktree idle.
4. **Markers linger.** The Worktrunk Claude plugin (`~/.claude/plugins/cache/worktrunk/worktrunk/1.0.0/hooks/hooks.json`) sets 🤖 on `UserPromptSubmit`, sets 💬 on `Notification`, and clears the marker only on `SessionEnd`. A killed or crashed session never clears it. Markers are stored per branch name in git config as `worktrunk.state.<branch>.marker = {"marker":"🤖","set_at":<unix seconds>}`. Evidence:
   - A busy repository can hold over a hundred markers, most of them for branches that no longer exist.
   - Markers several months old are common.
   - `wt list --format=json` exposes only the emoji, never `set_at`.
5. **Some rows are `Review` only because of a stale marker.** Each is clean, merged or identical to main, and has nothing running inside, for example:
   - my-app `fix/typo`, `chore/dev-setup`
   - web `feature/dark-mode`
6. **Markers hide a predicted conflict with main on other rows**, for example:
   - my-app `feature/payments`
   - api `fix/rate-limit`
7. **The rules are copied in four places and have drifted:**
   - `verdictFor` treats only 🤖 and 💬 as markers (`verdict.ts:8`).
   - `whyLabel` treats any marker as one (`format.ts:64`).
   - `removalBlockReason` blocks on any marker (`actions.ts:53`).
   - `blockedLabel` uses yet another order (`format.ts:117`).

   As a result, a row with a custom marker such as ✅ can be `Safe`, show "agent marker", and still be blocked from removal.
8. **Some labels overstate:**
   - "never pushed" (`format.ts:96`) actually means "no tracking-branch information".
   - "merged" covers several content checks (`patch_id_match`, `merge_adds_nothing`, `trees_match`) and never checks whether a PR was merged.
9. **Commit counts depend on the base.** Worktrunk's `default_branch.ahead` compares against `origin/main` when it exists. my-app `feature/login` is 3 commits ahead of `origin/main` but 4 ahead of a stale local `main`. Any count shown must use one base consistently and name it in the details pane.
10. **Limits of the liveness evidence:**
    - A live Claude Code session locks the worktree it uses with its own process ID. The session that wrote this document was locked with `pid 66942`, and that process had its working directory inside the worktree.
    - The lock's start time is written in **UTC**, while `ps -o lstart=` prints local time: the lock said `15:12:06`, `ps` said `10:12:06` in a −05 zone. Convert before comparing.
    - Other Claude processes kept their working directories in `~`, `~/projects`, or a daemon temp folder. So "no process inside" does not prove that a marker-only session has ended. Markers carry no process ID. Their only evidence is age and whatever else is going on in the worktree.

## Decisions (agreed with the owner)

### D1: Rename the column to STATUS

The header becomes `STATUS`. Sorting by this column still sorts by verdict.

Widen the column from 19 to 24 (`render.ts:185`), taking the space from BRANCH:

- A base label is at most 19 characters. With a ` +N` suffix, the cell holds at most 23 characters.
- Commit counts of 100 or more drop the word "commits" (`140 unmerged`). Process counts above 99 display as `99+`.
- When a label and its suffix still don't fit (narrow terminals), drop the suffix before truncating the label.

### D2: Labels describe the current situation, not the raw signal

| Situation | Label |
|---|---|
| Git operation in progress | `rebase in progress` (use the operation name; use `mid-<operation>` when the label would exceed 19 characters, e.g. `mid-cherry-pick`) |
| Unresolved merge conflicts in the worktree | `files in conflict` |
| Prunable record | `folder missing` |
| Lock owner is alive | `session running` |
| Lock owner is gone, but processes run inside | `in use · N procs` |
| Lock owner is gone and nothing runs inside | `stale lock · 7d` (lock age if known, otherwise just `stale lock`) |
| Lock reason can't be parsed | `locked` (conservative: treated as a live session) |
| Recent 🤖 marker (see Q1) | `agent active` |
| Recent 💬 marker (see Q1) | `agent waiting` |
| Stale marker | not shown in the column; appears in the details pane only |
| Status unknown | `can't read status` |
| Uncommitted or untracked files | `uncommitted edits` |
| Commits ahead of the tracking branch | `N commits unpushed` |
| `ahead` of main | `N commits unmerged` (base: see Q3) |
| `would_conflict` | `conflicts with main` |
| `diverged` / `behind` / `orphan` | `diverged from main` / `behind main` / `unrelated history` |
| `integrated` (any reason other than `same_commit`) | `merged into main` |
| `same_commit` or `empty` | `nothing new` |
| No main relation | `main status unknown` |

Singular forms apply for 1 (`1 commit unmerged`). The details pane, not the column, carries the precise meaning: which integration check matched, which base was used, and "no tracking branch" in place of "never pushed".

### D3: Rank findings by what matters for the decision, and count the rest

A row can have several findings. The column shows the highest-ranked one and a dim `+N` for the rest. Ranks, highest first:

1. Git operation or unresolved conflicts, then folder missing
2. Active use: `session running`, `in use`, `agent active` or `agent waiting`, unparsable `locked`
3. Unknown status
4. Unsaved or unmerged work: uncommitted edits, unpushed, unmerged, conflicts with main, diverged, behind, unrelated history
5. Leftovers: stale lock
6. Reasons it's safe: merged into main, nothing new

Stale markers are informational: they appear in the details pane and are not counted in `+N`.

Expected rows for the examples above:

```
     BRANCH                        STATUS              SIZE
 – ● feature/onboarding            in use · 12 procs
 – ● feature/login                 3 commits unmerged +1
 – ● feature/search                1 commit unmerged +1
 □ ● chore/dev-setup               merged into main
 □ ● fix/typo                      nothing new
```

### D4: The details pane lists every finding

Replace the `SESSION` field with a `CHECKS` list: one line per finding, marked ✗ (blocks or needs review), ! (leftover), or ✓ (passes). Include:

- the full lock reason with the owner's state (`pid 24621 · ended`)
- the number of processes inside
- the marker and its age (`🤖 set 209d ago`)
- the base used for commit counts
- the integration reason

Example for my-app `feature/login`:

```
CHECKS   ✗ 3 commits not on origin/main
         ! lock from session login · pid 24621 ended · nothing running inside
         ✓ no uncommitted edits · pushed
```

### D5: One shared assessment

Add a single core function, for example `assess(facts, activity)` in `src/core/assess.ts`, that returns:

- the verdict
- an ordered list of typed findings. Each finding has a kind, a rank, a short column label, a detail sentence, and whether it blocks removal.
- the removal block reason

Derive these from it and delete their separate rule chains:

- `verdictFor`
- the column label (replacing `whyLabel`)
- `blockedLabel`
- `sessionLabel`
- `removalBlockReason`

Every marker value goes through the same rules. There must be no emoji allow-list in one place and "any marker" in another. The `Verdict` type still includes `"Probably safe"`, which nothing produces (`model.ts:116`, `view.ts:19`, `theme.ts:34`). Remove it unless the owner wants it kept.

### D6: Collect session facts during the scan

- **Lock:** add `lockReason: string | null` to `WorktreeFacts`, parsed from `worktree.locked.reason`. Extract `pid` and `start` from the Claude Code format `… (pid N start <ctime>)`, where the start time is in UTC. Any other format keeps the raw reason and counts as a live lock.
- **Marker age:** read `git -C <repo> config --get-regexp '^worktrunk\.state\..+\.marker$'` once per repository and join on branch name to set `markerSetAt`. A missing or invalid timestamp means unknown age, which counts as recent.
- **Activity:** once per scan, not per repository, run `lsof -a -d cwd -Fpcn` and `ps -o pid=,lstart= -p <lock pids>`.
  - Map a process to a worktree when its working directory equals the worktree path or starts with `path + "/"`.
  - A lock owner counts as alive when the process ID exists **and** its start time matches the lock's start time after converting time zones. A reused process ID must not look like the old session.
  - Keep activity in its own structure, separate from the facts that `stamp()` compares, because process lists change constantly.
- **If `lsof` or `ps` fails:** activity is unknown. Treat locks as live and markers as recent. Never call something stale without evidence.

### D7: Removal rules

- These findings block removal: active use (`session running`, `in use`, a recent marker, an unparsable lock), a git operation, unresolved conflicts, prunable, and unknown status. These are the same as today, except that stale markers no longer block.
- A stale lock still blocks, because Git refuses to remove a locked worktree without a double `-f`. Offering to unlock is Q2.
- Immediately before each removal, the action service re-collects activity for that row and runs `assess` again. If the result became blocking, the row is skipped with the reason. `stamp()` stays limited to identity and git facts.
- Whether removal should also clear the branch's stale marker from git config is part of Q2.

## Open questions

- **Q1: When is a marker stale?**
  - Recommended default: stale when the worktree has no live lock, no process inside, and the marker's `set_at` is more than 24 hours old.
  - Otherwise it counts as recent and blocks removal.
  - The owner may prefer a different threshold, or showing age without ever auto-staling.
- **Q2: Should the dashboard clean up leftovers?** That would mean new confirmed actions to unlock a stale lock (`git worktree unlock`) and to clear a stale marker. It would also cover the orphan markers for deleted branches.
  - Recommended default: a separate follow-up slice. This slice only reports leftovers.
- **Q3: Which base for commit counts?**
  - Recommended default: Worktrunk's `default_branch.ahead`, which uses `origin/main` when it exists, with the base named in the details pane.
  - The alternative is local `main`, which can be stale.
- **Q4: Final wording.** The owner approved the direction of the labels in D2. Confirm the exact words before adjusting tests and README.

## Suggested order

1. **Facts:** `lockReason` in the parser and types, then marker ages per repository. Add parser tests with a lock fixture.
2. **Activity collector:** a core module using the injected runner, called from the dashboard scan. Include the UTC start-time comparison.
3. **`assess`:** port the current behavior first, then change the rules in D2, D3, and D7. Keep `verdict.test.ts` passing where the behavior is intentionally unchanged.
4. **UI:** the STATUS header, labels with `+N`, and the `CHECKS` list. Remove `whyLabel`, `sessionLabel`, and `blockedLabel` once nothing uses them.
5. **Actions:** `removalBlockReason` comes from `assess`, plus the activity recheck before each removal.
6. **Docs:** update README line 39 (the definition of Safe) and the column description.

## Tests

Assessment:

- Each row of the D2 table.
- The D3 ranking with several findings on one row, and the `+N` count.
- Base labels never exceed 19 characters, and a label with its ` +N` suffix never exceeds 23. Cover singular forms, plural forms, and counts of 100 or more.
- A custom marker (✅) goes through the same rules in the verdict, the label, and removal.

Liveness:

- A lock owner that is alive with a matching start time.
- A lock owner that is alive but whose process ID was reused (start time differs).
- A lock owner that is gone, with processes inside.
- A lock owner that is gone, with nothing inside.
- An unparsable lock reason.
- `lsof` or `ps` failing.
- Converting the lock's UTC start time for comparison.

Markers:

- Recent, stale, missing `set_at`, invalid JSON in git config, a marker for a deleted branch (ignored), and a branch name containing `/`.

Removal:

- A stale marker no longer blocks.
- A stale lock still blocks.
- Activity that appears between the preview and the removal skips the row.

## Read-only acceptance checks on a real machine

Run the dashboard and compare with this list. Substitute the matching rows on the machine you test on.

- A worktree with unmerged commits and a lock from an ended session (like my-app `feature/login` above):
  - The column shows an unmerged-commits label with `+1`.
  - The details show the lock reason with its pid ended.
- A worktree whose lock owner is gone but runs a dev server (like web `feature/onboarding`): shows `in use · N procs` while the server runs, and stays blocked.
- A worktree used by a live Claude Code session, including the one implementing this: shows `session running` and is blocked.
- Rows whose markers are stale under the Q1 rule show their git state. Clean, merged ones become `Safe` and can be selected.
- No row shows a `Safe` verdict together with a blocked checkbox (`–`).

## Out of scope

- Replacing or reducing the Worktrunk dependency (deferred by the owner).
- Checking PR status.
- New write actions for locks and markers (Q2).

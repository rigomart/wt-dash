# STATUS column implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Explain worktree status using one assessment, verified session activity, and safe removal rechecks.
**Architecture:** Keep Worktrunk as the source of Git facts. Collect marker timestamps per repository and process evidence per scan, then feed one core assessment into verdicts, STATUS, CHECKS, and removal eligibility.
**Tech Stack:** TypeScript, Bun, OpenTUI; injected command runner.
**Spec:** docs/superpowers/specs/2026-09-30-status-column-handoff.md

## Global Constraints

- Never change real worktrees, locks, or markers. Tests use injected runners and temporary repositories.
- Keep `wt list --format=json` as the source of rows.
- Use the recommended defaults: markers older than 24 hours can be stale only with known idle activity; report leftovers without clearing them; use Worktrunk's ahead count and name its base; use D2 wording.
- Process evidence is separate from the Git freshness stamp. Failed process checks remain conservative.
- Finish with `bun test`, `bun run typecheck`, and read-only acceptance checks.

## Review Focus

- Reused PIDs and time zones must never identify an unrelated process as a live lock owner.
- Missing, malformed, future marker timestamps and failed process commands must never authorize removal through staleness.
- Refresh cancellation and partial scans must not publish stale activity or briefly show marker rows as removable.
- Processes in similarly prefixed sibling paths must not count as processes inside a worktree.
- Narrow STATUS cells must drop the finding suffix before truncating the main label.

### Task 1: Preserve facts and collect evidence

**Files:** src/core/types.ts, src/core/worktrunk.ts, src/core/activity.ts, src/core/markers.ts; tests/worktrunk.test.ts, tests/activity.test.ts, tests/markers.test.ts.
**Interfaces:** `parseLock(reason)` returns PID and UTC start time or null; `collectActivity(rows, runner, signal?)` returns activity keyed by row ID; `readMarkers(repo, runner, signal?)` returns branch timestamps; parser preserves lock reason, ahead count, and comparison base.

- [x] Write tests for lock preservation, slash branch names, malformed marker values, UTC conversion, reused/gone/live PIDs, directory boundaries, and command failures.
- [x] Run the tests and observe missing-feature failures.
- [x] Implement collectors using one lsof snapshot and one batched ps command; never change markers.
- [x] Run focused tests and typecheck. Expected: all pass.
- [x] Commit `feat: collect worktree session evidence`.

### Task 2: Shared assessment

**Files:** src/core/assess.ts, src/core/verdict.ts; tests/assess.test.ts, tests/verdict.test.ts.
**Interfaces:** `assess(facts, activity?, now?)` returns verdict, reason, ordered typed findings, and removal block reason. Findings contain kind, rank, label, detail, blocksRemoval, and severity.

- [x] Write tests for D2 labels, D3 ranking, stale markers and locks, every marker value, unknown activity, label widths and counts, and Safe/removable consistency.
- [x] Run tests and observe missing-feature failures.
- [x] Implement the shared assessment; make verdictFor a compatibility wrapper without rules.
- [x] Run assessment and verdict tests. Expected: all pass.
- [x] Commit `feat: assess worktree status consistently`.

### Task 3: Scan and removal integration

**Files:** src/core/dashboard.ts, src/core/actions.ts; tests/dashboard.test.ts, tests/actions.test.ts.
**Interfaces:** dashboard enriches rows with markers and shared scan activity before final assessment; actions read fresh markers and activity in preview and immediately before each removal, while Git stamps exclude process evidence.

- [x] Write tests for scan-wide collection, cancellation, stale marker selection, stale lock blocking, and activity appearing after preview.
- [x] Run tests and observe failures against existing behavior.
- [x] Integrate collectors and shared assessment. Keep fast incremental publication conservative while process checks are pending.
- [x] Run dashboard and action tests. Expected: all pass.
- [x] Commit `feat: recheck activity before worktree removal`.

### Task 4: STATUS and CHECKS interface

**Files:** src/ui/format.ts, src/ui/render.ts, src/ui/model.ts, src/ui/theme.ts, src/core/view.ts, src/core/types.ts, README.md; tests/format.test.ts, tests/terminal.test.ts, tests/model.test.ts.
**Interfaces:** `statusLabel(row, width?)` derives its label and suffix from assessment findings; CHECKS displays all findings. Remove obsolete rule chains and Probably safe.

- [x] Write tests for STATUS/CHECKS rendering, dim additional findings, narrow widths, precise upstream/integration details, and shared removal explanations.
- [x] Run tests and observe failures.
- [x] Render STATUS with 24 columns and CHECKS with findings; update docs.
- [x] Run `bun test` and `bun run typecheck`. Expected: all pass.
- [x] Run read-only acceptance for stale locks, in-use worktrees, live lock owners, stale-marker Safe rows, and Safe/removable consistency.
- [x] Commit `feat: show status findings and session checks`.

## Execution record

User requested implementation on the existing worktree-status-column-handoff branch. Worktree starts clean at 9d90dce; baseline: 78 passing tests and passing typecheck. Design and recommended defaults are supplied by the handoff; implementation proceeds inline under that authorization.

Final verification: 138 tests pass, typecheck passes, and all read-only live acceptance checks pass. Independent review found incomplete process output, pending activity publication, and delayed final activity checks; each was fixed with a failing regression test followed by a passing full suite.

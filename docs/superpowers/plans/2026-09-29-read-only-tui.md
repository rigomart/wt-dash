# Read-only Worktree TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a Mac's Git worktrees across repositories in a responsive, read-only terminal dashboard with sizes, filters, and conservative cleanup verdicts.

**Architecture:** A UI-independent Bun service discovers repos, parses Worktrunk JSON, measures sizes, and publishes snapshots. Pure selectors filter and sort rows. An OpenTUI adapter owns keyboard input and rendering; it never calls Git or computes verdicts.

**Tech Stack:** Bun 1.3.14, TypeScript, `@opentui/core`, `bun test`, Git, Worktrunk 0.80.0, macOS command-line tools.

**Spec:** [Read-only dashboard design](../specs/2026-09-29-read-only-dashboard-design.md)

## Global Constraints

- Run with `bun run start` in a terminal; open no network listener.
- Discover `.git` directories under `~/projects` to depth 3. Run `/opt/homebrew/bin/wt -C <repo> list --format=json`, at most four repos concurrently, and accept only schema 2.
- Keep non-main worktrees, including null branches for detached HEAD. Key rows by repo path plus worktree path.
- Run `du -sk <path>` at most twice concurrently; persist sizes and timestamps at `~/.cache/wt-dash/sizes.json`.
- Publish rows before all repos or sizes finish. Late results from older refreshes must not overwrite newer scans.
- First-wave verdicts use only local Worktrunk facts; marker or unverified lock means Review. No removal command or key exists.
- Pass command arguments separately, without a shell. Keep scanning, verdicts, and selectors free of OpenTUI imports.

## File Map

| File | Responsibility |
|---|---|
| `src/core/types.ts` | Shared row, snapshot, command-runner, and service types |
| `src/core/worktrunk.ts`, `src/core/verdict.ts` | Parse schema-2 JSON and classify each row |
| `src/core/discovery.ts`, `src/core/process.ts` | Find repo roots and run read-only commands |
| `src/core/sizes.ts` | Bounded `du` queue and timestamped size cache |
| `src/core/dashboard.ts` | Scan orchestration, refresh generations, subscriptions |
| `src/core/view.ts` | Pure search, filter, sort, and grouping selectors |
| `src/ui/terminal.ts`, `src/index.ts` | OpenTUI screen and CLI composition |
| `tests/*.test.ts`, `tests/fixtures/*.json` | Core and selector tests with no real worktree changes |
| `package.json`, `tsconfig.json`, `.gitignore`, `README.md` | Bun scripts, type checks, cache exclusions, run instructions |

## Review Focus

1. A branch or path with spaces, quotes, or shell characters must reach `wt`/`du` as one argument; Task 2 tests the argument array.
2. A repo with malformed JSON or an unsupported Worktrunk schema must show a fatal scan error, never Safe rows; Tasks 1 and 4 test this.
3. A missing or corrupt size cache, or a failed `du`, must leave rows usable with unknown sizes; Task 3 tests this.
4. Two refreshes that finish out of order must show only the newer results; Task 4 tests this.
5. A narrow terminal must keep focus, full-row details, and quit available; Task 6 checks this with OpenTUI's test renderer and a manual resize.

---

### Task 1: Parse Worktrunk and assign verdicts

**Files:** Create `package.json`, `tsconfig.json`, `.gitignore`, `src/core/types.ts`, `src/core/worktrunk.ts`, `src/core/verdict.ts`, `tests/worktrunk.test.ts`, `tests/verdict.test.ts`, and `tests/fixtures/list-v2.json`.

**Interfaces:** Produce `WorktreeRow`, `DashboardSnapshot`, `CommandRunner`, and `DashboardService` types in `types.ts`; `parseWorktrunk(repoPath: string, stdout: string): WorktreeRow[]`; `SchemaMismatchError`; and `verdictFor(row: WorktreeRow): { verdict: Verdict; reason: string }`. A row has `id`, `repoPath`, `repoName`, `path`, `branch: string | null`, `headSha`, `committedAt: string | null`, `tool`, `changes`, `upstreamAhead: number | null`, `mainState: string | null`, `marker: string | null`, `locked`, `prunable`, `operation`, `sizeKiB: number | null`, `sizeMeasuredAt: string | null`, `verdict`, and `reason`.

- [ ] **Step 1: Write failing parser and verdict tests.** Assert schema 2 keeps non-main rows, a null branch, and full paths; schema 1 and malformed JSON throw; absent optional fields stay null. Assert Busy outranks Broken, locks/markers/changes/upstream-ahead become Review, and a clean integrated row is Safe.
- [ ] **Step 2: Run `bun test tests/worktrunk.test.ts tests/verdict.test.ts`.** Expected: fail because modules are absent.
- [ ] **Step 3: Add Bun scripts (`start`, `test`, `typecheck`), TypeScript config, fixture, types, parser, and verdict function.** Use a small schema check and explicit field extraction; never infer Safe from a missing field. The `start` script points at `src/index.ts` for the later task.
- [ ] **Step 4: Run `bun test tests/worktrunk.test.ts tests/verdict.test.ts` and `bun run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit:** `git add package.json tsconfig.json .gitignore src/core tests && git commit -m "feat: parse worktree facts and verdicts"`.

### Task 2: Discover repos and run commands safely

**Files:** Create `src/core/discovery.ts`, `src/core/process.ts`, `tests/discovery.test.ts`, and `tests/process.test.ts`.

**Interfaces:** Produce `discoverRepos(root: string, maxDepth: number): Promise<string[]>`; `runCommand(command: string, args: string[], signal?: AbortSignal): Promise<CommandResult>`. `CommandResult` has `stdout`, `stderr`, and `exitCode`; `CommandRunner` is the corresponding function type from Task 1.

- [ ] **Step 1: Write failing tests.** Temp directories prove depth 3 finds nested repos once, ignores `.git` files and symlinks, and does not descend into a discovered repo. An injected process invocation proves a path with spaces or shell characters stays a single argument; a nonzero exit and abort remain visible.
- [ ] **Step 2: Run `bun test tests/discovery.test.ts tests/process.test.ts`.** Expected: fail because modules are absent.
- [ ] **Step 3: Implement repo walking with `readdir({ withFileTypes: true })` and process execution with `Bun.spawn([command, ...args])`.** Collect stdout and stderr, pass the abort signal, and do not invoke a shell.
- [ ] **Step 4: Run the two test files and `bun run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit:** `git add src/core/discovery.ts src/core/process.ts tests && git commit -m "feat: discover repos and run read-only commands"`.

### Task 3: Measure and cache sizes

**Files:** Create `src/core/sizes.ts` and `tests/sizes.test.ts`.

**Interfaces:** Produce `createSizeService(cachePath: string, runner: CommandRunner, concurrency?: number): SizeService`. `SizeService` has `load(): Promise<void>`, `get(path: string): SizeEntry | null`, `measure(path: string): Promise<SizeEntry | null>`, and `close(): Promise<void>`; `SizeEntry` has `sizeKiB` and `measuredAt`.

- [ ] **Step 1: Write failing tests.** Assert at most two `du` calls run together, cached sizes load with timestamps, missing/corrupt cache loads as empty, and failed or malformed `du` returns null without losing an existing row. Include a path containing spaces.
- [ ] **Step 2: Run `bun test tests/sizes.test.ts`.** Expected: fail because the service is absent.
- [ ] **Step 3: Implement the queue and JSON cache.** Run `du -sk` with separate arguments; write cache through a temporary file and rename after each successful measurement; leave failures visible to the dashboard through a null result.
- [ ] **Step 4: Run `bun test tests/sizes.test.ts` and `bun run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit:** `git add src/core/sizes.ts tests/sizes.test.ts && git commit -m "feat: measure and cache worktree sizes"`.

### Task 4: Publish dashboard snapshots

**Files:** Create `src/core/dashboard.ts` and `tests/dashboard.test.ts`.

**Interfaces:** Produce `createDashboardService({ projectRoot, wtPath, runner, sizeService, discover = discoverRepos }): DashboardService`. `DashboardService` exposes `getSnapshot()`, `subscribe(listener)`, `refresh()`, `refreshSize(worktreeId)`, and `close()`. `refresh()` resolves after repo scans finish; size updates may continue afterward. A snapshot exposes `generation`, `rows`, `progress`, `errors`, and `fatalError`.

- [ ] **Step 1: Write failing tests with fake discovery, runner, and size service.** Assert each repo publishes rows before another slow repo finishes, no more than four `wt` calls run together, a repo failure leaves other rows, schema mismatch sets `fatalError` and clears rows, subscription immediately receives a snapshot, detached rows survive, and older refresh results are ignored.
- [ ] **Step 2: Run `bun test tests/dashboard.test.ts`.** Expected: fail because the service is absent.
- [ ] **Step 3: Implement generation-scoped scan orchestration.** Overlay cached sizes before publishing a repo, schedule measurements without delaying rows, and publish size updates only for the current generation and row ID. Keep command errors in `errors`.
- [ ] **Step 4: Run `bun test tests/dashboard.test.ts` and `bun run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit:** `git add src/core/dashboard.ts tests/dashboard.test.ts && git commit -m "feat: stream read-only dashboard snapshots"`.

### Task 5: Select rows for the UI

**Files:** Create `src/core/view.ts` and `tests/view.test.ts`.

**Interfaces:** Produce `selectRows(rows: WorktreeRow[], options: ViewOptions): WorktreeRow[]` and `groupByRepo(rows: WorktreeRow[]): RepoGroup[]`. `ViewOptions` contains search text, optional verdict/repo/tool filters, and sort key (`size`, `age`, `repo`, `verdict`) plus direction. Selectors do not mutate input rows.

- [ ] **Step 1: Write failing tests.** Assert case-insensitive branch/path search, combined filters, default descending size with unknown last, age/repo/verdict sorting, stable ties, and grouping that preserves selected order.
- [ ] **Step 2: Run `bun test tests/view.test.ts`.** Expected: fail because selectors are absent.
- [ ] **Step 3: Implement the pure selectors with a stable secondary key of row ID.** Keep filtering state outside the dashboard service.
- [ ] **Step 4: Run `bun test tests/view.test.ts` and `bun run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit:** `git add src/core/view.ts tests/view.test.ts && git commit -m "feat: filter and sort worktree rows"`.

### Task 6: Build the terminal UI and verify on a real machine

**Files:** Create `src/ui/terminal.ts`, `src/index.ts`, `tests/terminal.test.ts`, and `README.md`; update `package.json` and `bun.lock` when adding `@opentui/core`.

**Interfaces:** Produce `runTerminal(service: DashboardService): Promise<void>`. `src/index.ts` creates the size and dashboard services with `~/projects`, `/opt/homebrew/bin/wt`, and `~/.cache/wt-dash/sizes.json`, then runs the terminal adapter and closes both services on exit.

- [ ] **Step 1: Write failing terminal behavior tests.** With a fake dashboard service and OpenTUI test renderer, assert a first snapshot shows the header and row, narrow width keeps the focused row's full details and quit key, filter/search affects visible rows, and refresh calls the service. Test quitting restores the renderer.
- [ ] **Step 2: Run `bun test tests/terminal.test.ts`.** Expected: fail because the adapter is absent.
- [ ] **Step 3: Add `@opentui/core` and implement the screen and keys.** Header: counts, “up to” totals, progress, errors. Table: verdict, repo, branch, tool, age, size, changes, main state. Detail panel: full path, marker, reason. Keys: arrows/`j`/`k`, `/`, `f`, `s`, `g`, `r`, `R`, `q`. Handle resize and always destroy the renderer on exit.
- [ ] **Step 4: Run `bun test`, `bun run typecheck`, and `git diff --check`.** Expected: all pass. Then run `bun run start` in a PTY, compare listed paths with `wt list` for real repos, confirm Codex and detached rows, first rows within about two seconds, filters and resize, and a clean terminal after `q`.
- [ ] **Step 5: Write `README.md` with installation, run, keys, scan scope, cache location, and read-only status. Commit:** `git add src/ui src/index.ts tests/terminal.test.ts package.json bun.lock README.md && git commit -m "feat: show worktrees in a read-only TUI"`.

## Completion Check

Run `bun test`, `bun run typecheck`, and the real-machine TUI acceptance check once more after all tasks. Confirm no removal commands or network listeners exist in first-wave source, and record the observed path count, first-row time, and any remaining limitations in the final report.

# Contributing

Development currently targets macOS 13 or newer. Install Git, Worktrunk 0.80.0 or newer, and Bun 1.3.14 (required for release builds), then run:

```sh
bun install --frozen-lockfile
bun run start -- ~/projects
```

Before submitting a change:

```sh
bun test
bun run typecheck
bun run build
python3 scripts/smoke-test.py dist/wt-dash
```

Keep the Git assessment and cleanup rules in `src/core`, and terminal interaction in `src/ui`. For cleanup changes, cover stale confirmations, locks, unfinished Git operations, local changes, and branch retention. Tests must use temporary repositories and never remove the contributor's own worktrees.

When reporting a problem, include the macOS version, CPU architecture, terminal application, `wt-dash --version`, and the output of `wt-dash --doctor` with your scan folders. Remove private paths or repository names before posting. For display issues, include terminal dimensions and the key sequence that triggered the problem.

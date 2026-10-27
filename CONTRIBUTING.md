# Contributing

Development targets macOS 13 or newer. Install Git, Worktrunk 0.80.0 or newer, and [Bun](https://bun.com/) 1.3.14, the runtime pinned for release builds:

```sh
brew install worktrunk
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

The smoke test copies the built binary into an isolated folder, creates a temporary repository and worktree, opens the dashboard in a terminal, and quits. GitHub Actions runs all four checks on Apple Silicon and Intel Macs.

Keep the Git assessment and cleanup rules in `src/core`, and terminal interaction in `src/ui`. `src/core` has no terminal dependency, so another interface can reuse its data and rules. For cleanup changes, cover stale confirmations, locks, unfinished Git operations, local changes, and branch retention. Tests must use temporary repositories and never remove the contributor's own worktrees.

## Reporting a problem

Include the macOS version, CPU architecture, terminal application, `wt-dash --version`, and the output of `wt-dash --doctor` with your scan folders. Remove private paths and repository names first. For display issues, add the terminal size and the keys that triggered the problem.

## Building from source

`bun run build` writes `dist/wt-dash`, a standalone executable that bundles Bun and the terminal UI, plus an archive, its SHA-256 checksum, and third-party notices. Build on the architecture you want to ship, because the matching OpenTUI native library is embedded.

`bun run install:local` copies the executable to `~/.local/bin`, or to `WT_DASH_INSTALL_DIR` if set. It does not edit shell startup files, so add the folder to your PATH yourself.

## Releasing

1. Set the version in `package.json` and merge that change into `main`.
2. Push a matching tag, such as `v0.1.0`. The workflow refuses a tag that differs from `package.json`.
3. The workflow runs the checks on both architectures and creates a draft GitHub release with the archives, checksums, and a generated Homebrew formula, `wt-dash.rb`.
4. Review and publish the draft. Homebrew cannot download the archives until it is published.
5. Copy the release's `wt-dash.rb` into `Formula/` in [rigomart/homebrew-tap](https://github.com/rigomart/homebrew-tap), then run `brew install rigomart/tap/wt-dash` and `brew test rigomart/tap/wt-dash`.

To generate the formula locally, put both architecture archives in `dist/` and run `bun run formula rigomart/wt-dash`.

## Rebuilding with a modified Bun runtime

Releases are built with Bun 1.3.14, and the build refuses any other version. The application can be rebuilt from this source with a modified Bun 1.3.14 runtime; Bun's instructions for rebuilding with modified linked libraries are in the third-party notices. `licenses/bun-1.3.14/sources.json` records the sources of the runtime notices.

To move to another Bun version, update `scripts/build.ts` and the release workflow, refresh the upstream texts in `licenses/`, and verify the builds on both architectures.

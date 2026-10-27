# Releasing wt-dash

The first release supports macOS 13 (Ventura) or newer on Apple Silicon and Intel Macs. Worktrunk remains a required dependency. Users of the standalone executable do not need Bun or Node.js.

## Local checks and installation

Use Bun 1.3.14 and Worktrunk 0.80.0 or newer:

```sh
brew install worktrunk
bun install --frozen-lockfile
bun test
bun run typecheck
bun run build
python3 scripts/smoke-test.py dist/wt-dash
bun run install:local
```

The build produces `dist/wt-dash`, an archive for the current Mac's architecture, a SHA-256 checksum, and dependency notices. Build each architecture on its own Mac so that the matching OpenTUI native library is embedded. CI does this on both architectures. The smoke test copies the binary into an isolated folder, creates a temporary Git repository and worktree, opens the dashboard in a terminal, and quits it.

`install:local` installs into `~/.local/bin`. Set `WT_DASH_INSTALL_DIR` to choose another folder. It does not change shell startup files. Add the destination to your PATH if necessary.

## GitHub release

1. Ensure `package.json` has the intended version and merge the release changes into `main`.
2. Push a matching tag, such as `v0.1.0`.
3. The workflow runs tests, type checking, builds, and terminal smoke tests on both architectures. It then creates a **draft** GitHub release with archives, checksums, and `wt-dash.rb`.
4. Review and publish the draft release.
5. Update the Homebrew tap as described below.

The workflow refuses tags whose version differs from `package.json`. Releases use Bun 1.3.14, and the build refuses a different runtime. To change that version, update the build script and workflow, refresh the upstream texts in `licenses/`, and verify both builds. `licenses/bun-1.3.14/sources.json` records the sources used for runtime notices. The application can be rebuilt from this source using a modified Bun 1.3.14 runtime; see Bun's linked-library rebuilding instructions in the notices.

## Homebrew

The generated formula declares Worktrunk as a dependency and chooses the archive for the user's CPU. It takes its repository URL from `GITHUB_REPOSITORY` and hashes the actual release archives; no owner or checksum is hardcoded.

To generate it locally, put both architecture archives into `dist/` and run:

```sh
bun run formula rigomart/wt-dash
```

The tap lives at [rigomart/homebrew-tap](https://github.com/rigomart/homebrew-tap). For each release, copy the `wt-dash.rb` attached to the release into its `Formula/` directory. Users then install the dashboard and Worktrunk together:

```sh
brew install rigomart/tap/wt-dash
wt-dash --doctor ~/projects
```

The draft release must be published before Homebrew can download its archives. Run `brew test rigomart/tap/wt-dash` after updating the formula.

The compiled executable is not signed with an Apple Developer identity or notarized. Homebrew is the preferred installation route. For direct downloads, users may need to allow the downloaded executable in macOS Privacy & Security after verifying its origin and checksum. Signing and notarization can be added when an Apple Developer identity is available.

# Contributing

Development targets macOS 13 or newer and Linux with glibc. Install Git, Worktrunk 0.80.0 or newer, and [Bun](https://bun.com/) 1.3.14, the runtime pinned for release builds:

```sh
brew install worktrunk
bun install --frozen-lockfile
bun run start -- ~/projects
```

Before submitting a change:

```sh
bun run lint
bun run format:check
bun test
bun run typecheck
bun run build
python3 scripts/smoke-test.py dist/wt-dash
```

`bun run lint` runs oxlint, and `bun run format` rewrites files with oxfmt. The smoke test copies the built binary into an isolated folder, creates a temporary repository and worktree, opens the dashboard in a terminal, and quits.

Title pull requests with [Conventional Commits](https://www.conventionalcommits.org/), such as `fix: keep the selection after a refresh`. Pull requests are squash-merged, so the title becomes the commit message that decides the next version and the changelog entry.

Keep the Git assessment and cleanup rules in `src/core`, and terminal interaction in `src/ui`. `src/core` has no terminal dependency, so another interface can reuse its data and rules. For cleanup changes, cover stale confirmations, locks, unfinished Git operations, local changes, and branch retention. Tests must use temporary repositories and never remove the contributor's own worktrees.

Tests come in three layers. Module tests check one module with Git and Worktrunk faked, and follow the source layout: `tests/<name>.test.ts` for a file directly in `src`, `src/core` or `src/ui`, and `tests/<folder>/` for a folder such as `src/core/removal` or `src/ui/update`. `tests/integration` runs the real services from `src/app.ts` against real Git and Worktrunk in a sandbox from `tests/support/fixture.ts`, which builds a worktree or branch in each state the dashboard tells apart. `tests/e2e` drives the real terminal UI on those services with key presses and checks the rendered text and what happened on disk. A change that crosses a boundary (Worktrunk output, a service the UI calls, what a removal does) needs an integration or end-to-end test, because a faked boundary is where earlier regressions hid. A bug fix adds a test, named for its pull request, that fails without the fix.

## Continuous integration

The CI workflow, `.github/workflows/ci.yml`, runs on every pull request and every push to `main`. It runs lint and format checks once, as **Lint and format**, and the other four checks on Apple Silicon and Intel Macs and on arm64 and x64 Linux, as **macOS (arm64)**, **macOS (x64)**, **Linux (arm64)**, and **Linux (x64)**. Each of these jobs keeps its archive and checksum as a build artifact for seven days. The CI workflow never publishes anything.

The Release workflow, `.github/workflows/release.yml`, runs on every push to `main` to maintain the Release PR, described under [Releasing](#releasing). When a Release PR is merged, it runs the CI workflow on the merge commit and attaches the archives those checks built and smoke-tested to the draft release.

Dependabot opens a weekly pull request that updates the GitHub Actions the workflows use.

## Reporting a problem

Include the operating system and its version (the Linux distribution on Linux), CPU architecture, terminal application, `wt-dash --version`, and the output of `wt-dash --doctor` with your scan folders. Remove private paths and repository names first. For display issues, add the terminal size and the keys that triggered the problem.

## Building from source

`bun run build` writes `dist/wt-dash`, a standalone executable that bundles Bun and the terminal UI, plus an archive, its SHA-256 checksum, and third-party notices. Build on the operating system and architecture you want to ship, because the matching OpenTUI native library is embedded.

`bun run install:local` copies the executable to `~/.local/bin`, or to `WT_DASH_INSTALL_DIR` if set. It does not edit shell startup files, so add the folder to your PATH yourself.

## Releasing

Versions and the changelog come from the commit messages on `main`, through [release-please](https://github.com/googleapis/release-please). Below 1.0, `feat:` and breaking changes raise the minor version, and other changelog types such as `fix:` and `perf:` raise the patch version.

1. release-please keeps a Release PR open against `main`. It sets the next version in `package.json` and `.release-please-manifest.json` and adds the unreleased changes to `CHANGELOG.md`. Edit the changelog in that pull request if needed.
2. Merge the Release PR to ship. The Release workflow tags the merge commit, creates a draft GitHub release with the changelog, runs every CI check, and attaches the four archives, their checksums, and a generated Homebrew formula, `wt-dash.rb`.
3. Download and try the archives from the draft, then publish it. Homebrew cannot download the archives until it is published.
4. Publishing runs the Homebrew tap workflow, `.github/workflows/homebrew-tap.yml`, which commits the release's `wt-dash.rb` to `Formula/wt-dash.rb` in [rigomart/homebrew-tap](https://github.com/rigomart/homebrew-tap) as `wt-dash <version>`. It needs the deploy key described under [Homebrew tap deploy key](#homebrew-tap-deploy-key). When it finishes, run `brew update`, `brew install rigomart/tap/wt-dash` and `brew test rigomart/tap/wt-dash`.

A draft release never touches the tap. Re-running the workflow for a release the tap already has, or for an older release, makes no commit. If it failed, for example because the deploy key was missing, fix the cause and re-run the failed job from the release's run in the Actions tab.

The Release PR is opened by GitHub Actions, so CI does not run on it. It only changes the version and changelog of code that already passed CI on `main`, and the checks run again after it is merged. If a check fails on a release, re-run the failed jobs. If the release needs a code fix, delete the draft without publishing it and ship the fix in the next Release PR.

GitHub Actions needs permission to open the Release PR: enable **Allow GitHub Actions to create and approve pull requests** under the repository's Settings → Actions → General.

To generate the formula locally, put the macOS and Linux archives for both architectures in `dist/` and run `bun run formula rigomart/wt-dash`.

## Homebrew tap deploy key

A workflow's built-in token can only write to its own repository, so the Homebrew tap workflow pushes to `rigomart/homebrew-tap` with a deploy key: an SSH key added to the tap with write access, whose private half is stored in this repository as the Actions secret `HOMEBREW_TAP_DEPLOY_KEY`. A deploy key works on that one repository only, belongs to no personal account, and doesn't expire. Without the secret, the workflow fails with an error that names it.

You need admin access to both repositories and the GitHub CLI signed in (`gh auth status`).

### Create and install the key

1. In a new empty folder, outside any repository, create a key pair without a passphrase. This writes the private half to `homebrew-tap-deploy-key` and the public half to `homebrew-tap-deploy-key.pub`.

   ```sh
   ssh-keygen -t ed25519 -N "" -C "wt-dash release workflow" -f homebrew-tap-deploy-key
   ```

2. Add the public half to the tap as a deploy key with write access:

   ```sh
   gh repo deploy-key add homebrew-tap-deploy-key.pub --repo rigomart/homebrew-tap --allow-write --title "wt-dash release workflow"
   ```

3. Store the private half as the secret in this repository:

   ```sh
   gh secret set HOMEBREW_TAP_DEPLOY_KEY --repo rigomart/wt-dash < homebrew-tap-deploy-key
   ```

4. Delete both files. GitHub keeps the only copies it needs, and the secret can't be read back.

   ```sh
   rm homebrew-tap-deploy-key homebrew-tap-deploy-key.pub
   ```

5. Check that both are in place: the key is listed with read-write access, and the secret is listed by name.

   ```sh
   gh repo deploy-key list --repo rigomart/homebrew-tap
   gh secret list --repo rigomart/wt-dash
   ```

`gh repo deploy-key add` ties the key to your GitHub CLI sign-in: if you de-authorize the GitHub CLI app or its token, GitHub removes the key too, and the next publish fails. To avoid that, add the public half on the tap's Settings → Deploy keys page instead, with **Allow write access** checked.

### Rotate the key

Rotate it when someone who could read it leaves, or if the private half may have leaked. Run the five steps above with a new title such as `wt-dash release workflow 2`. `gh secret set` replaces the secret. Then remove the old key from the tap, using the ID that `gh repo deploy-key list` shows for the old title:

```sh
gh repo deploy-key list --repo rigomart/homebrew-tap
gh repo deploy-key delete <old-key-id> --repo rigomart/homebrew-tap
```

If the key leaked, delete the old deploy key first, so it stops working at once, then create the new one.

## Rebuilding with a modified Bun runtime

Releases are built with Bun 1.3.14, and the build refuses any other version. The application can be rebuilt from this source with a modified Bun 1.3.14 runtime; Bun's instructions for rebuilding with modified linked libraries are in the third-party notices. `licenses/bun-1.3.14/sources.json` records the sources of the runtime notices.

To move to another Bun version, update `scripts/build.ts` and the `bun-version` in both workflows, refresh the upstream texts in `licenses/`, and verify the builds on every platform and architecture.

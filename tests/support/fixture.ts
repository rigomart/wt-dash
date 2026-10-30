import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { createServices } from "../../src/app";
import type { ActionService } from "../../src/core/removal/types";
import { discoverRepos, readCreatedAt, type RepoSource } from "../../src/core/scan/discovery";
import type {
  CommandResult,
  CommandRunner,
  DashboardService,
  RowKind,
  SizeService,
  Verdict,
  WorktreeRow,
} from "../../src/core/types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How old builders make anything that must be older than a day, unless told otherwise. */
export const OLD_AGE_MS = 3 * DAY_MS;
/** Per-test timeout for tests on real Git and Worktrunk, which take seconds each on slow CI runners. */
export const TEST_TIMEOUT = 30_000;
const prefix = "wt-dash-sandbox-";

/** What the dashboard should show for a built row. */
export interface Expected {
  verdict: Verdict;
  /** The STATUS column: `assess(row).status`. */
  status: string;
  reason: string;
  /** Whether removal is blocked: `assess(row).removalBlockReason !== null`. */
  blocked: boolean;
  /** `markerNote(row)`, for rows with an agent mark. */
  note?: string;
}

/** A worktree or leftover branch a builder made, and how the app should judge it. */
export interface Built {
  kind: RowKind;
  repo: string;
  /** The worktree folder, or null for a branch without a worktree. */
  path: string | null;
  branch: string;
  expected: Expected;
  /** KiB written into the worktree, for `sizedWorktree`; `du` reports at least this. */
  minSizeKiB?: number;
}

export interface ExecOptions {
  cwd?: string;
  /** Added to the sandbox env for this command. */
  env?: Record<string, string>;
}

export type SavedRepos = NonNullable<Parameters<typeof createServices>[0]["savedRepos"]>;

export interface Services {
  dashboard: DashboardService;
  actions: ActionService;
  sizes: SizeService;
  close(): Promise<void>;
}

/**
 * A main repository under the scan root, with `main` checked out in its folder. Its builders each make one row
 * with real Git and Worktrunk, with worktrees outside the scan root. Builders that merge into main must run
 * before `freshWorktree`, `unmergedWorktree` and `unmergedBranch` in the same repo, whose verdicts depend on
 * main staying put; the repo throws otherwise.
 */
export interface Repo {
  name: string;
  path: string;
  /** Runs Git in the main checkout and returns trimmed stdout; throws on a non-zero exit. */
  git(...args: string[]): Promise<string>;
  /** Merged into main with a merge commit and older than a day: Safe. */
  mergedWorktree(branch: string, options?: { ageMs?: number }): Promise<Built>;
  /** Squash-merged into main: Safe at any age. */
  squashMergedWorktree(branch: string): Promise<Built>;
  /** No commits beyond main and just created: Review. */
  freshWorktree(branch: string): Promise<Built>;
  /** An uncommitted edit and an untracked file: Review. */
  dirtyWorktree(branch: string): Promise<Built>;
  /** Commits that aren't in main: Review. */
  unmergedWorktree(branch: string, options?: { commits?: number }): Promise<Built>;
  /** Commits pushed to a local bare `origin`, then one more that isn't: Review. */
  unpushedWorktree(branch: string): Promise<Built>;
  /** `git worktree lock`, with `reason` or none when null: Review, blocked. */
  lockedWorktree(branch: string, options?: { reason?: string | null }): Promise<Built>;
  /** A rebase stopped on a conflict: Busy, blocked. */
  rebasingWorktree(branch: string): Promise<Built>;
  /** Unresolved conflicts with no merge or rebase in progress: Busy, blocked. */
  conflictedWorktree(branch: string): Promise<Built>;
  /** Folder deleted while Git still records it: Broken. */
  deletedWorktree(branch: string): Promise<Built>;
  /**
   * Squash-merged, with an agent mark set by `wt config state marker set` as the agent plugins do, `ageMs` ago:
   * Review under a day, else Safe with the mark noted as stale.
   */
  markedWorktree(branch: string, options: { marker: "🤖" | "💬"; ageMs?: number }): Promise<Built>;
  /** Squash-merged, with `kib` KiB of ignored files, mostly in node_modules: Safe. */
  sizedWorktree(branch: string, options?: { kib?: number }): Promise<Built>;
  /** A branch merged into main whose worktree was removed, created `ageMs` ago: Safe. */
  mergedBranch(branch: string, options?: { ageMs?: number }): Promise<Built>;
  /** A branch with a commit not in main whose worktree was removed: Review. */
  unmergedBranch(branch: string): Promise<Built>;
}

export interface Sandbox {
  root: string;
  home: string;
  /** Where repositories live; pass it to the dashboard as the project root. */
  scanRoot: string;
  /** The complete environment commands run with; only PATH comes from process.env, with wt's folder first. */
  env: Record<string, string>;
  wtPath: string;
  /** `<home>/.cache/wt-dash`, where the app keeps sizes.json and removals.log. */
  cacheDir: string;
  /**
   * Whether backdating a worktree moves the birth time readCreatedAt reads (true on macOS). Where it doesn't
   * (Linux), only services given `readCreated` see the age; the real binary sees those worktrees as new.
   */
  backdatesOnDisk: boolean;
  /** The app's CommandRunner, running every command with `env`. */
  runner: CommandRunner;
  /**
   * readCreatedAt, except that a worktree a builder backdated reports its backdated time when the file system
   * kept a later birth time. Pass it as `readCreated` to the dashboard and action services.
   */
  readCreated(worktree: string): Promise<string | null>;
  exec(command: string, args: string[], options?: ExecOptions): Promise<CommandResult>;
  /** Runs Git in `cwd` and returns trimmed stdout; throws on a non-zero exit. */
  git(cwd: string, ...args: string[]): Promise<string>;
  /** Runs Worktrunk in `cwd` and returns trimmed stdout; throws on a non-zero exit. */
  wt(cwd: string, ...args: string[]): Promise<string>;
  /** Creates `<scanRoot>/<name>` with one commit on main. */
  repo(name: string): Promise<Repo>;
  /**
   * Dashboard, action and size services on the sandbox; `cleanup` closes any still open. `runner` replaces the
   * sandbox runner, for wrappers from tests/support/runners.ts. `sources` replaces the scan root.
   */
  services(options?: {
    runner?: CommandRunner;
    sources?: RepoSource[];
    savedRepos?: SavedRepos;
  }): Promise<Services>;
  /** Closes services, removes every worktree of the sandbox's repos, then the sandbox. Safe to call twice. */
  cleanup(): Promise<void>;
}

/** The `wt` executable on PATH, or WT_PATH when set. Never a shell function or alias. */
export function resolveWtPath(): string {
  const override = process.env.WT_PATH;
  const found = override ? Bun.which(override) : Bun.which("wt");
  if (!found)
    throw new Error(
      override
        ? `WT_PATH=${override} is not an executable.`
        : "Worktrunk's wt was not found on PATH. Install Worktrunk 0.80.0 or newer, or set WT_PATH.",
    );
  return found;
}

export function findRow(rows: WorktreeRow[], built: Built): WorktreeRow | undefined {
  return rows.find(
    (row) => row.repoPath === built.repo && row.kind === built.kind && row.branch === built.branch,
  );
}

/** The app's "20m ago", written out independently so tests catch changes to it. */
export function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const gitconfig = `[user]
\tname = Sandbox
\temail = sandbox@example.com
[init]
\tdefaultBranch = main
[core]
\tautocrlf = false
\tfsmonitor = false
[commit]
\tgpgsign = false
[tag]
\tgpgsign = false
[gc]
\tauto = 0
[maintenance]
\tauto = false
[advice]
\tdetachedHead = false
\tskippedCherryPicks = false
[merge]
\tconflictStyle = merge
`;

const wtConfig = `worktree-path = "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}"
skip-shell-integration-prompt = true
skip-commit-generation-prompt = true
`;

async function birthMovesWithMtime(root: string): Promise<boolean> {
  const probe = join(root, "probe");
  await mkdir(probe);
  const old = new Date(Date.now() - OLD_AGE_MS);
  await utimes(probe, old, old);
  const { birthtimeMs } = await stat(probe);
  await rm(probe, { recursive: true });
  return Math.abs(birthtimeMs - old.getTime()) < 1000;
}

/**
 * Creates an isolated world in a fresh temp folder, or in `root`, which must not exist yet. Call `cleanup` when
 * done.
 */
export async function createSandbox(
  options: { wtPath?: string; root?: string } = {},
): Promise<Sandbox> {
  const wtPath = options.wtPath ?? resolveWtPath();
  if (!Bun.which("git")) throw new Error("Git was not found on PATH.");
  if (options.root !== undefined) {
    await mkdir(dirname(resolve(options.root)), { recursive: true });
    await mkdir(resolve(options.root));
  }
  const root = await realpath(options.root ?? (await mkdtemp(join(tmpdir(), prefix))));
  const home = join(root, "home");
  const scanRoot = join(root, "projects");
  const worktrees = join(root, "worktrees");
  const cacheDir = join(home, ".cache", "wt-dash");
  const config = join(home, ".config");
  const template = join(root, "git-template");
  const env: Record<string, string> = {
    PATH: [dirname(wtPath), process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
    HOME: home,
    TMPDIR: join(root, "tmp"),
    LC_ALL: "C",
    NO_COLOR: "1",
    XDG_CONFIG_HOME: config,
    XDG_CONFIG_DIRS: join(root, "xdg"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: template,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
    WORKTRUNK_CONFIG_PATH: join(config, "worktrunk", "config.toml"),
    WORKTRUNK_SYSTEM_CONFIG_PATH: join(root, "xdg", "worktrunk", "config.toml"),
    WORKTRUNK_APPROVALS_PATH: join(config, "worktrunk", "approvals.toml"),
  };
  let backdatesOnDisk: boolean;
  try {
    for (const folder of [home, scanRoot, worktrees, template, join(root, "tmp")])
      await mkdir(folder, { recursive: true });
    await mkdir(join(config, "worktrunk"), { recursive: true });
    await writeFile(join(config, "worktrunk", "config.toml"), wtConfig);
    await writeFile(env.GIT_CONFIG_GLOBAL!, gitconfig);
    backdatesOnDisk = await birthMovesWithMtime(root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const backdated = new Map<string, number>();
  const opened = new Set<Services>();
  const repos: string[] = [];
  let cleaned = false;

  async function exec(
    command: string,
    args: string[],
    { cwd, env: extra }: ExecOptions = {},
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    if (signal?.aborted) throw new Error("Command aborted");
    const environment = { ...env, ...extra };
    const executable = command.includes("/") ? command : Bun.which(command, environment);
    if (!executable) throw new Error(`${command} was not found on the sandbox PATH`);
    const child = Bun.spawn([executable, ...args], {
      cwd: cwd ?? root,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (signal?.aborted) throw new Error("Command aborted");
      return { stdout, stderr, exitCode };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function check(command: string, args: string[], options?: ExecOptions): Promise<string> {
    const result = await exec(command, args, options);
    if (result.exitCode !== 0)
      throw new Error(
        `${command} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`,
      );
    return result.stdout.trim();
  }

  const runner: CommandRunner = (command, args, signal, environment) =>
    exec(command, args, { env: environment }, signal);
  const git = (cwd: string, ...args: string[]) => check("git", args, { cwd });
  const wt = (cwd: string, ...args: string[]) => check(wtPath, args, { cwd });

  async function readCreated(worktree: string): Promise<string | null> {
    const real = await readCreatedAt(worktree);
    const forced = backdated.get(worktree);
    if (forced === undefined || (real !== null && Date.parse(real) <= forced)) return real;
    return new Date(forced).toISOString();
  }

  async function repo(name: string): Promise<Repo> {
    const path = join(scanRoot, name);
    await git(scanRoot, "init", "-q", path);
    repos.push(path);
    await writeFile(join(path, "README.md"), `# ${name}\n`);
    await mkdir(join(path, ".git", "info"));
    await writeFile(join(path, ".git", "info", "exclude"), "node_modules/\ndist/\n");
    await git(path, "add", "README.md");
    await git(path, "commit", "-q", "-m", "Initial commit");
    let pinnedBy: string | null = null;

    const dated = (ageMs: number): Record<string, string> => {
      const date = `@${Math.floor((Date.now() - ageMs) / 1000)} +0000`;
      return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    };
    const slug = (branch: string) => branch.replaceAll(/[^\w.-]+/g, "-");
    const pin = (builder: string) => {
      pinnedBy ??= builder;
    };
    const movesMain = (builder: string) => {
      if (pinnedBy)
        throw new Error(`${name}: ${builder} merges into main, so build it before ${pinnedBy}`);
    };
    const built = (
      branch: string,
      worktree: string | null,
      expected: Omit<Expected, "blocked"> & { blocked?: boolean },
    ): Built => ({
      kind: worktree === null ? "branch" : "worktree",
      repo: path,
      path: worktree,
      branch,
      expected: { blocked: false, ...expected },
    });

    async function commit(
      cwd: string,
      file: string,
      content: string,
      env?: Record<string, string>,
    ) {
      await writeFile(join(cwd, file), content);
      await check("git", ["add", file], { cwd, env });
      await check("git", ["commit", "-q", "-m", `Change ${file}`], { cwd, env });
    }
    async function add(branch: string, env?: Record<string, string>): Promise<string> {
      const worktree = join(worktrees, `${name}.${slug(branch)}`);
      await check("git", ["worktree", "add", "-q", "-b", branch, worktree, "main"], {
        cwd: path,
        env,
      });
      return worktree;
    }
    async function squashMerged(branch: string): Promise<string> {
      const worktree = await add(branch);
      await commit(worktree, `${slug(branch)}.txt`, `${branch}\n`);
      // A main commit of its own keeps main's files from matching the branch's exactly.
      await commit(path, `${slug(branch)}.main.txt`, `${branch}\n`);
      await git(path, "merge", "-q", "--squash", branch);
      await git(path, "commit", "-q", "-m", `Squash ${branch}`);
      return worktree;
    }
    async function conflict(worktree: string, branch: string, operation: "merge" | "rebase") {
      const file = `${slug(branch)}.conflict.txt`;
      const other = `${branch}-conflicting`;
      await commit(worktree, file, "ours\n");
      await git(worktree, "checkout", "-q", "-b", other, "main");
      await commit(worktree, file, "theirs\n");
      await git(worktree, "checkout", "-q", branch);
      const result = await exec("git", [operation, other], { cwd: worktree });
      if (result.exitCode === 0) throw new Error(`${operation} of ${other} did not conflict`);
      if (operation === "merge") await git(worktree, "merge", "--quit");
      await git(worktree, "branch", "-D", other);
    }
    const squashReason = "Merging it into main would change nothing.";

    return {
      name,
      path,
      git: (...args) => git(path, ...args),
      async mergedWorktree(branch, { ageMs = OLD_AGE_MS } = {}) {
        movesMain("mergedWorktree");
        const env = dated(ageMs);
        const worktree = await add(branch, env);
        await commit(worktree, `${slug(branch)}.txt`, `${branch}\n`, env);
        await check("git", ["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch], {
          cwd: path,
          env,
        });
        const created = Date.now() - ageMs;
        const gitdir = /^gitdir: (.+)$/m.exec(await readFile(join(worktree, ".git"), "utf8"))![1]!;
        await utimes(resolve(worktree, gitdir.trim()), new Date(created), new Date(created));
        backdated.set(worktree, created);
        return ageMs < DAY_MS
          ? built(branch, worktree, {
              verdict: "Review",
              status: "merged",
              reason: `Created ${ago(ageMs)}, so it may still be in use.`,
            })
          : built(branch, worktree, {
              verdict: "Safe",
              status: "merged",
              reason: "Its commits are already in main.",
            });
      },
      async squashMergedWorktree(branch) {
        movesMain("squashMergedWorktree");
        const worktree = await squashMerged(branch);
        return built(branch, worktree, { verdict: "Safe", status: "merged", reason: squashReason });
      },
      async freshWorktree(branch) {
        pin("freshWorktree");
        const worktree = await add(branch);
        return built(branch, worktree, {
          verdict: "Review",
          status: "no new commits",
          reason: "Created just now, so it may still be in use.",
        });
      },
      async dirtyWorktree(branch) {
        const worktree = await add(branch);
        await writeFile(join(worktree, "README.md"), `# ${name}\n\nEdited.\n`);
        await writeFile(join(worktree, "notes.txt"), "draft\n");
        return built(branch, worktree, {
          verdict: "Review",
          status: "uncommitted changes",
          reason: "Removing it deletes work that isn't committed.",
        });
      },
      async unmergedWorktree(branch, { commits = 1 } = {}) {
        pin("unmergedWorktree");
        const worktree = await add(branch);
        for (let index = 1; index <= commits; index++)
          await commit(worktree, `${slug(branch)}.${index}.txt`, `${index}\n`);
        return built(branch, worktree, {
          verdict: "Review",
          status: "unmerged commits",
          reason: `${commits === 1 ? "1 commit isn't" : `${commits} commits aren't`} in main.`,
        });
      },
      async unpushedWorktree(branch) {
        const remote = join(root, "remotes", `${name}.git`);
        if ((await exec("git", ["remote", "get-url", "origin"], { cwd: path })).exitCode !== 0) {
          await git(root, "init", "-q", "--bare", remote);
          await git(path, "remote", "add", "origin", remote);
        }
        const worktree = await add(branch);
        await commit(worktree, `${slug(branch)}.1.txt`, "pushed\n");
        await git(worktree, "push", "-q", "-u", "origin", branch);
        await commit(worktree, `${slug(branch)}.2.txt`, "not pushed\n");
        return built(branch, worktree, {
          verdict: "Review",
          status: "unpushed commits",
          reason: "1 commit isn't pushed.",
        });
      },
      async lockedWorktree(branch, { reason = "agent session" } = {}) {
        const worktree = await add(branch);
        await git(path, "worktree", "lock", ...(reason ? ["--reason", reason] : []), worktree);
        return built(branch, worktree, {
          verdict: "Review",
          status: "locked",
          reason: reason ? `Locked: ${reason}` : "Locked, with no reason given.",
          blocked: true,
        });
      },
      async rebasingWorktree(branch) {
        const worktree = await add(branch);
        await conflict(worktree, branch, "rebase");
        return built(branch, worktree, {
          verdict: "Busy",
          status: "rebase in progress",
          reason: "A rebase was started here and isn't finished.",
          blocked: true,
        });
      },
      async conflictedWorktree(branch) {
        const worktree = await add(branch);
        await conflict(worktree, branch, "merge");
        return built(branch, worktree, {
          verdict: "Busy",
          status: "unresolved conflicts",
          reason: "Some files still have merge conflicts.",
          blocked: true,
        });
      },
      async deletedWorktree(branch) {
        const worktree = await add(branch);
        await rm(worktree, { recursive: true, force: true });
        return built(branch, worktree, {
          verdict: "Broken",
          status: "folder missing",
          reason: "The folder is gone, but Git still lists the worktree.",
          blocked: true,
        });
      },
      async markedWorktree(branch, { marker, ageMs = 0 }) {
        movesMain("markedWorktree");
        const worktree = await squashMerged(branch);
        const epoch = ageMs
          ? { WORKTRUNK_TEST_EPOCH: String(Math.floor((Date.now() - ageMs) / 1000)) }
          : undefined;
        await check(wtPath, ["config", "state", "marker", "set", marker], {
          cwd: worktree,
          env: epoch,
        });
        const activity = marker === "🤖" ? "working" : "waiting for input";
        if (ageMs >= DAY_MS)
          return built(branch, worktree, {
            verdict: "Safe",
            status: "merged",
            reason: squashReason,
            note: `Agent mark from ${ago(ageMs)}, likely stale.`,
          });
        const reason = `An agent was ${activity} here ${ago(ageMs)}.`;
        return built(branch, worktree, {
          verdict: "Review",
          status: "merged",
          reason,
          note: reason,
        });
      },
      async sizedWorktree(branch, { kib = 2048 } = {}) {
        movesMain("sizedWorktree");
        const worktree = await squashMerged(branch);
        const modules = Math.ceil((kib * 3) / 4);
        await mkdir(join(worktree, "node_modules", "pkg"), { recursive: true });
        await mkdir(join(worktree, "dist"));
        await writeFile(
          join(worktree, "node_modules", "pkg", "index.bin"),
          randomBytes(modules * 1024),
        );
        await writeFile(join(worktree, "dist", "bundle.bin"), randomBytes((kib - modules) * 1024));
        return {
          ...built(branch, worktree, { verdict: "Safe", status: "merged", reason: squashReason }),
          minSizeKiB: kib,
        };
      },
      async mergedBranch(branch, { ageMs = OLD_AGE_MS } = {}) {
        movesMain("mergedBranch");
        const env = dated(ageMs);
        const worktree = await add(branch, env);
        await commit(worktree, `${slug(branch)}.txt`, `${branch}\n`, env);
        await git(path, "worktree", "remove", worktree);
        await check("git", ["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch], {
          cwd: path,
          env,
        });
        return built(branch, null, {
          verdict: ageMs < DAY_MS ? "Review" : "Safe",
          status: "merged",
          reason:
            ageMs < DAY_MS
              ? `Created ${ago(ageMs)}, so it may still be in use.`
              : "Its commits are already in main.",
        });
      },
      async unmergedBranch(branch) {
        pin("unmergedBranch");
        const env = dated(OLD_AGE_MS);
        const worktree = await add(branch, env);
        await commit(worktree, `${slug(branch)}.txt`, `${branch}\n`, env);
        await git(path, "worktree", "remove", worktree);
        return built(branch, null, {
          verdict: "Review",
          status: "unmerged commits",
          reason: "1 commit isn't in main.",
        });
      },
    };
  }

  async function services(
    options: { runner?: CommandRunner; sources?: RepoSource[]; savedRepos?: SavedRepos } = {},
  ): Promise<Services> {
    const app = await createServices({
      home,
      sources: options.sources ?? [{ kind: "scan", folder: scanRoot }],
      depth: 2,
      wtPath,
      runner: options.runner ?? runner,
      readCreated,
      savedRepos: options.savedRepos,
    });
    const service: Services = {
      ...app,
      async close() {
        if (!opened.delete(service)) return;
        await app.close();
      },
    };
    opened.add(service);
    return service;
  }

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    await Promise.all([...opened].map((service) => service.close()));
    // Worktrees outside the sandbox folder survive its rm, so remove them through Git.
    const outside: string[] = [];
    const found = await discoverRepos(scanRoot, 3).catch(() => []);
    for (const repoPath of new Set([...repos, ...found])) {
      const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoPath }).catch(
        () => null,
      );
      for (const line of list?.stdout.split("\n") ?? []) {
        const worktree = line.startsWith("worktree ") ? line.slice(9) : null;
        if (!worktree || worktree === repoPath || worktree.startsWith(root + sep)) continue;
        await exec("git", ["worktree", "unlock", worktree], { cwd: repoPath });
        await exec("git", ["worktree", "remove", "--force", "--force", worktree], {
          cwd: repoPath,
        });
        if (
          await stat(worktree).then(
            () => true,
            () => false,
          )
        )
          outside.push(worktree);
      }
    }
    if (options.root === undefined && !root.startsWith(join(await realpath(tmpdir()), prefix)))
      throw new Error(`Refusing to delete ${root}: not a sandbox folder`);
    await rm(root, { recursive: true, force: true });
    if (outside.length)
      throw new Error(`Worktrees outside the sandbox could not be removed: ${outside.join(", ")}`);
  }

  return {
    root,
    home,
    scanRoot,
    env,
    wtPath,
    cacheDir,
    backdatesOnDisk,
    runner,
    readCreated,
    exec: (command, args, options) => exec(command, args, options),
    git,
    wt,
    repo,
    services,
    cleanup,
  };
}

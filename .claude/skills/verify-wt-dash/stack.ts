#!/usr/bin/env bun
/**
 * Manages named wt-dash verification instances: a seeded sandbox under .verify/<name>/ and the app running in a
 * tmux session on a private socket. It never drives the app; the agent does that with tmux itself.
 * Every command prints exactly one JSON object.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  createSandbox,
  OLD_AGE_MS,
  type Built,
  type Repo,
  type Sandbox,
} from "../../../tests/support/fixture";

const repoRoot = resolve(import.meta.dir, "../../..");
const verifyRoot = join(repoRoot, ".verify");
const self = ".claude/skills/verify-wt-dash/stack.ts";
const VARIANTS = { wide: { cols: 120, rows: 32 }, narrow: { cols: 80, rows: 24 } } as const;
type Variant = keyof typeof VARIANTS;
const READY = /scanned \d\d:\d\d/;
const READY_TIMEOUT_MS = 90_000;

class Failure extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface SeedRow {
  repo: string;
  kind: Built["kind"];
  branch: string;
  path: string | null;
  verdict: string;
  status: string;
  reason: string;
  blocked: boolean;
  note?: string;
  minSizeKiB?: number;
}

/**
 * What a `--seed <file>` module's default export returns after building its world in the sandbox: the rows it
 * made, and optionally another scan root and variables added to the app's environment.
 */
export interface SeedWorld {
  rows: SeedRow[];
  scanRoot?: string;
  env?: Record<string, string>;
}

export type SeedModule = (sandbox: Sandbox) => Promise<SeedWorld>;

interface Instance {
  name: string;
  branch: string;
  commit: string;
  variant: Variant;
  socket: string;
  createdAt: string;
  startedAt: string | null;
  serverPid: number | null;
  panePid: number | null;
  sandbox: string;
  scanRoot: string;
  env: Record<string, string>;
  backdatesOnDisk: boolean;
  /** The `--seed` module, or null for the default seed. */
  seedFile?: string | null;
  seed: SeedRow[];
}

function print(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value, null, 2));
}

function run(
  argv: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(argv, {
    env: options.env ?? (process.env as Record<string, string>),
    cwd: options.cwd ?? repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function gitHere(...args: string[]): string {
  return run(["git", ...args]).stdout.trim();
}

function parseFlags(args: string[]): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index++;
    } else flags[key] = true;
  }
  return { flags, rest };
}

function nameFrom(flags: Record<string, string | true>): string {
  const name = flags.name;
  if (typeof name !== "string")
    throw new Failure("--name <name> is required.", `Example: bun ${self} up --name my-task`);
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(name))
    throw new Failure(
      `Invalid instance name: ${name}`,
      "Use 1-24 lowercase letters, digits and dashes, starting with a letter or digit.",
    );
  return name;
}

function socketFor(name: string): string {
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 6);
  return `wt-dash-verify-${name}-${hash}`;
}

const paths = (name: string) => {
  const dir = join(verifyRoot, name);
  return {
    dir,
    sandbox: join(dir, "sandbox"),
    instance: join(dir, "instance.json"),
    logs: join(dir, "logs"),
    appLog: join(dir, "logs", "app.log"),
    stackLog: join(dir, "logs", "stack.log"),
    evidence: join(dir, "evidence"),
    tmuxConf: join(dir, "tmux.conf"),
  };
};

async function readInstance(name: string): Promise<Instance | null> {
  const file = paths(name).instance;
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as Instance;
}

async function saveInstance(instance: Instance): Promise<void> {
  await writeFile(paths(instance.name).instance, `${JSON.stringify(instance, null, 2)}\n`);
}

async function log(name: string, event: Record<string, unknown>): Promise<void> {
  const { logs, stackLog } = paths(name);
  await mkdir(logs, { recursive: true });
  await appendFile(stackLog, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function tmuxBin(): string {
  const found = Bun.which("tmux");
  if (!found)
    throw new Failure("tmux was not found on PATH.", "Install it (brew install tmux) and retry.");
  return found;
}

function tmux(socket: string, ...args: string[]) {
  return run([tmuxBin(), "-L", socket, ...args]);
}

function paneInfo(socket: string): {
  dead: boolean;
  deadStatus: string;
  panePid: number;
  serverPid: number;
  size: string;
} | null {
  const result = tmux(
    socket,
    "display-message",
    "-p",
    "-t",
    "app",
    "#{pane_dead}|#{pane_dead_status}|#{pane_pid}|#{pid}|#{window_width}x#{window_height}",
  );
  if (result.code !== 0) return null;
  const [dead, deadStatus, panePid, serverPid, size] = result.stdout.trim().split("|");
  return {
    dead: dead === "1",
    deadStatus: deadStatus ?? "",
    panePid: Number(panePid),
    serverPid: Number(serverPid),
    size: size ?? "",
  };
}

function capture(socket: string, ansi = false): string {
  const result = tmux(socket, "capture-pane", "-p", ...(ansi ? ["-e"] : []), "-t", "app");
  return result.code === 0 ? result.stdout : "";
}

function tail(file: string, lines: number): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trimEnd().split("\n").filter(Boolean).slice(-lines);
}

function inside(child: string, parent: string): boolean {
  return child.startsWith(parent + sep);
}

/** Processes in a process group whose command line names the instance folder. */
function groupMembers(pgid: number, dir: string): Array<{ pid: number; command: string }> {
  const listed = run(["pgrep", "-g", String(pgid)]);
  const members: Array<{ pid: number; command: string }> = [];
  for (const pid of listed.stdout.split("\n").filter(Boolean).map(Number)) {
    const command = run(["ps", "-o", "command=", "-p", String(pid)]).stdout.trim();
    if (command.includes(dir)) members.push({ pid, command });
  }
  return members;
}

function processGroup(pid: number): number | null {
  const pgid = Number(run(["ps", "-o", "pgid=", "-p", String(pid)]).stdout.trim());
  return pgid > 0 ? pgid : null;
}

async function waitUntilReady(
  socket: string,
  appLog: string,
): Promise<{ header: string; ms: number }> {
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    const info = paneInfo(socket);
    if (!info || info.dead)
      throw new Failure(
        `wt-dash exited before it was ready (status ${info?.deadStatus || "unknown"}).`,
        "Read the screen and the app log below, fix the cause, then run down and up again.",
        { screen: capture(socket).trimEnd().split("\n"), appLog: tail(appLog, 20) },
      );
    const header = capture(socket).split("\n")[0] ?? "";
    if (READY.test(header)) return { header: header.trim(), ms: Date.now() - started };
    await Bun.sleep(100);
  }
  throw new Failure(
    `wt-dash did not finish listing within ${READY_TIMEOUT_MS / 1000}s.`,
    "Check the screen below and the app log; run doctor, then down and up again.",
    { screen: capture(socket).trimEnd().split("\n"), appLog: tail(appLog, 20) },
  );
}

async function seed(
  root: string,
  seedFile: string | null,
): Promise<{
  scanRoot: string;
  env: Record<string, string>;
  backdatesOnDisk: boolean;
  rows: SeedRow[];
}> {
  const sandbox = await createSandbox({ root });
  const world = seedFile
    ? await ((await import(seedFile)) as { default: SeedModule }).default(sandbox)
    : { rows: await defaultSeed(sandbox) };
  const env: Record<string, string> = { ...sandbox.env, ...world.env };
  delete env.NO_COLOR;
  env.LC_ALL = "en_US.UTF-8";
  env.LANG = "en_US.UTF-8";
  env.COLORTERM = "truecolor";
  return {
    scanRoot: world.scanRoot ?? sandbox.scanRoot,
    env,
    backdatesOnDisk: sandbox.backdatesOnDisk,
    rows: world.rows,
  };
}

async function defaultSeed(sandbox: Sandbox): Promise<SeedRow[]> {
  const inRepo = async (name: string, build: (repo: Repo) => Promise<Built[]>) =>
    build(await sandbox.repo(name));
  const sequence = async (repo: Repo, steps: Array<(repo: Repo) => Promise<Built>>) => {
    const out: Built[] = [];
    for (const step of steps) out.push(await step(repo));
    return out;
  };
  const groups = await Promise.all([
    inRepo("api", (repo) =>
      sequence(repo, [
        (r) => r.sizedWorktree("feature/assets", { kib: 12_288 }),
        (r) => r.mergedWorktree("feature/login"),
        (r) => r.markedWorktree("agent/refactor", { marker: "🤖" }),
        (r) => r.markedWorktree("agent/old-session", { marker: "💬", ageMs: OLD_AGE_MS }),
        (r) => r.mergedBranch("leftover/hotfix"),
        (r) => r.freshWorktree("feature/new-endpoint"),
        (r) => r.dirtyWorktree("feature/dirty-form"),
        (r) => r.lockedWorktree("feature/locked"),
        (r) => r.unmergedBranch("leftover/spike"),
      ]),
    ),
    inRepo("web", (repo) =>
      sequence(repo, [
        (r) => r.squashMergedWorktree("fix/header"),
        (r) => r.sizedWorktree("feature/bundle", { kib: 4096 }),
        (r) => r.unmergedWorktree("feature/search", { commits: 2 }),
        (r) => r.unpushedWorktree("feature/cache"),
        (r) => r.rebasingWorktree("feature/rebase"),
        (r) => r.deletedWorktree("feature/gone"),
      ]),
    ),
    inRepo("docs", (repo) =>
      sequence(repo, [
        (r) => r.mergedWorktree("docs/typos"),
        (r) => r.conflictedWorktree("docs/conflict"),
        (r) => r.lockedWorktree("docs/locked-bare", { reason: null }),
      ]),
    ),
    inRepo("tools", async () => []),
  ]);
  return groups.flat().map((built) => {
    let expected = built.expected;
    // Without on-disk backdating (Linux) the real binary sees mergedWorktree's worktree as new.
    if (
      !sandbox.backdatesOnDisk &&
      built.kind === "worktree" &&
      expected.reason === "Its commits are already in main."
    )
      expected = {
        ...expected,
        verdict: "Review",
        reason: "Created just now, so it may still be in use.",
      };
    return {
      repo: built.repo.split("/").at(-1)!,
      kind: built.kind,
      branch: built.branch,
      path: built.path,
      ...expected,
      ...(built.minSizeKiB === undefined ? {} : { minSizeKiB: built.minSizeKiB }),
    };
  });
}

async function startApp(instance: Instance): Promise<void> {
  const p = paths(instance.name);
  const { cols, rows } = VARIANTS[instance.variant];
  await writeFile(
    p.tmuxConf,
    [
      "set -g status off",
      "set -g remain-on-exit on",
      'set -g default-terminal "tmux-256color"',
      "set -s escape-time 0",
      "set -g history-limit 5000",
      "",
    ].join("\n"),
  );
  const command = `exec "$0" "$@" 2>>'${p.appLog.replaceAll("'", "'\\''")}'`;
  const started = run(
    [
      tmuxBin(),
      "-L",
      instance.socket,
      "-f",
      p.tmuxConf,
      "new-session",
      "-d",
      "-s",
      "app",
      "-x",
      String(cols),
      "-y",
      String(rows),
      "-c",
      instance.env.HOME!,
      "/bin/sh",
      "-c",
      command,
      process.execPath,
      join(repoRoot, "src", "index.ts"),
      instance.scanRoot,
      // In the config file this option crashes tmux 3.6a's server before the first session exists.
      ";",
      "set-option",
      "-g",
      "window-size",
      "manual",
    ],
    { env: instance.env },
  );
  if (started.code !== 0)
    throw new Failure(`tmux could not start the app: ${started.stderr.trim()}`, "Run doctor.");
  const info = paneInfo(instance.socket);
  instance.serverPid = info?.serverPid ?? null;
  instance.panePid = info?.panePid ?? null;
  instance.startedAt = new Date().toISOString();
  await saveInstance(instance);
}

async function up(flags: Record<string, string | true>) {
  const name = nameFrom(flags);
  const variantFlag = flags.variant;
  if (variantFlag !== undefined && variantFlag !== "wide" && variantFlag !== "narrow")
    throw new Failure(
      `Unknown variant: ${String(variantFlag)}`,
      "Use --variant wide or --variant narrow.",
    );
  const p = paths(name);
  const branch = gitHere("rev-parse", "--abbrev-ref", "HEAD");
  const commit = gitHere("rev-parse", "--short", "HEAD");
  let instance = await readInstance(name);
  if (instance && instance.branch !== branch)
    throw new Failure(
      `Instance ${name} was started on branch ${instance.branch}; this checkout is on ${branch}.`,
      `Recreate it: bun ${self} down --name ${name} --purge, then up again.`,
    );
  if (flags.seed === true)
    throw new Failure("--seed needs a file.", "Example: --seed scripts/readme-images/seed.ts");
  const seedFile = typeof flags.seed === "string" ? resolve(flags.seed) : null;
  if (seedFile && !existsSync(seedFile))
    throw new Failure(`Seed module not found: ${seedFile}`, "Pass a path to a .ts seed module.");
  if (instance && flags.seed !== undefined && (instance.seedFile ?? null) !== seedFile)
    throw new Failure(
      `Instance ${name} was seeded from ${instance.seedFile ?? "the default seed"}.`,
      `Recreate it: bun ${self} down --name ${name} --purge, then up again.`,
    );
  const variant: Variant = variantFlag ?? instance?.variant ?? "wide";
  let seeded = false;
  if (!instance) {
    if (existsSync(p.sandbox))
      throw new Failure(
        `${p.sandbox} exists without instance.json.`,
        `Remove it with bun ${self} down --name ${name} --purge, then up again.`,
      );
    await mkdir(p.logs, { recursive: true });
    await mkdir(p.evidence, { recursive: true });
    const started = Date.now();
    const seededWorld = await seed(p.sandbox, seedFile);
    seeded = true;
    instance = {
      name,
      branch,
      commit,
      variant,
      socket: socketFor(name),
      createdAt: new Date().toISOString(),
      startedAt: null,
      serverPid: null,
      panePid: null,
      sandbox: p.sandbox,
      scanRoot: seededWorld.scanRoot,
      env: seededWorld.env,
      backdatesOnDisk: seededWorld.backdatesOnDisk,
      seedFile,
      seed: seededWorld.rows,
    };
    await saveInstance(instance);
    await log(name, { event: "seeded", ms: Date.now() - started, rows: seededWorld.rows.length });
  }
  const info = paneInfo(instance.socket);
  let reused = false;
  let resized = false;
  if (info && !info.dead) {
    reused = true;
    if (instance.variant !== variant) {
      const { cols, rows } = VARIANTS[variant];
      tmux(instance.socket, "resize-window", "-t", "app", "-x", String(cols), "-y", String(rows));
      instance.variant = variant;
      await saveInstance(instance);
      resized = true;
    }
  } else {
    if (info?.dead) tmux(instance.socket, "kill-server");
    instance.variant = variant;
    await startApp(instance);
  }
  const ready = await waitUntilReady(instance.socket, p.appLog);
  const size = paneInfo(instance.socket)?.size;
  await log(name, { event: "up", reused, resized, seeded, variant, readyMs: ready.ms });
  return {
    name,
    reused,
    seeded,
    resized,
    variant,
    size,
    branch: instance.branch,
    header: ready.header,
    readyMs: ready.ms,
    tmux: `tmux -L ${instance.socket}`,
    next: `bun ${self} env --name ${name}`,
  };
}

async function requireInstance(name: string): Promise<Instance> {
  const instance = await readInstance(name);
  if (!instance)
    throw new Failure(`No instance named ${name}.`, `Start one: bun ${self} up --name ${name}`);
  return instance;
}

async function env(flags: Record<string, string | true>) {
  const name = nameFrom(flags);
  const instance = await requireInstance(name);
  const p = paths(name);
  const full = flags.full === true;
  const t = `tmux -L ${instance.socket}`;
  const { cols, rows } = VARIANTS[instance.variant];
  return {
    name,
    variant: instance.variant,
    size: `${cols}x${rows}`,
    tmux: t,
    target: "app",
    // Shell helpers for one Bash call (bash or zsh): eval "$(bun <stack> env --name <n> | jq -r .preamble)".
    // wait_for and wait_gone poll the screen every 100 ms for up to 10 s; they read, never press.
    preamble: [
      `t() { ${t} "$@"; }`,
      "screen() { t capture-pane -p -t app; }",
      `wait_for() { for _ in $(seq 100); do screen | grep -qF -- "$1" && return 0; sleep 0.1; done; echo "TIMEOUT waiting for: $1" >&2; return 1; }`,
      `wait_gone() { for _ in $(seq 100); do screen | grep -qF -- "$1" || return 0; sleep 0.1; done; echo "TIMEOUT still on screen: $1" >&2; return 1; }`,
    ].join("; "),
    commands: {
      screen: `${t} capture-pane -p -t app`,
      screenWithColors: `${t} capture-pane -p -e -t app`,
      sendKeys: `${t} send-keys -t app <keys>   # e.g. Down, Up, Left, Right, Enter, Escape, Space, Tab, BTab, a, x, /`,
      sendText: `${t} send-keys -t app -l '<text>'`,
      resizeWide: `${t} resize-window -t app -x ${VARIANTS.wide.cols} -y ${VARIANTS.wide.rows}`,
      resizeNarrow: `${t} resize-window -t app -x ${VARIANTS.narrow.cols} -y ${VARIANTS.narrow.rows}`,
      watchReadOnly: `${t} attach -r -t app`,
      state: `bun ${self} state --name ${name}`,
      image: `bun ${self} image --name ${name} --out <feature>-<state>-<variant> [--from <capture.ansi>] [--rows a-b] [--cols a-b]`,
    },
    ...(full ? { env: instance.env } : {}),
    // Run git or wt as the instance's user, to arrange a precondition: eval this in the same shell call.
    exports: `eval "$(bun ${self} env --name ${name} --full | jq -r '.env | to_entries[] | "export \\(.key)=\\(.value | @sh)"')"`,
    paths: {
      instance: p.dir,
      sandbox: instance.sandbox,
      scanRoot: instance.scanRoot,
      home: instance.env.HOME,
      worktrees: join(instance.sandbox, "worktrees"),
      removalsLog: join(instance.env.HOME!, ".cache", "wt-dash", "removals.log"),
      sizes: join(instance.env.HOME!, ".cache", "wt-dash", "sizes.json"),
      appLog: p.appLog,
      evidence: p.evidence,
    },
    backdatesOnDisk: instance.backdatesOnDisk,
    ...(full
      ? { seed: instance.seed }
      : {
          more: `--full adds env (the instance environment) and seed (every seeded row with its expected verdict, status and reason)`,
        }),
  };
}

async function doctor(flags: Record<string, string | true>) {
  const name = nameFrom(flags);
  const instance = await requireInstance(name);
  const p = paths(name);
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
  const branch = gitHere("rev-parse", "--abbrev-ref", "HEAD");
  const commit = gitHere("rev-parse", "--short", "HEAD");
  add("branch", branch === instance.branch, `started on ${instance.branch}, checkout on ${branch}`);
  add("sandbox", existsSync(instance.scanRoot), instance.scanRoot);
  const tmuxPath = Bun.which("tmux");
  add("tmux", tmuxPath !== null, tmuxPath ?? "not on PATH");
  const info = tmuxPath ? paneInfo(instance.socket) : null;
  add(
    "server",
    info !== null,
    info ? `pid ${info.serverPid} on socket ${instance.socket}` : "not running",
  );
  if (info) {
    add(
      "app",
      !info.dead,
      info.dead ? `exited with ${info.deadStatus}` : `pane pid ${info.panePid}`,
    );
    const { cols, rows } = VARIANTS[instance.variant];
    add(
      "size",
      info.size === `${cols}x${rows}`,
      `${info.size} (variant ${instance.variant} is ${cols}x${rows})`,
    );
    const header = capture(instance.socket).split("\n")[0]?.trim() ?? "";
    add("listed", READY.test(header), header);
  }
  const wt = run([
    instance.env.PATH ? (Bun.which("wt", { PATH: instance.env.PATH }) ?? "wt") : "wt",
    "--version",
  ]);
  add("worktrunk", wt.code === 0, (wt.stdout || wt.stderr).trim());
  const browser = Bun.which("agent-browser");
  checks.push({
    check: "agent-browser (PR images)",
    ok: true,
    detail: browser ?? "missing: PR images unavailable",
  });
  const failed = checks.filter((check) => !check.ok);
  const result = {
    name,
    healthy: failed.length === 0,
    commitNow: commit,
    commitAtUp: instance.commit,
    checks,
    appLog: tail(p.appLog, 5),
  };
  if (failed.length)
    throw new Failure(
      `Instance ${name} is not usable: ${failed.map((check) => check.check).join(", ")}.`,
      failed.some((check) => check.check === "branch")
        ? `Recreate it: bun ${self} down --name ${name} --purge, then up.`
        : `Run bun ${self} up --name ${name}; it restarts a stopped app on the same data.`,
      result,
    );
  return result;
}

function parseWorktrees(porcelain: string) {
  return porcelain
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const entry: Record<string, string | boolean> = {};
      for (const line of block.split("\n")) {
        const [key, ...value] = line.split(" ");
        entry[key!] = value.length ? value.join(" ") : true;
      }
      return {
        path: entry.worktree as string,
        branch: typeof entry.branch === "string" ? entry.branch.replace("refs/heads/", "") : null,
        head: typeof entry.HEAD === "string" ? entry.HEAD.slice(0, 7) : null,
        ...(entry.locked !== undefined ? { locked: entry.locked } : {}),
        ...(entry.prunable !== undefined ? { prunable: entry.prunable } : {}),
        exists: existsSync(entry.worktree as string),
      };
    });
}

async function state(flags: Record<string, string | true>) {
  const name = nameFrom(flags);
  const instance = await requireInstance(name);
  const lines = typeof flags.log === "string" ? Number(flags.log) : 20;
  const repos: Record<string, unknown> = {};
  const names = (await readdir(instance.scanRoot)).sort();
  for (const repo of names) {
    const cwd = join(instance.scanRoot, repo);
    if (!existsSync(join(cwd, ".git"))) continue;
    const list = run(["git", "worktree", "list", "--porcelain"], { env: instance.env, cwd });
    const branches = run(["git", "branch", "--format=%(refname:short)"], {
      env: instance.env,
      cwd,
    });
    repos[repo] = {
      worktrees: parseWorktrees(list.stdout),
      branches: branches.stdout.trim().split("\n").filter(Boolean),
    };
  }
  const removalsLog = join(instance.env.HOME!, ".cache", "wt-dash", "removals.log");
  const removals = tail(removalsLog, lines).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return line;
    }
  });
  return { name, repos, removalsLog: removals };
}

const PALETTE = [
  "#1d1f21",
  "#cc6666",
  "#b5bd68",
  "#f0c674",
  "#81a2be",
  "#b294bb",
  "#8abeb7",
  "#c5c8c6",
  "#969896",
  "#d54e53",
  "#b9ca4a",
  "#e7c547",
  "#7aa6da",
  "#c397d8",
  "#70c0b1",
  "#eaeaea",
];
const DEFAULT_FG = "#c5c8c6";
const DEFAULT_BG = "#1d1f21";

function color256(index: number): string {
  if (index < 16) return PALETTE[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const n = index - 16;
  const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return `rgb(${level(Math.floor(n / 36))},${level(Math.floor(n / 6) % 6)},${level(n % 6)})`;
}

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
  strike: boolean;
}

const plain = (): Style => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  reverse: false,
  strike: false,
});

function applySgr(style: Style, params: number[]): void {
  if (!params.length) params = [0];
  for (let index = 0; index < params.length; index++) {
    const code = params[index]!;
    if (code === 0) Object.assign(style, plain());
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.reverse = true;
    else if (code === 9) style.strike = true;
    else if (code === 22) style.bold = style.dim = false;
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.reverse = false;
    else if (code === 29) style.strike = false;
    else if (code >= 30 && code <= 37) style.fg = PALETTE[code - 30]!;
    else if (code >= 90 && code <= 97) style.fg = PALETTE[code - 82]!;
    else if (code >= 40 && code <= 47) style.bg = PALETTE[code - 40]!;
    else if (code >= 100 && code <= 107) style.bg = PALETTE[code - 92]!;
    else if (code === 39) style.fg = null;
    else if (code === 49) style.bg = null;
    else if (code === 38 || code === 48) {
      let value: string | null = null;
      if (params[index + 1] === 5) {
        value = color256(params[index + 2] ?? 0);
        index += 2;
      } else if (params[index + 1] === 2) {
        value = `rgb(${params[index + 2] ?? 0},${params[index + 3] ?? 0},${params[index + 4] ?? 0})`;
        index += 4;
      }
      if (code === 38) style.fg = value;
      else style.bg = value;
    }
  }
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function css(style: Style): string {
  let fg = style.fg ?? DEFAULT_FG;
  let bg = style.bg;
  if (style.reverse) [fg, bg] = [bg ?? DEFAULT_BG, fg];
  const rules = [`color:${fg}`];
  if (bg) rules.push(`background:${bg}`);
  if (style.bold) rules.push("font-weight:bold");
  if (style.dim) rules.push("opacity:0.6");
  if (style.italic) rules.push("font-style:italic");
  const lines = [style.underline && "underline", style.strike && "line-through"].filter(Boolean);
  if (lines.length) rules.push(`text-decoration:${lines.join(" ")}`);
  return rules.join(";");
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** `rows` and `cols` crop the capture, 1-based and inclusive; null keeps everything. */
function ansiToHtml(
  capture: string,
  rows: [number, number] | null,
  cols: [number, number] | null,
  width: number,
): string {
  const lines = capture.replace(/\n$/, "").split("\n");
  const [firstRow, lastRow] = rows ?? [1, lines.length];
  const [firstCol, lastCol] = cols ?? [1, width];
  const style = plain();
  const out: string[] = [];
  lines.forEach((line, lineIndex) => {
    const keep = lineIndex + 1 >= firstRow && lineIndex + 1 <= lastRow;
    let cell = 1;
    let html = "";
    let open: string | null = null;
    const emit = (text: string, cells: number) => {
      const start = cell;
      cell += cells;
      if (!keep || start < firstCol || start + cells - 1 > lastCol) return;
      const look = css(style);
      if (look !== open) {
        if (open !== null) html += "</span>";
        html += `<span style="${look}">`;
        open = look;
      }
      html += cells === 2 ? `<i class="w">${escapeHtml(text)}</i>` : escapeHtml(text);
    };
    // oxlint-disable-next-line no-control-regex -- ANSI escapes are the input
    const pattern = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
    let last = 0;
    const text = (chunk: string) => {
      for (const { segment } of segmenter.segment(chunk))
        emit(segment, Math.max(1, Bun.stringWidth(segment)));
    };
    for (const match of line.matchAll(pattern)) {
      text(line.slice(last, match.index));
      if (match[1] !== undefined)
        applySgr(style, match[1] ? match[1].split(/[;:]/).map(Number) : []);
      last = match.index + match[0].length;
    }
    text(line.slice(last));
    // Pad to the crop width so backgrounds and the frame stay rectangular.
    const end = Math.min(lastCol, width);
    if (keep && cell <= end) {
      const saved = { ...style };
      Object.assign(style, plain());
      emit(" ".repeat(end - Math.max(cell, firstCol) + 1), 0);
      Object.assign(style, saved);
    }
    if (open !== null) html += "</span>";
    if (keep) out.push(html);
  });
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#888;}
#screen{display:inline-block;padding:12px 14px;background:${DEFAULT_BG};color:${DEFAULT_FG};
font:14px/1.2 Menlo,"SF Mono",Monaco,"DejaVu Sans Mono",monospace;white-space:pre;}
#screen i.w{display:inline-block;width:2ch;font-style:normal;text-align:center;overflow:hidden;vertical-align:top;}
#screen div{height:1.2em;}
</style><div id="screen">${out.map((line) => `<div>${line}</div>`).join("")}</div>`;
}

function range(value: string | true | undefined, label: string): [number, number] | null {
  if (value === undefined) return null;
  const match = typeof value === "string" ? /^(\d+)-(\d+)$/.exec(value) : null;
  if (!match || Number(match[1]) < 1 || Number(match[2]) < Number(match[1]))
    throw new Failure(`--${label} must look like 3-12 (1-based, inclusive).`, "Fix the range.");
  return [Number(match[1]), Number(match[2])];
}

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function image(flags: Record<string, string | true>) {
  const name = nameFrom(flags);
  const instance = await requireInstance(name);
  const p = paths(name);
  const out = flags.out;
  if (typeof out !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(out))
    throw new Failure(
      "--out <feature>-<state>-<variant> is required, in kebab-case without an extension.",
      "Example: --out remove-dialog-open-wide",
    );
  const browser = Bun.which("agent-browser");
  if (!browser)
    throw new Failure(
      "agent-browser was not found on PATH.",
      "Install it to make PR images; the instance works without it.",
    );
  let source: string;
  let from: string;
  if (typeof flags.from === "string") {
    from = resolve(flags.from);
    source = await readFile(from, "utf8");
  } else {
    source = capture(instance.socket, true);
    if (!source)
      throw new Failure("Could not capture the pane.", `Run bun ${self} doctor --name ${name}.`);
    from = join(p.evidence, `${out}.ansi`);
    await writeFile(from, source);
  }
  const widthCells =
    Number(paneInfo(instance.socket)?.size.split("x")[0]) || VARIANTS[instance.variant].cols;
  const html = ansiToHtml(source, range(flags.rows, "rows"), range(flags.cols, "cols"), widthCells);
  await mkdir(p.evidence, { recursive: true });
  const htmlPath = join(p.evidence, `${out}.html`);
  const pngPath = join(p.evidence, `${out}.png`);
  await writeFile(htmlPath, html);
  const session = socketFor(name);
  const steps = [
    ["open", `file://${htmlPath}`],
    ["set", "viewport", "1400", "1000", "2"],
    ["screenshot", "#screen", pngPath],
    ["close"],
  ];
  for (const step of steps) {
    const result = run([browser, "--session", session, ...step]);
    if (result.code !== 0) {
      run([browser, "--session", session, "close"]);
      throw new Failure(
        `agent-browser ${step[0]} failed: ${(result.stderr || result.stdout).trim()}`,
        "Run agent-browser doctor, then retry.",
      );
    }
  }
  return { name, png: pngPath, html: htmlPath, capture: from, pixels: pngSize(pngPath) };
}

async function down(flags: Record<string, string | true>) {
  const name = nameFrom(flags);
  const dryRun = flags["dry-run"] === true;
  const purge = flags.purge === true;
  const p = paths(name);
  const instance = await readInstance(name);
  const socket = instance?.socket ?? socketFor(name);
  const stopped: string[] = [];
  const info = Bun.which("tmux") ? paneInfo(socket) : null;
  const pgid = instance?.panePid ? processGroup(instance.panePid) : null;
  if (info) {
    stopped.push(`tmux server ${info.serverPid} on socket ${socket} (app pane ${info.panePid})`);
    if (!dryRun) tmux(socket, "kill-server");
  }
  // The app and anything it spawned (wt, git, du) share the pane's process group.
  if (pgid && instance?.panePid === pgid) {
    const deadline = Date.now() + 3000;
    let members = groupMembers(pgid, p.dir);
    while (!dryRun && members.length && Date.now() < deadline) {
      await Bun.sleep(100);
      members = groupMembers(pgid, p.dir);
    }
    for (const member of members) {
      stopped.push(`pid ${member.pid}: ${member.command}`);
      if (!dryRun) process.kill(member.pid, "SIGKILL");
    }
  }
  const browser = Bun.which("agent-browser");
  if (browser) {
    const sessions = run([browser, "session", "list"]).stdout;
    if (sessions.includes(socket)) {
      stopped.push(`agent-browser session ${socket}`);
      if (!dryRun) run([browser, "--session", socket, "close"]);
    }
  }
  const deleted: string[] = [];
  if (purge) {
    for (const target of [p.sandbox, p.instance, p.tmuxConf]) {
      if (!inside(target, verifyRoot) || !existsSync(target)) continue;
      deleted.push(target);
      if (!dryRun) await rm(target, { recursive: true, force: true });
    }
  } else if (instance && !dryRun) {
    instance.startedAt = null;
    instance.serverPid = null;
    instance.panePid = null;
    await saveInstance(instance);
  }
  if (!dryRun) await log(name, { event: "down", purge, stopped, deleted });
  return {
    name,
    dryRun,
    stopped,
    deleted,
    kept: [p.logs, p.evidence].filter((dir) => existsSync(dir)),
  };
}

async function list() {
  const names = existsSync(verifyRoot) ? (await readdir(verifyRoot)).sort() : [];
  const instances = [];
  for (const name of names) {
    const instance = existsSync(paths(name).instance) ? await readInstance(name) : null;
    const info = instance && Bun.which("tmux") ? paneInfo(instance.socket) : null;
    instances.push({
      name,
      seeded: instance !== null,
      branch: instance?.branch ?? null,
      variant: instance?.variant ?? null,
      running: info !== null && !info.dead,
      evidence: existsSync(paths(name).evidence) ? (await readdir(paths(name).evidence)).length : 0,
    });
  }
  return { root: verifyRoot, instances };
}

const COMMANDS = {
  up: "up --name <n> [--variant wide|narrow] [--seed <file>]  Seed if new, start wt-dash in tmux, wait until listed. Reuses a running instance (resizing it to the variant). --seed builds the sandbox with a module's default export (SeedModule) instead of the test fixture's seed.",
  env: "env --name <n> [--full]  The shell preamble, tmux commands and paths to drive the instance; --full adds its env and the seeded rows with their expected verdicts.",
  doctor: "doctor --name <n>  Read-only health check.",
  state:
    "state --name <n> [--log <lines>]  Read-only: git worktree list and git branch per repo, and the removals.log tail.",
  image:
    "image --name <n> --out <feature>-<state>-<variant> [--from <capture.ansi>] [--rows a-b] [--cols a-b]  PNG of the pane (or a saved capture), cropped, into evidence/.",
  down: "down --name <n> [--purge] [--dry-run]  Stop the instance's tmux server and the processes it started. --purge also deletes the sandbox; logs/ and evidence/ survive.",
  list: "list  Instances under .verify/ and whether each is running.",
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const { flags } = parseFlags(args);
  if (!command || command === "--help" || command === "help" || flags.help) {
    print({ ok: true, usage: `bun ${self} <command> [options]`, commands: COMMANDS });
    return;
  }
  const handlers: Record<
    string,
    (flags: Record<string, string | true>) => Promise<Record<string, unknown>>
  > = {
    up,
    env,
    doctor,
    state,
    image,
    down,
    list,
  };
  const handler = handlers[command];
  if (!handler) throw new Failure(`Unknown command: ${command}`, `Run bun ${self} --help.`);
  print({ ok: true, ...(await handler(flags)) });
}

try {
  if (dirname(import.meta.path) !== join(repoRoot, ".claude", "skills", "verify-wt-dash"))
    throw new Failure(
      "stack.ts moved; repoRoot is derived from its location.",
      "Keep it in .claude/skills/verify-wt-dash/.",
    );
  await main();
} catch (error) {
  if (error instanceof Failure)
    print({ ok: false, error: error.message, hint: error.hint, ...error.extra });
  else
    print({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      hint: "Unexpected failure; run doctor and read logs/stack.log in the instance folder.",
    });
  process.exitCode = 1;
}

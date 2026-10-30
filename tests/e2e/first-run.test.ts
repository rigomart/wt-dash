import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "../../src/cli";
import { prepareStartup } from "../../src/startup";
import { inSandbox, withApp, TEST_TIMEOUT } from "../support/app";
import type { Sandbox } from "../support/fixture";
import { savedReposFile } from "../../src/core/scan/saved";

async function repoWithWorktree(sandbox: Sandbox, path: string, branch: string, worktree: string) {
  await mkdir(path, { recursive: true });
  await sandbox.git(path, "init", "-q", "-b", "main");
  await sandbox.git(path, "commit", "-q", "--allow-empty", "-m", "init");
  await mkdir(resolve(worktree, ".."), { recursive: true });
  await sandbox.git(path, "worktree", "add", "-q", "-b", branch, worktree);
}

async function arrangeFirstRun(sandbox: Sandbox) {
  const { home } = sandbox;
  await repoWithWorktree(
    sandbox,
    join(home, "code", "app"),
    "codex/abcd",
    join(home, ".codex", "worktrees", "abcd", "app"),
  );
  await repoWithWorktree(
    sandbox,
    join(home, "elsewhere", "lib"),
    "feature",
    join(home, ".t3", "worktrees", "lib", "feature"),
  );
}

const startup = (sandbox: Sandbox) =>
  prepareStartup(parseArgs([], sandbox.home, sandbox.home), {
    home: sandbox.home,
    path: sandbox.env.PATH,
  });

test(
  "with no folder given and no ~/projects, opens on the repositories in ~/code and those of agents' worktrees (#42)",
  () =>
    inSandbox(async (sandbox) => {
      await arrangeFirstRun(sandbox);
      const { sources } = await startup(sandbox);
      expect(sources.map(({ kind, folder }) => [kind, folder])).toEqual([
        ["scan", join(sandbox.home, "code")],
        ["agent", join(sandbox.home, ".t3", "worktrees")],
        ["agent", join(sandbox.home, ".codex", "worktrees")],
      ]);
      await withApp(sandbox, { width: 120, sources, name: "first run" }, async (app) => {
        const frame = await app.settled();
        const entries = frame
          .split("\n")
          .map((line) => /^(?:▌ | {2})(All projects|app|lib) +(\d+)/u.exec(line))
          .filter((match) => match !== null)
          .map((match) => `${match[1]} ${match[2]}`);
        expect(entries).toEqual(["All projects 2", "app 1", "lib 1"]);
        await app.press("up");
        const all = await app.waitFor("wt-dash › all projects");
        expect(all).toContain("codex/abcd");
        expect(all).toContain("feature");
      });
    }),
  TEST_TIMEOUT,
);

test(
  "a first run that finds nothing names the folders it scanned and how to scan others (#42)",
  () =>
    inSandbox(async (sandbox) => {
      await mkdir(join(sandbox.home, "code"));
      await mkdir(join(sandbox.home, ".codex", "worktrees"), { recursive: true });
      const { sources } = await startup(sandbox);
      const savedRepos = { file: savedReposFile(sandbox.home, sandbox.env), listed: true };
      await withApp(
        sandbox,
        { width: 120, sources, savedRepos, name: "empty first run" },
        async (app) => {
          const frame = await app.settled();
          expect(frame).toContain("No worktrees found in ~/code and ~/.codex/worktrees.");
          expect(frame).toContain("Scan other folders with: wt-dash <folder>");
          expect(frame).toContain(
            "wt-dash remembers the repositories it finds, and lists them in every run without folders.",
          );
          expect(frame).toContain("To forget them, delete ~/.local/state/wt-dash/repos.json");
        },
      );
    }),
  TEST_TIMEOUT,
);

test(
  "--doctor with no folder given lists each folder it scans and how many repositories each finds (#42)",
  () =>
    inSandbox(async (sandbox) => {
      await arrangeFirstRun(sandbox);
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../../src/index.ts"), "--doctor"],
        { cwd: sandbox.home, env: sandbox.env, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const home = sandbox.home;
      expect(stdout).toContain(
        [
          "Scan folders:",
          `  ${home}/code  1 repository`,
          "Agent worktree folders:",
          `  ${home}/.t3/worktrees  1 repository`,
          `  ${home}/.codex/worktrees  1 repository`,
          "Saved repositories:",
          `  ${home}/.local/state/wt-dash/repos.json  0 repositories`,
          "Repositories found: 2",
          "Search depth: 2",
          "Setup checks passed.",
        ].join("\n"),
      );
    }),
  TEST_TIMEOUT,
);

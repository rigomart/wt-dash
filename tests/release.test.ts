import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("generates a Homebrew formula from the four release archives and the supplied repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-formula-"));
  roots.push(root);
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "dist"));
  await copyFile(
    resolve(import.meta.dir, "../scripts/homebrew.ts"),
    join(root, "scripts/homebrew.ts"),
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
  for (const platform of platforms)
    await writeFile(join(root, `dist/wt-dash-v0.1.0-${platform}.tar.gz`), `${platform} release`);
  const child = Bun.spawn(
    [process.execPath, join(root, "scripts/homebrew.ts"), "example/wt-dash"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const error = await new Response(child.stderr).text();
  expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" });
  const formula = await readFile(join(root, "dist/wt-dash.rb"), "utf8");
  expect(formula).toContain('depends_on "worktrunk"');
  for (const platform of platforms)
    expect(formula).toContain(
      `on_${platform.endsWith("arm64") ? "arm" : "intel"} do\n      url "https://github.com/example/wt-dash/releases/download/v0.1.0/wt-dash-v0.1.0-${platform}.tar.gz"\n      sha256 "` +
        createHash("sha256").update(`${platform} release`).digest("hex") +
        '"',
    );
  expect(formula.indexOf("darwin-arm64")).toBeLessThan(formula.indexOf("on_linux do"));
  expect(formula.indexOf("on_linux do")).toBeLessThan(formula.indexOf("linux-arm64"));
  const ruby = Bun.spawn(["ruby", "-c", join(root, "dist/wt-dash.rb")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await ruby.exited).toBe(0);
});

test("local installation handles spaces and creates an executable without changing shell files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-install-"));
  roots.push(root);
  const source = join(root, "source executable");
  const destination = join(root, "local bin");
  await writeFile(source, "#!/bin/sh\nprintf 'installed test executable\\n'\n");
  await chmod(source, 0o755);
  const installer = Bun.spawn(["sh", resolve(import.meta.dir, "../scripts/install.sh"), source], {
    env: { ...process.env, WT_DASH_INSTALL_DIR: destination },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await installer.exited).toBe(0);
  const installed = Bun.spawn([join(destination, "wt-dash")], { stdout: "pipe", stderr: "pipe" });
  expect(await new Response(installed.stdout).text()).toBe("installed test executable\n");
  expect(await installed.exited).toBe(0);
});

async function run(command: string[], env: Record<string, string>, cwd?: string) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output, error };
}

test("the tap update commits each new formula once, never moves back to an older one, and refuses to run without the deploy key", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-tap-"));
  roots.push(root);
  await writeFile(join(root, "gitconfig"), "");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await run(["git", ...args], env, cwd);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.error}`);
    return result.output.trim();
  };
  const tap = join(root, "homebrew-tap.git");
  await git(root, "init", "--quiet", "--bare", "--initial-branch=main", tap);
  await git(root, "clone", "--quiet", tap, join(root, "seed"));
  await mkdir(join(root, "seed/Formula"));
  await writeFile(join(root, "seed/Formula/.gitkeep"), "");
  await writeFile(join(root, "seed/README.md"), "# Tap\n");
  await git(join(root, "seed"), "add", "-A");
  await git(
    join(root, "seed"),
    "-c",
    "user.name=Seed",
    "-c",
    "user.email=seed@example.com",
    "commit",
    "--quiet",
    "-m",
    "Seed",
  );
  await git(join(root, "seed"), "push", "--quiet", "origin", "main");

  const script = resolve(import.meta.dir, "../scripts/update-tap.sh");
  const publish = async (version: string, key = "test deploy key") => {
    const formula = join(root, `wt-dash-${version}.rb`);
    await writeFile(formula, `class WtDash < Formula\n  version "${version}"\nend\n`);
    return run(["sh", script, formula, `v${version}`, tap], {
      ...env,
      HOMEBREW_TAP_DEPLOY_KEY: key,
    });
  };
  const history = () => git(root, "--git-dir", tap, "log", "--format=%s", "main");
  const formula = () => git(root, "--git-dir", tap, "show", "main:Formula/wt-dash.rb");

  const first = await publish("0.2.0");
  expect(first.code).toBe(0);
  expect(await history()).toBe("wt-dash 0.2.0\nSeed");
  expect(await formula()).toContain('version "0.2.0"');

  const rerun = await publish("0.2.0");
  expect(rerun.code).toBe(0);
  expect(rerun.output).toContain("already has wt-dash 0.2.0");
  expect(await history()).toBe("wt-dash 0.2.0\nSeed");

  const next = await publish("0.3.0");
  expect(next.code).toBe(0);
  expect(await history()).toBe("wt-dash 0.3.0\nwt-dash 0.2.0\nSeed");
  expect(await formula()).toContain('version "0.3.0"');

  const older = await publish("0.2.0");
  expect(older.code).toBe(0);
  expect(older.output).toContain("already has wt-dash 0.3.0, newer than 0.2.0");
  expect(await history()).toBe("wt-dash 0.3.0\nwt-dash 0.2.0\nSeed");
  expect(await formula()).toContain('version "0.3.0"');

  const missing = await publish("0.4.0", "");
  expect(missing.code).not.toBe(0);
  expect(missing.error).toContain("HOMEBREW_TAP_DEPLOY_KEY is not set");
  expect(missing.error).toContain("CONTRIBUTING.md");
  expect(await history()).toBe("wt-dash 0.3.0\nwt-dash 0.2.0\nSeed");
});

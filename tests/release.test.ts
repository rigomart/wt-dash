import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("generates a Homebrew formula from both release archives and the supplied repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-formula-"));
  roots.push(root);
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "dist"));
  await copyFile(
    resolve(import.meta.dir, "../scripts/homebrew.ts"),
    join(root, "scripts/homebrew.ts"),
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await writeFile(join(root, "dist/wt-dash-v0.1.0-darwin-arm64.tar.gz"), "arm release");
  await writeFile(join(root, "dist/wt-dash-v0.1.0-darwin-x64.tar.gz"), "intel release");
  const child = Bun.spawn(
    [process.execPath, join(root, "scripts/homebrew.ts"), "example/wt-dash"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const error = await new Response(child.stderr).text();
  expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" });
  const formula = await readFile(join(root, "dist/wt-dash.rb"), "utf8");
  expect(formula).toContain('depends_on "worktrunk"');
  expect(formula).toContain(
    'on_arm do\n      url "https://github.com/example/wt-dash/releases/download/v0.1.0/wt-dash-v0.1.0-darwin-arm64.tar.gz"\n      sha256 "' +
      createHash("sha256").update("arm release").digest("hex") +
      '"',
  );
  expect(formula).toContain(
    'on_intel do\n      url "https://github.com/example/wt-dash/releases/download/v0.1.0/wt-dash-v0.1.0-darwin-x64.tar.gz"\n      sha256 "' +
      createHash("sha256").update("intel release").digest("hex") +
      '"',
  );
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

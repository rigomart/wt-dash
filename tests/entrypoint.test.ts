import { expect, test } from "bun:test";
import { resolve } from "node:path";

async function run(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/index.ts"), ...args],
    {
      env: { ...process.env, PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("help and version run successfully without Git or Worktrunk", async () => {
  const help = await run(["--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Usage: wt-dash");
  expect(help.stderr).toBe("");
  const version = await run(["--version"]);
  expect(version.code).toBe(0);
  expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  expect(version.stderr).toBe("");
});

test("missing Git exits with installation guidance and no stack trace", async () => {
  const result = await run(["--doctor", "."]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Git was not found on PATH. Install");
  expect(result.stderr).not.toContain("at main");
  expect(result.stdout).toBe("");
});

test("unknown CLI options return a failing exit with help guidance", async () => {
  const result = await run(["--typo"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--help");
});

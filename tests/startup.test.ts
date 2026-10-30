import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareStartup } from "../src/startup";
import { parseArgs } from "../src/cli";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function environment(version = "wt v0.80.0") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dash-startup-")));
  temporary.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const [name, output] of [
    ["wt", version],
    ["git", "git version 2.50.0"],
  ]) {
    const path = join(bin, name!);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
    await chmod(path, 0o755);
  }
  return { root, bin };
}

test("finds dependencies on PATH and deduplicates resolved scan folders", async () => {
  const { root, bin } = await environment();
  const options = parseArgs([root, root], root, root);
  const ready = await prepareStartup(options, { platform: "darwin", path: bin });
  expect(ready.sources).toEqual([{ kind: "scan", folder: root }]);
  expect(ready.wtPath).toBe(join(bin, "wt"));
  expect(ready.gitVersion).toContain("2.50.0");
});

test("honors an explicit executable instead of a different Worktrunk on PATH", async () => {
  const { root, bin } = await environment();
  const path = join(root, "custom-wt");
  await writeFile(path, "#!/bin/sh\nprintf 'wt v0.81.0\\n'\n");
  await chmod(path, 0o755);
  const ready = await prepareStartup(parseArgs([root, "--wt-path", path], root, root), {
    platform: "darwin",
    path: bin,
  });
  expect(ready.wtPath).toBe(path);
  expect(ready.wtVersion).toBe("wt v0.81.0");
});

test("an explicit missing Worktrunk produces setup guidance", async () => {
  const { root, bin } = await environment();
  await expect(
    prepareStartup(parseArgs([root, "--wt-path", join(root, "missing")], root, root), {
      platform: "darwin",
      path: bin,
    }),
  ).rejects.toThrow("--wt-path");
});

test("rejects old Worktrunk before opening the dashboard", async () => {
  const { root, bin } = await environment("wt v0.79.0");
  await expect(
    prepareStartup(parseArgs([root], root, root), { platform: "darwin", path: bin }),
  ).rejects.toThrow("brew upgrade worktrunk");
});

test("missing scan folders and unsupported platforms produce useful errors", async () => {
  const { root, bin } = await environment();
  await expect(
    prepareStartup(parseArgs([join(root, "missing")], root, root), {
      platform: "darwin",
      path: bin,
    }),
  ).rejects.toThrow("Scan folder");
  await expect(
    prepareStartup(parseArgs([root], root, root), { platform: "win32", path: bin }),
  ).rejects.toThrow("macOS and Linux");
});

test("runs on Linux and suggests a package manager when Git is missing", async () => {
  const { root, bin } = await environment();
  const ready = await prepareStartup(parseArgs([root], root, root), {
    platform: "linux",
    path: bin,
  });
  expect(ready.wtPath).toBe(join(bin, "wt"));
  await rm(join(bin, "git"));
  await expect(
    prepareStartup(parseArgs([root], root, root), { platform: "linux", path: bin }),
  ).rejects.toThrow("package manager");
});

test("with no folder given, skips missing default folders and adds the agents' worktree folders that exist", async () => {
  const { root, bin } = await environment();
  await mkdir(join(root, "code"));
  await mkdir(join(root, ".codex", "worktrees"), { recursive: true });
  await mkdir(join(root, ".cursor", "worktrees"), { recursive: true });
  const ready = await prepareStartup(parseArgs([], root, root), {
    platform: "darwin",
    path: bin,
    home: root,
  });
  expect(ready.sources).toEqual([
    { kind: "scan", folder: join(root, "code") },
    { kind: "agent", folder: join(root, ".codex", "worktrees"), levels: [2, 2] },
    { kind: "agent", folder: join(root, ".cursor", "worktrees"), levels: [1, 2] },
  ]);
  const none = await prepareStartup(parseArgs([], join(root, "empty"), root), {
    platform: "darwin",
    path: bin,
    home: join(root, "empty"),
  });
  expect(none.sources).toEqual([]);
  const given = await prepareStartup(parseArgs([join(root, "code")], root, root), {
    platform: "darwin",
    path: bin,
    home: root,
  });
  expect(given.sources).toEqual([{ kind: "scan", folder: join(root, "code") }]);
});

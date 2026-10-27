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
  expect(ready.roots).toEqual([root]);
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
    prepareStartup(parseArgs([root], root, root), { platform: "linux", path: bin }),
  ).rejects.toThrow("macOS");
});

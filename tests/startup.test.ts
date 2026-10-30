import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareStartup, worktrunkVersion } from "../src/startup";
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

test("an explicit missing Worktrunk names the path it was given (#59)", async () => {
  const { root, bin } = await environment();
  const missing = join(root, "missing");
  await expect(
    prepareStartup(parseArgs([root, "--wt-path", missing], root, root), {
      platform: "darwin",
      path: bin,
    }),
  ).rejects.toThrow(`Worktrunk was not found at ${missing}, given with --wt-path.`);
});

test("reads the release from every form wt --version prints (#59)", () => {
  const release = (release: number[], prerelease = false) => ({ release, prerelease });
  expect(worktrunkVersion("wt v0.80.0")).toEqual(release([0, 80, 0]));
  expect(worktrunkVersion("wt 0.80.0")).toEqual(release([0, 80, 0]));
  expect(worktrunkVersion("wt v0.81.0-3-gabc1234")).toEqual(release([0, 81, 0]));
  expect(worktrunkVersion("wt v0.81.0-dirty")).toEqual(release([0, 81, 0]));
  expect(worktrunkVersion("wt v0.81.0-3-gabc1234-dirty")).toEqual(release([0, 81, 0]));
  expect(worktrunkVersion("wt 0.81.0+nix")).toEqual(release([0, 81, 0]));
  expect(worktrunkVersion("wt v0.81.0-rc.1")).toEqual(release([0, 81, 0], true));
  expect(worktrunkVersion("wt abc1234")).toBeNull();
  expect(worktrunkVersion("wt v0.80.0x")).toBeNull();
  expect(worktrunkVersion("worktrunk 0.80.0")).toBeNull();
});

test("rejects a pre-release of the minimum and accepts one of a later release (#59)", async () => {
  const early = await environment("wt v0.80.0-rc.1");
  await expect(
    prepareStartup(parseArgs([early.root], early.root, early.root), {
      platform: "darwin",
      path: early.bin,
    }),
  ).rejects.toThrow("Worktrunk 0.80.0 or newer is required; found wt v0.80.0-rc.1");
  const later = await environment("wt v0.81.0-rc.1");
  const ready = await prepareStartup(parseArgs([later.root], later.root, later.root), {
    platform: "darwin",
    path: later.bin,
  });
  expect(ready.wtVersion).toBe("wt v0.81.0-rc.1");
});

test("accepts a Worktrunk built from crates.io or past a tag (#59)", async () => {
  for (const version of ["wt 0.80.0", "wt v0.80.0-3-gabc1234"]) {
    const { root, bin } = await environment(version);
    const ready = await prepareStartup(parseArgs([root], root, root), {
      platform: "darwin",
      path: bin,
    });
    expect(ready.wtVersion).toBe(version);
  }
});

test("a Worktrunk whose version can't be read says what it printed (#59)", async () => {
  const { root, bin } = await environment("wt abc1234");
  await expect(
    prepareStartup(parseArgs([root], root, root), { platform: "darwin", path: bin }),
  ).rejects.toThrow(
    `Could not read Worktrunk's version from ${join(bin, "wt")} --version, which printed: wt abc1234`,
  );
});

test("a Worktrunk that fails to run passes on its error (#59)", async () => {
  const { root, bin } = await environment();
  await writeFile(join(bin, "wt"), "#!/bin/sh\necho 'dyld: Library not loaded' >&2\nexit 134\n");
  await expect(
    prepareStartup(parseArgs([root], root, root), { platform: "darwin", path: bin }),
  ).rejects.toThrow(`Worktrunk could not run: ${join(bin, "wt")} (dyld: Library not loaded).`);
});

test("rejects old Worktrunk before opening the dashboard, naming the one it found (#59)", async () => {
  const { root, bin } = await environment("wt v0.79.0");
  await expect(
    prepareStartup(parseArgs([root], root, root), { platform: "darwin", path: bin }),
  ).rejects.toThrow(
    `Worktrunk 0.80.0 or newer is required; found wt v0.79.0 at ${join(bin, "wt")}.\nUpdate it with: brew upgrade worktrunk, or cargo install worktrunk`,
  );
});

test("a scan folder given that can't be scanned says why (#59)", async () => {
  const { root, bin } = await environment();
  await writeFile(join(root, "file"), "");
  await mkdir(join(root, "locked"), { mode: 0o000 });
  await symlink("loop-b", join(root, "loop-a"));
  await symlink("loop-a", join(root, "loop-b"));
  const problem = (folder: string) =>
    prepareStartup(parseArgs([join(root, folder)], root, root), {
      platform: "darwin",
      path: bin,
    }).then(
      () => "no error",
      (error: Error) => error.message.split("\n")[0],
    );
  expect(await problem("missing")).toBe(`Scan folder not found: ${join(root, "missing")}`);
  expect(await problem("file")).toBe(`Not a folder: ${join(root, "file")}`);
  expect(await problem("loop-a")).toBe(
    `Scan folder is a symbolic link loop: ${join(root, "loop-a")}`,
  );
  if (process.getuid?.() !== 0)
    expect(await problem("locked")).toBe(
      `Scan folder can't be read (permission denied): ${join(root, "locked")}`,
    );
  await chmod(join(root, "locked"), 0o755);
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

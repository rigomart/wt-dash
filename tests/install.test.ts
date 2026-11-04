import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Fake GitHub releases: /releases/latest redirects to the newest tag; archives and checksums sit under /releases/download/<tag>/.

const INSTALLER = resolve(import.meta.dir, "../site/install.sh");
const PLATFORM = `${process.platform}-${process.arch}`;
/** The commands the installer and this test's `curl | sh` call. Run with only these on PATH, so a `wt` or `wt-dash` installed on this machine, even in /usr/bin, isn't found. */
const TOOLS = [
  "sh",
  "curl",
  "tar",
  "gzip",
  "sha256sum",
  "shasum",
  "uname",
  "ldd",
  "grep",
  "sysctl",
  "mktemp",
  "rm",
  "mkdir",
  "install",
  "mv",
];
let SYSTEM_PATH: string;

const files = new Map<string, Blob | string>();
const requests: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let fixtures: string;

async function publish(version: string, options: { checksum?: string; executable?: string } = {}) {
  const folder = join(fixtures, version);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "wt-dash"), options.executable ?? `#!/bin/sh\necho ${version}\n`);
  await chmod(join(folder, "wt-dash"), 0o755);
  await writeFile(join(folder, "LICENSE"), "MIT\n");
  const archive = `wt-dash-v${version}-${PLATFORM}.tar.gz`;
  const tar = Bun.spawnSync([
    "tar",
    "-czf",
    join(folder, archive),
    "-C",
    folder,
    "wt-dash",
    "LICENSE",
  ]);
  expect(tar.exitCode).toBe(0);
  const bytes = await readFile(join(folder, archive));
  const hash = options.checksum ?? createHash("sha256").update(bytes).digest("hex");
  files.set(`/releases/download/v${version}/${archive}`, Bun.file(join(folder, archive)));
  files.set(`/releases/download/v${version}/${archive}.sha256`, `${hash}  ${archive}\n`);
}

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "wt-dash-releases-"));
  SYSTEM_PATH = join(fixtures, "system-bin");
  await mkdir(SYSTEM_PATH);
  for (const tool of TOOLS) {
    const found = Bun.which(tool, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    if (found) await symlink(found, join(SYSTEM_PATH, tool));
  }
  await publish("0.1.0");
  await publish("0.2.0");
  await publish("0.0.9", { checksum: "0".repeat(64) });
  await publish("0.0.8", {
    executable: "#!/bin/sh\necho 'version GLIBC_2.99 not found' >&2\nexit 1\n",
  });
  files.set("/install.sh", await readFile(INSTALLER, "utf8"));
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/releases/latest")
        return Response.redirect(new URL("/releases/tag/v0.2.0", request.url).href, 302);
      if (path.startsWith("/releases/tag/")) return new Response("release page");
      const body = files.get(path);
      return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body);
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await rm(fixtures, { recursive: true, force: true });
});

const homes: string[] = [];
afterEach(async () => {
  requests.length = 0;
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function newHome() {
  const home = await mkdtemp(join(tmpdir(), "wt-dash-install-"));
  homes.push(home);
  return home;
}

/** Runs `curl -fsSL <server>/install.sh | sh`, or pipes `script` into sh when given. */
async function install(env: Record<string, string>, script?: string) {
  const base = server.url.href.replace(/\/$/, "");
  const child = Bun.spawn(
    script === undefined ? ["sh", "-c", `curl -fsSL ${base}/install.sh | sh`] : ["sh"],
    {
      env: { PATH: SYSTEM_PATH, WT_DASH_RELEASES_URL: `${base}/releases`, ...env },
      stdin: script === undefined ? "ignore" : new TextEncoder().encode(script),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output, error };
}

async function run(executable: string) {
  const child = Bun.spawn([executable], { stdout: "pipe", stderr: "pipe" });
  return (await new Response(child.stdout).text()).trim();
}

test("the one-liner installs the latest release for this machine and says what is left to set up", async () => {
  const home = await newHome();
  const result = await install({ HOME: home });
  expect(result.code).toBe(0);
  expect(requests).toContain(`/releases/download/v0.2.0/wt-dash-v0.2.0-${PLATFORM}.tar.gz`);
  expect(await run(join(home, ".local/bin/wt-dash"))).toBe("0.2.0");
  expect(result.output).toContain(`Installed wt-dash 0.2.0 to ${home}/.local/bin/wt-dash`);
  expect(result.output).toContain(`${home}/.local/bin is not on your PATH.`);
  expect(result.output).toContain(`export PATH="${home}/.local/bin:$PATH"`);
  expect(result.error).toContain("wt-dash needs Worktrunk 0.80.0 or newer");
  expect(result.error).toContain("brew install worktrunk, or cargo install worktrunk");
});

test("a pinned version installs into WT_DASH_INSTALL_DIR, and nothing is flagged once PATH and Worktrunk are set up", async () => {
  const home = await newHome();
  const bin = join(home, "my bin");
  const tools = join(home, "tools");
  await mkdir(tools);
  await writeFile(join(tools, "wt"), "#!/bin/sh\necho wt v0.80.0\n");
  await chmod(join(tools, "wt"), 0o755);
  const result = await install({
    HOME: home,
    PATH: `${bin}:${tools}:${SYSTEM_PATH}`,
    WT_DASH_VERSION: "0.1.0",
    WT_DASH_INSTALL_DIR: bin,
  });
  expect(result).toMatchObject({ code: 0, error: "" });
  expect(requests).not.toContain("/releases/latest");
  expect(await run(join(bin, "wt-dash"))).toBe("0.1.0");
  expect(result.output).not.toContain("PATH");
  expect(result.output).toContain("Check the setup with: wt-dash --doctor");
});

test("an archive that does not match its published checksum is not installed", async () => {
  const home = await newHome();
  const result = await install({ HOME: home, WT_DASH_VERSION: "v0.0.9" });
  expect(result.code).toBe(1);
  expect(result.error).toContain(
    `wt-dash-v0.0.9-${PLATFORM}.tar.gz does not match its published checksum, so nothing was installed.`,
  );
  expect(await Bun.file(join(home, ".local/bin/wt-dash")).exists()).toBe(false);
});

test("a release that can't run on this system leaves the installed copy in place", async () => {
  const home = await newHome();
  const bin = join(home, ".local/bin");
  expect((await install({ HOME: home, WT_DASH_VERSION: "0.1.0" })).code).toBe(0);
  const result = await install({ HOME: home, WT_DASH_VERSION: "0.0.8" });
  expect(result.code).toBe(1);
  expect(result.error).toContain(
    "wt-dash 0.0.8 does not run on this system, so nothing was installed: version GLIBC_2.99 not found",
  );
  expect(await run(join(bin, "wt-dash"))).toBe("0.1.0");
  expect(await readdir(bin)).toEqual(["wt-dash"]);
});

test("a release that does not exist fails with the URL it tried", async () => {
  const home = await newHome();
  const result = await install({ HOME: home, WT_DASH_VERSION: "9.9.9" });
  expect(result.code).toBe(1);
  expect(result.error).toContain(
    `could not download ${server.url.href}releases/download/v9.9.9/wt-dash-v9.9.9-${PLATFORM}.tar.gz`,
  );
});

test("a download cut off partway runs nothing", async () => {
  const home = await newHome();
  const script = await readFile(INSTALLER, "utf8");
  const cut = script.slice(0, script.indexOf("  mkdir -p"));
  const result = await install({ HOME: home }, cut);
  expect(result.code).not.toBe(0);
  expect(requests).toEqual([]);
  expect(result.output).toBe("");
  expect(await Bun.file(join(home, ".local")).exists()).toBe(false);
});

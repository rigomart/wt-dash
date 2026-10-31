import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/site.ts");

test("the assembled landing page finds every file it links to", async () => {
  const out = await mkdtemp(join(tmpdir(), "wt-dash-site-"));
  try {
    const run = Bun.spawnSync([process.execPath, script, out], { stderr: "inherit" });
    expect(run.exitCode).toBe(0);

    const html = await readFile(join(out, "index.html"), "utf8");
    expect(html).toContain("brew install rigomart/tap/wt-dash");

    const local = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((match) => match[1]!);
    expect(local).toContain("images/projects.png");
    for (const path of local) expect(await Bun.file(join(out, path)).exists()).toBe(true);

    const ogImage = html.match(
      /property="og:image" content="https:\/\/wt-dash\.rigos\.dev\/([^"]+)"/,
    )?.[1];
    expect(ogImage && (await Bun.file(join(out, ogImage)).exists())).toBe(true);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

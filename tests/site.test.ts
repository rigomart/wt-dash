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
    expect(local).toContain("/favicon.ico");
    expect(local).toContain("/favicon.svg");
    for (const path of local) expect(await Bun.file(join(out, path)).exists()).toBe(true);

    const published = [
      ...html.matchAll(/(?:content|href)="https:\/\/wt-dash\.rigos\.dev\/([^"]+)"/g),
    ].map((match) => match[1]!);
    expect(published).toContain("images/projects.png");
    for (const path of published) expect(await Bun.file(join(out, path)).exists()).toBe(true);

    const manifest = await Bun.file(join(out, "site.webmanifest")).json();
    for (const icon of manifest.icons) {
      expect(await Bun.file(join(out, icon.src)).exists()).toBe(true);
    }

    const robots = await readFile(join(out, "robots.txt"), "utf8");
    const sitemap = robots.match(/^Sitemap: https:\/\/wt-dash\.rigos\.dev\/(\S+)$/m)?.[1];
    expect(sitemap && (await Bun.file(join(out, sitemap)).exists())).toBe(true);

    const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    expect(JSON.parse(jsonLd!).name).toBe("wt-dash");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

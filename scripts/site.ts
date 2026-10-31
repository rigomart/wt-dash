/** Usage: bun scripts/site.ts [out-dir] (default dist/site). Copies site/ and docs/images (as images/) into out-dir. */
import { cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = resolve(process.argv[2] ?? join(root, "dist/site"));

await rm(out, { recursive: true, force: true });
await cp(join(root, "site"), out, { recursive: true });
await cp(join(root, "docs/images"), join(out, "images"), { recursive: true });
console.log(out);

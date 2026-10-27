import { mkdir, readdir, readFile, copyFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import metadata from "../package.json";

const root = resolve(import.meta.dir, "..");
const output = join(root, "dist");
const runtimeVersion = "1.3.14";
if (Bun.version !== runtimeVersion) {
  throw new Error(`Release builds use Bun ${runtimeVersion} so the bundled runtime and license notices match. Run: bunx bun@${runtimeVersion} run build`);
}
if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
  throw new Error("Build on an Apple Silicon or Intel Mac. Each release architecture is built on its own Mac.");
}
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${metadata.version}`) {
  throw new Error("The release tag must match the version in package.json.");
}
await mkdir(output, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  compile: {
    target: process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64",
    outfile: join(output, "wt-dash"),
    autoloadDotenv: false, autoloadBunfig: false,
    autoloadTsconfig: false, autoloadPackageJson: false,
  },
});
if (!result.success) throw new AggregateError(result.logs, "Compilation failed");

// Retain the licenses for production packages and the native libraries they include.
const visited = new Set<string>();
const notices: string[] = [
  `wt-dash ${metadata.version} — third-party notices\n\nBuilt with Bun ${Bun.version}.\nBun licensing and runtime source: https://github.com/oven-sh/bun/tree/bun-v${Bun.version}\nRebuilding: see "Rebuilding with a modified Bun runtime" in CONTRIBUTING.md, https://github.com/rigomart/wt-dash/blob/main/CONTRIBUTING.md\n`,
];
const runtimeLicenses = join(root, "licenses", `bun-${runtimeVersion}`);
notices.push(await readFile(join(runtimeLicenses, "NOTICES.txt"), "utf8"));
async function collect(name: string, optional = false): Promise<void> {
  if (visited.has(name)) return;
  visited.add(name);
  const directory = join(root, "node_modules", name);
  let pkg;
  try { pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const licenseFiles = (await readdir(directory)).filter((file) => /^(license|copying|notice)([.-]|$)/i.test(file)).sort();
  notices.push(`\n${pkg.name} ${pkg.version} (${pkg.license ?? "see license below"})\n`);
  for (const file of licenseFiles) notices.push(`${file}\n${await readFile(join(directory, file), "utf8")}`);
  if (!licenseFiles.length) throw new Error(`No license file found for ${name}`);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) await collect(dependency);
  for (const dependency of Object.keys(pkg.peerDependencies ?? {})) await collect(dependency, true);
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) await collect(dependency, true);
}
for (const dependency of Object.keys(metadata.dependencies)) await collect(dependency);
await writeFile(join(output, "THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
for (const file of ["LICENSE", "README.md"]) await copyFile(join(root, file), join(output, file));

const archive = `wt-dash-v${metadata.version}-darwin-${process.arch}.tar.gz`;
const tar = Bun.spawn(["/usr/bin/tar", "-czf", join(output, archive), "-C", output,
  "wt-dash", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.txt"], { stdout: "inherit", stderr: "inherit" });
if (await tar.exited !== 0) throw new Error("Could not create the release archive");
const hash = createHash("sha256").update(await readFile(join(output, archive))).digest("hex");
await writeFile(join(output, `${archive}.sha256`), `${hash}  ${archive}\n`);
console.log(`Built ${join(output, archive)}\nSHA-256: ${hash}`);

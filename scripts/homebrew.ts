import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import metadata from "../package.json";

const repository = process.argv[2] ?? process.env.GITHUB_REPOSITORY;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error("Supply the GitHub repository: bun run formula owner/wt-dash");
const directory = resolve(import.meta.dir, "../dist");
const hashes: Record<string, string> = {};
for (const arch of ["arm64", "x64"]) {
  const archive = await readFile(
    join(directory, `wt-dash-v${metadata.version}-darwin-${arch}.tar.gz`),
  );
  hashes[arch] = createHash("sha256").update(archive).digest("hex");
}
const base = `https://github.com/${repository}`;
const formula = `class WtDash < Formula
  desc "Review and clean up Git worktrees across repositories"
  homepage "${base}"
  version "${metadata.version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${base}/releases/download/v${metadata.version}/wt-dash-v${metadata.version}-darwin-arm64.tar.gz"
      sha256 "${hashes.arm64}"
    end
    on_intel do
      url "${base}/releases/download/v${metadata.version}/wt-dash-v${metadata.version}-darwin-x64.tar.gz"
      sha256 "${hashes.x64}"
    end
  end

  depends_on macos: :ventura
  depends_on "worktrunk"

  def install
    bin.install "wt-dash"
    doc.install "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/wt-dash --version")
    system bin/"wt-dash", "--doctor", testpath
  end
end
`;
await writeFile(join(directory, "wt-dash.rb"), formula);
console.log(`Generated ${join(directory, "wt-dash.rb")}`);

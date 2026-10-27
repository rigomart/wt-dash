#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { help, parseArgs, version } from "./cli";
import { prepareStartup } from "./startup";
import { createDashboardService } from "./core/dashboard";
import { createActionService } from "./core/actions";
import { runCommand } from "./core/process";
import { createSizeService } from "./core/sizes";
import { discoverRepos } from "./core/discovery";

async function main(): Promise<void> {
  const home = homedir();
  const options = parseArgs(process.argv.slice(2), home, process.cwd());
  if (options.mode === "help") {
    console.log(help);
    return;
  }
  if (options.mode === "version") {
    console.log(version);
    return;
  }
  const ready = await prepareStartup(options);
  if (options.mode === "doctor") {
    console.log(
      `wt-dash ${version}\nPlatform: macOS ${process.arch}\nGit: ${ready.gitVersion}\nWorktrunk: ${ready.wtVersion} (${ready.wtPath})\nScan folders:\n${ready.roots.map((root) => `  ${root}`).join("\n")}\nSearch depth: ${options.depth}\nSetup checks passed.`,
    );
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Run wt-dash in an interactive terminal. Use --doctor to check setup without opening the UI.",
    );
  const { runTerminal } = await import("./ui/terminal");
  const sizes = createSizeService(join(home, ".cache/wt-dash/sizes.json"), runCommand);
  await sizes.load();
  const dashboard = createDashboardService({
    projectRoot: ready.roots[0]!,
    wtPath: ready.wtPath,
    runner: runCommand,
    sizeService: sizes,
    discover: async () =>
      [
        ...new Set(
          (
            await Promise.all(ready.roots.map((root) => discoverRepos(root, options.depth + 1)))
          ).flat(),
        ),
      ].sort(),
  });
  const actions = createActionService({
    wtPath: ready.wtPath,
    runner: runCommand,
    logPath: join(home, ".cache/wt-dash/removals.log"),
  });
  try {
    await runTerminal(dashboard, { actions });
  } finally {
    await dashboard.close();
    await sizes.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`wt-dash: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

#!/usr/bin/env bun
import { homedir } from "node:os";
import { help, parseArgs, version } from "./cli";
import { doctorSources, platformName, prepareStartup } from "./startup";
import { createServices } from "./app";
import { runCommand } from "./core/process";

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
  const ready = await prepareStartup(options, { home });
  if (options.mode === "doctor") {
    console.log(
      `wt-dash ${version}\nPlatform: ${platformName()} ${process.arch}\nGit: ${ready.gitVersion}\nWorktrunk: ${ready.wtVersion} (${ready.wtPath})\n${await doctorSources(ready.sources, options)}\nSearch depth: ${options.depth}\nSetup checks passed.`,
    );
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Run wt-dash in an interactive terminal. Use --doctor to check setup without opening the UI.",
    );
  const { runTerminal } = await import("./ui/terminal");
  const { dashboard, actions, close } = await createServices({
    home,
    sources: ready.sources,
    depth: options.depth,
    wtPath: ready.wtPath,
    runner: runCommand,
  });
  try {
    await runTerminal(dashboard, {
      actions,
      home,
      scanned: ready.sources.map(({ folder }) => folder),
    });
  } finally {
    await close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`wt-dash: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

// The fake `gh` the sandbox puts on PATH (see gh.ts). It logs the call, waits `delayMs`, then answers.
import { readFileSync } from "node:fs";
import { answerGh, GH_LOG_ENV, GH_STATE_ENV, type GhState, logGhCall } from "./gh";

const statePath = process.env[GH_STATE_ENV];
const logPath = process.env[GH_LOG_ENV];
if (!statePath || !logPath) {
  process.stderr.write(
    `fake gh: ${GH_STATE_ENV} and ${GH_LOG_ENV} must be set; use the sandbox env\n`,
  );
  process.exit(2);
}
const args = process.argv.slice(2);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && /^(GH_|GITHUB_|NO_COLOR$)/.test(entry[0]),
  ),
);
await logGhCall(logPath, { argv: args, cwd: process.cwd(), env });
const state = JSON.parse(readFileSync(statePath, "utf8")) as GhState;
if (state.delayMs) await Bun.sleep(state.delayMs);
const result = answerGh(state, args);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;

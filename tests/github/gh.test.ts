import { expect, test } from "bun:test";
import { GH_ENV, runGraphql } from "../../src/core/github/gh";
import type { CommandResult, CommandRunner } from "../../src/core/types";
import { GH_ENV as FAKE_GH_ENV } from "../support/gh";

const request = { query: "query { rateLimit { cost } }", variables: { owner: "acme" } };
const live = () => new AbortController().signal;
const answering =
  (result: Partial<CommandResult>): CommandRunner =>
  async () => ({ stdout: "", stderr: "", exitCode: 0, ...result });

test("runs gh with every value passed by -f, and the environment that keeps it quiet", async () => {
  const seen: Array<{ command: string; args: string[]; environment?: Record<string, string> }> = [];
  const runner: CommandRunner = async (command, args, _signal, environment) => {
    seen.push({ command, args, environment });
    return { stdout: JSON.stringify({ data: { repository: { x: 1 } } }), stderr: "", exitCode: 0 };
  };
  expect(await runGraphql("/opt/gh", request, runner, live())).toEqual({
    kind: "reply",
    repository: { x: 1 },
    errorPaths: [],
  });
  expect(seen).toEqual([
    {
      command: "/opt/gh",
      args: [
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "-f",
        `query=${request.query}`,
        "-f",
        "owner=acme",
      ],
      environment: { GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" },
    },
  ]);
  expect(GH_ENV).toEqual(FAKE_GH_ENV);
});

test("exit 1 with JSON on stdout gives the data that came back, with its errors' paths", async () => {
  const stdout = JSON.stringify({
    data: { repository: { a0: null, a1: { y: 1 } } },
    errors: [{ path: ["repository", "a0"], message: "boom" }, { message: "no path" }],
  });
  expect(await runGraphql("gh", request, answering({ stdout, exitCode: 1 }), live())).toEqual({
    kind: "reply",
    repository: { a0: null, a1: { y: 1 } },
    errorPaths: [["repository", "a0"], null],
  });
});

test.each<[string, Partial<CommandResult>, string]>([
  ["exit 4, gh not signed in", { exitCode: 4, stderr: "gh auth login" }, "signed-out"],
  [
    "exit 1 with nothing on stdout",
    { exitCode: 1, stderr: "Bad credentials (HTTP 401)" },
    "failed",
  ],
  [
    "another exit code",
    { exitCode: 2, stdout: JSON.stringify({ data: { repository: {} } }) },
    "failed",
  ],
  ["unparseable output", { stdout: "<html>" }, "failed"],
  [
    "JSON without data",
    { stdout: JSON.stringify({ errors: [{ message: "x" }] }), exitCode: 1 },
    "failed",
  ],
  [
    "a query over GitHub's node limit",
    {
      stdout: JSON.stringify({
        data: { repository: {} },
        errors: [{ type: "MAX_NODE_LIMIT_EXCEEDED", message: "too many" }],
      }),
      exitCode: 1,
    },
    "failed",
  ],
])("%s leaves the rows unchecked", async (_name, result, why) => {
  expect(await runGraphql("gh", request, answering(result), live())).toEqual({
    kind: "unchecked",
    why: why as "failed",
  });
});

test("gh that can't be started is missing; any other spawn error is a failure", async () => {
  const throwing =
    (code: string): CommandRunner =>
    async () => {
      throw Object.assign(new Error(`${code}: posix_spawn`), { code });
    };
  expect(await runGraphql("/gone/gh", request, throwing("ENOENT"), live())).toEqual({
    kind: "unchecked",
    why: "gh-missing",
  });
  expect(await runGraphql("/gone/gh", request, throwing("EACCES"), live())).toEqual({
    kind: "unchecked",
    why: "failed",
  });
});

/** A runner that never answers, and throws like the real one once its signal aborts. */
const hanging: CommandRunner = (_command, _args, signal) =>
  new Promise((_, reject) =>
    signal?.addEventListener("abort", () => reject(new Error("Command aborted")), { once: true }),
  );

test("a request that outlasts the timeout fails, and the command is cancelled", async () => {
  let cancelled = false;
  const runner: CommandRunner = (command, args, signal, environment) => {
    signal?.addEventListener("abort", () => (cancelled = true));
    return hanging(command, args, signal, environment);
  };
  expect(await runGraphql("gh", request, runner, live(), 20)).toEqual({
    kind: "unchecked",
    why: "failed",
  });
  expect(cancelled).toBe(true);
});

test("an aborted scan throws instead of answering, so the check reports nothing", async () => {
  const controller = new AbortController();
  const asked = runGraphql("gh", request, hanging, controller.signal, 5_000);
  controller.abort();
  await expect(asked).rejects.toThrow("Command aborted");
  // Aborted while gh was finishing: the answer is dropped too.
  const late = new AbortController();
  const finishing: CommandRunner = async () => {
    late.abort();
    return { stdout: JSON.stringify({ data: { repository: {} } }), stderr: "", exitCode: 0 };
  };
  await expect(runGraphql("gh", request, finishing, late.signal)).rejects.toThrow();
});

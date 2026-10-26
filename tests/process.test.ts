import { expect, test } from "bun:test";
import { runCommand } from "../src/core/process";

test("passes paths with spaces and shell characters as literal arguments", async () => {
  const path = "/tmp/a space/$(echo should-not-run);*.git";
  const result = await runCommand("/usr/bin/printf", ["%s\n", path]);
  expect(result).toEqual({ stdout: path + "\n", stderr: "", exitCode: 0 });
});

test("returns a nonzero exit without hiding stderr", async () => {
  const result = await runCommand("/bin/sh", ["-c", "echo broken >&2; exit 7"]);
  expect(result.exitCode).toBe(7);
  expect(result.stderr.trim()).toBe("broken");
});

test("aborts a running command", async () => {
  const controller = new AbortController();
  const result = runCommand("/bin/sleep", ["10"], controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow();
});

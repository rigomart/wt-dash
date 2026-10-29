import type { CommandResult } from "./types";

export async function runCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  environment?: Record<string, string>,
): Promise<CommandResult> {
  if (signal?.aborted) throw new Error("Command aborted");
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const onAbort = () => child.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (signal?.aborted) throw new Error("Command aborted");
    return { stdout, stderr, exitCode };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function failure(name: string, result: { exitCode: number; stderr: string }): Error {
  return new Error(
    `${name} exited ${result.exitCode}: ${result.stderr.trim() || "no error details"}`,
  );
}

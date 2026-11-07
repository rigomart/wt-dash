import type { CommandRunner, ForgeUncheckedReason } from "../types";
import type { GraphqlReply, GraphqlRequest } from "./query";

/** How long one request may take before its rows count as not checked. */
export const GH_TIMEOUT_MS = 15_000;

/** gh never stops to ask a question or to announce an update. */
export const GH_ENV = { GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" };

export type GhOutcome =
  | ({ kind: "reply" } & GraphqlReply)
  | {
      kind: "unchecked";
      why: Extract<ForgeUncheckedReason, "gh-missing" | "signed-out" | "failed">;
    };

/**
 * `gh api graphql` on github.com, with the query and every variable passed as a raw string with `-f`. Without
 * `--hostname`, gh would use `GH_HOST` or the only host it is signed in to, such as a GitHub Enterprise server.
 */
export function ghArgs(request: GraphqlRequest): string[] {
  return [
    "api",
    "graphql",
    "--hostname",
    "github.com",
    "-f",
    `query=${request.query}`,
    ...Object.entries(request.variables).flatMap(([key, value]) => ["-f", `${key}=${value}`]),
  ];
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Sends `request` through the user's `gh` at `ghPath`. Exit 1 with JSON on stdout still gives the data GitHub
 * returned, with its errors' paths. Throws only when `signal` aborts, so an aborted check reports nothing.
 */
export async function runGraphql(
  ghPath: string,
  request: GraphqlRequest,
  runner: CommandRunner,
  signal: AbortSignal,
  timeoutMs = GH_TIMEOUT_MS,
): Promise<GhOutcome> {
  const unchecked = (why: Extract<GhOutcome, { kind: "unchecked" }>["why"]): GhOutcome => ({
    kind: "unchecked",
    why,
  });
  const timeout = AbortSignal.timeout(timeoutMs);
  let result;
  try {
    result = await runner(ghPath, ghArgs(request), AbortSignal.any([signal, timeout]), GH_ENV);
  } catch (error) {
    if (signal.aborted) throw error;
    if (timeout.aborted) return unchecked("failed");
    return unchecked((error as NodeJS.ErrnoException).code === "ENOENT" ? "gh-missing" : "failed");
  }
  if (signal.aborted) throw new Error("Command aborted");
  if (result.exitCode === 4) return unchecked("signed-out");
  if (result.exitCode !== 0 && result.exitCode !== 1) return unchecked("failed");
  let body: Record<string, unknown> | null;
  try {
    body = object(JSON.parse(result.stdout) as unknown);
  } catch {
    return unchecked("failed");
  }
  const data = object(body?.data);
  const errors = Array.isArray(body?.errors) ? body.errors.map(object) : [];
  if (!data || errors.some((error) => error?.type === "MAX_NODE_LIMIT_EXCEEDED"))
    return unchecked("failed");
  return {
    kind: "reply",
    repository: data.repository ?? null,
    errorPaths: errors.map((error) => (Array.isArray(error?.path) ? error.path : null)),
  };
}

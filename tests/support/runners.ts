import type { CommandResult, CommandRunner } from "../../src/core/types";

export interface Call {
  command: string;
  args: string[];
}

/** A command matcher; `command` is compared by its last path segment, so `wt` matches the resolved wtPath. */
export type Match = (call: Call) => boolean;

export const named =
  (name: string, ...argsIncluded: string[]): Match =>
  (call) =>
    call.command.split("/").at(-1) === name && argsIncluded.every((arg) => call.args.includes(arg));

/** Restricts `match` to commands that name `path` as an argument. */
export const on =
  (match: Match, path: string): Match =>
  (call) =>
    match(call) && call.args.includes(path);

/** A promise a gated command waits on until `release` runs or the command is aborted. */
export interface Gate {
  /** Resolves once a matching command reached the gate. */
  reached: Promise<Call>;
  release(): void;
}

export interface Recorder {
  runner: CommandRunner;
  /** Every command started, in order. */
  calls: Call[];
  count(match: Match): number;
  /**
   * Holds the next matching command until released; later matches run normally. A held command whose signal
   * aborts throws like an aborted command, so closing the services never waits on a gate.
   */
  gate(match: Match): Gate;
  /** Releases every gate, reached or not; call it in `finally` so a failing test never leaves one held. */
  releaseAll(): void;
  /** Answers matching commands with `result` instead of running them, until the returned function is called. */
  override(match: Match, result: CommandResult): () => void;
}

function hold(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Command aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    void wait.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/** Wraps a runner (usually `sandbox.runner`) to record, hold, or replace commands. */
export function record(base: CommandRunner): Recorder {
  const calls: Call[] = [];
  const gates: Array<{ match: Match; wait: Promise<void>; arrive(call: Call): void }> = [];
  const releases = new Set<() => void>();
  const overrides = new Set<{ match: Match; result: CommandResult }>();
  const runner: CommandRunner = async (command, args, signal, environment) => {
    const call = { command, args };
    calls.push(call);
    const gateIndex = gates.findIndex((gate) => gate.match(call));
    if (gateIndex >= 0) {
      const [gate] = gates.splice(gateIndex, 1);
      gate!.arrive(call);
      await hold(gate!.wait, signal);
    }
    for (const entry of overrides) if (entry.match(call)) return entry.result;
    return base(command, args, signal, environment);
  };
  return {
    runner,
    calls,
    count: (match) => calls.filter(match).length,
    gate(match) {
      let release!: () => void;
      let arrive!: (call: Call) => void;
      const wait = new Promise<void>((resolve) => (release = resolve));
      const reached = new Promise<Call>((resolve) => (arrive = resolve));
      gates.push({ match, wait, arrive });
      releases.add(release);
      return { reached, release };
    },
    releaseAll() {
      for (const release of releases) release();
    },
    override(match, result) {
      const entry = { match, result };
      overrides.add(entry);
      return () => overrides.delete(entry);
    },
  };
}

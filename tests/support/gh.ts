import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A fake GitHub CLI for the sandbox. `gh-cli.ts` is the executable; this module holds the GitHub model it
 * answers from, and `createFakeGh`, which the fixture uses to write that model and read the calls made.
 * It answers only `gh api graphql -f query=… -f <variable>=…`, and only the fields wt-dash's query asks for.
 */

/** The environment variable naming the state file the fake reads on every call. */
export const GH_STATE_ENV = "WT_DASH_FAKE_GH_STATE";
/** The environment variable naming the JSONL file the fake appends each call to. */
export const GH_LOG_ENV = "WT_DASH_FAKE_GH_LOG";

/**
 * How the fake answers: `ok` from the model; `signed-out`, `bad-credentials` and `offline` with the real
 * CLI's exit code and message; `missing-repo` as if no repository in the model existed.
 */
export type GhMode = "ok" | "signed-out" | "bad-credentials" | "offline" | "missing-repo";

export interface GhCommit {
  oid: string;
  tree: string;
}

/** A merged pull request. */
export interface GhPullRequest {
  number: number;
  mergedAt: string;
  /** The branch it was merged into, `baseRefName`. */
  base: string;
  headRefName: string;
  headRefOid: string;
  /** `owner/name` of the repository its head branch lives in, when that's a fork. */
  headRepository?: string;
  /** Its commits, oldest first, as GitHub lists them after any force push. */
  commits: GhCommit[];
}

export interface GhRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  pullRequests: GhPullRequest[];
}

/** The state file: what GitHub holds, and how the fake answers. */
export interface GhState {
  mode: GhMode;
  /** Milliseconds every call waits after it is logged and before it answers. */
  delayMs?: number;
  repos: GhRepo[];
}

/** One line of the call log. */
export interface GhCall {
  argv: string[];
  cwd: string;
  /** The caller's `GH_*` and `GITHUB_*` variables, and `NO_COLOR`. */
  env: Record<string, string>;
}

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const emptyGhState = (): GhState => ({ mode: "ok", repos: [] });

const failures: Record<Exclude<GhMode, "ok" | "missing-repo">, GhResult> = {
  "signed-out": {
    stdout: "",
    stderr:
      "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n",
    exitCode: 4,
  },
  "bad-credentials": { stdout: "", stderr: "gh: Bad credentials (HTTP 401)\n", exitCode: 1 },
  offline: {
    stdout: "",
    stderr: 'Post "https://api.github.com/graphql": dial tcp: connection refused\n',
    exitCode: 1,
  },
};

/** The fake's own failures: a call outside the contract, so the test that made it fails loudly. */
const refuse = (message: string): GhResult => ({
  stdout: "",
  stderr: `fake gh: ${message}\n`,
  exitCode: 2,
});

/** Answers one `gh` invocation, given its arguments without the leading `gh`. */
export function answerGh(state: GhState, args: string[]): GhResult {
  if (args[0] !== "api" || args[1] !== "graphql")
    return refuse(
      `only "gh api graphql -f …" is supported, not "gh ${args.join(" ")}". Extend tests/support/gh.ts if the app needs it.`,
    );
  const fields: Record<string, string> = {};
  for (let index = 2; index < args.length; index++) {
    const arg = args[index]!;
    let field: string | undefined;
    if (arg === "-f" || arg === "--raw-field") field = args[++index];
    else if (arg.startsWith("--raw-field=")) field = arg.slice("--raw-field=".length);
    else if (arg.startsWith("-f") && arg.length > 2) field = arg.slice(2);
    else if (arg === "-F" || arg.startsWith("-F") || arg.startsWith("--field"))
      return refuse(`${arg}: pass every value with -f, which never converts types or reads files`);
    else return refuse(`unsupported argument ${JSON.stringify(arg)}`);
    const equals = field?.indexOf("=") ?? -1;
    if (field === undefined || equals < 1) return refuse(`-f needs key=value, got ${field}`);
    fields[field.slice(0, equals)] = field.slice(equals + 1);
  }
  if (state.mode !== "ok" && state.mode !== "missing-repo") return failures[state.mode];
  const { query, ...variables } = fields;
  if (query === undefined) return refuse("no -f query=…");

  const errors: Array<{ message: string; type?: string; path?: string[] }> = [];
  let data: unknown;
  try {
    const operation = parse(query);
    const values = bindVariables(operation, variables);
    data = project(root(state, errors), operation.selections, values);
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    errors.push({ message: error.message });
    data = undefined;
  }
  const body = data === undefined ? { errors } : errors.length ? { data, errors } : { data };
  return {
    stdout: JSON.stringify(body),
    stderr: errors.map(({ message }) => `gh: ${message}\n`).join(""),
    exitCode: errors.length ? 1 : 0,
  };
}

class QueryError extends Error {}

// ---- A GraphQL subset: one query operation, fields with aliases and arguments, inline fragments.

type Value =
  | { kind: "variable"; name: string }
  | { kind: "literal"; value: unknown }
  | { kind: "list"; items: Value[] }
  | { kind: "object"; fields: Record<string, Value> };

interface Field {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Selection[];
}
type Selection = Field | { on: string; selections: Selection[] };

interface Operation {
  /** Declared variables and their types, such as `GitObjectID!`. */
  variables: Record<string, string>;
  selections: Selection[];
}

const token = /\s+|,|#[^\n]*|(\.\.\.|[{}():!$[\]=]|"(?:[^"\\]|\\.)*"|-?\d+|[A-Za-z_]\w*)/y;

function parse(query: string): Operation {
  const tokens: string[] = [];
  token.lastIndex = 0;
  while (token.lastIndex < query.length) {
    const at = token.lastIndex;
    const match = token.exec(query);
    if (!match) throw new QueryError(`Parse error on ${JSON.stringify(query.slice(at, at + 20))}`);
    if (match[1] !== undefined) tokens.push(match[1]);
  }
  let position = 0;
  const peek = () => tokens[position];
  const next = () => {
    const value = tokens[position++];
    if (value === undefined) throw new QueryError("Parse error: unexpected end of query");
    return value;
  };
  const expect = (value: string) => {
    const got = next();
    if (got !== value) throw new QueryError(`Parse error: expected ${value}, got ${got}`);
  };
  const name = () => {
    const value = next();
    if (!/^[A-Za-z_]\w*$/.test(value))
      throw new QueryError(`Parse error: expected a name, got ${value}`);
    return value;
  };

  function value(): Value {
    const first = next();
    if (first === "$") return { kind: "variable", name: name() };
    if (first === "[") {
      const items: Value[] = [];
      while (peek() !== "]") items.push(value());
      next();
      return { kind: "list", items };
    }
    if (first === "{") {
      const fields: Record<string, Value> = {};
      while (peek() !== "}") {
        const key = name();
        expect(":");
        fields[key] = value();
      }
      next();
      return { kind: "object", fields };
    }
    if (first.startsWith('"')) return { kind: "literal", value: JSON.parse(first) as string };
    if (/^-?\d+$/.test(first)) return { kind: "literal", value: Number(first) };
    if (first === "true" || first === "false") return { kind: "literal", value: first === "true" };
    if (first === "null") return { kind: "literal", value: null };
    if (/^[A-Za-z_]\w*$/.test(first)) return { kind: "literal", value: first };
    throw new QueryError(`Parse error: unexpected ${first}`);
  }

  function selections(): Selection[] {
    expect("{");
    const out: Selection[] = [];
    while (peek() !== "}") {
      if (peek() === "...") {
        next();
        if (next() !== "on")
          throw new QueryError("Parse error: only inline fragments are supported");
        const on = name();
        out.push({ on, selections: selections() });
        continue;
      }
      let alias: string | null = null;
      let fieldName = name();
      if (peek() === ":") {
        next();
        alias = fieldName;
        fieldName = name();
      }
      const args: Record<string, Value> = {};
      if (peek() === "(") {
        next();
        while (peek() !== ")") {
          const key = name();
          expect(":");
          args[key] = value();
        }
        next();
      }
      out.push({
        alias,
        name: fieldName,
        args,
        selections: peek() === "{" ? selections() : [],
      });
    }
    next();
    return out;
  }

  const variables: Record<string, string> = {};
  if (peek() === "query") {
    next();
    if (peek() !== "(" && peek() !== "{") name();
    if (peek() === "(") {
      next();
      while (peek() !== ")") {
        expect("$");
        const variable = name();
        expect(":");
        let type = "";
        while (peek() !== "$" && peek() !== ")") {
          const part = next();
          if (part === "=") throw new QueryError("Parse error: default values aren't supported");
          type += part;
        }
        variables[variable] = type;
      }
      next();
    }
  }
  const operation = { variables, selections: selections() };
  if (position !== tokens.length) throw new QueryError("Parse error: text after the operation");
  return operation;
}

/** Checks the `-f` values against the declared variables, as GitHub does, and returns them by name. */
function bindVariables(
  operation: Operation,
  given: Record<string, string>,
): Record<string, string> {
  const used = new Set<string>();
  const visit = (value: Value) => {
    if (value.kind === "variable") used.add(value.name);
    else if (value.kind === "list") value.items.forEach(visit);
    else if (value.kind === "object") Object.values(value.fields).forEach(visit);
  };
  const walk = (list: Selection[]) => {
    for (const selection of list) {
      if ("name" in selection) Object.values(selection.args).forEach(visit);
      walk(selection.selections);
    }
  };
  walk(operation.selections);
  for (const name of used)
    if (!(name in operation.variables))
      throw new QueryError(`Variable $${name} is used by anonymous query but not declared`);
  for (const [name, type] of Object.entries(operation.variables)) {
    if (!used.has(name))
      throw new QueryError(`Variable $${name} is declared by anonymous query but not used`);
    const value = given[name];
    if (value === undefined) {
      if (type.endsWith("!"))
        throw new QueryError(`Variable $${name} of type ${type} was provided invalid value`);
      continue;
    }
    if (type.startsWith("GitObjectID") && !/^[0-9a-f]{40}$/i.test(value))
      throw new QueryError(`Variable $${name} of type ${type} was provided invalid value`);
    if (!/^(String|GitObjectID)!?$/.test(type))
      throw new QueryError(`fake gh: variables of type ${type} aren't modelled; -f sends strings`);
  }
  return given;
}

function resolve(value: Value, variables: Record<string, string>): unknown {
  switch (value.kind) {
    case "variable":
      return variables[value.name] ?? null;
    case "literal":
      return value.value;
    case "list":
      return value.items.map((item) => resolve(item, variables));
    case "object":
      return Object.fromEntries(
        Object.entries(value.fields).map(([key, field]) => [key, resolve(field, variables)]),
      );
  }
}

/** A GraphQL object: plain fields, or functions of the field's arguments. `__typename` names its type. */
type Node = { __typename: string } & Record<string, unknown>;
type Args = Record<string, unknown>;

function project(value: unknown, list: Selection[], variables: Record<string, string>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => project(item, list, variables));
  const node = value as Node;
  const out: Record<string, unknown> = {};
  for (const selection of list) {
    if (!("name" in selection)) {
      if (node.__typename === selection.on)
        Object.assign(out, project(node, selection.selections, variables));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === "__typename") {
      out[key] = node.__typename;
      continue;
    }
    if (!(selection.name in node))
      throw new QueryError(
        `Field '${selection.name}' doesn't exist on type '${node.__typename}' (or the fake doesn't model it)`,
      );
    const args = Object.fromEntries(
      Object.entries(selection.args).map(([name, arg]) => [name, resolve(arg, variables)]),
    );
    let field = node[selection.name];
    if (typeof field === "function") field = (field as (args: Args) => unknown)(args);
    else if (Object.keys(args).length)
      throw new QueryError(`Field '${selection.name}' doesn't accept arguments`);
    const scalar = typeof field !== "object";
    if (selection.selections.length ? scalar : field !== null && !scalar)
      throw new QueryError(
        `Field '${selection.name}' on type '${node.__typename}' ${scalar ? "has no subfields" : "must have a selection of subfields"}`,
      );
    out[key] = selection.selections.length
      ? project(field, selection.selections, variables)
      : field;
  }
  return out;
}

// ---- The model as GraphQL objects.

function page<T>(items: T[], args: Args, field: string): T[] {
  const first = args.first;
  const last = args.last;
  if (typeof first !== "number" && typeof last !== "number")
    throw new QueryError(
      `You must provide a \`first\` or \`last\` value to properly paginate the \`${field}\` connection.`,
    );
  if (typeof first === "number") items = items.slice(0, first);
  if (typeof last === "number") items = items.slice(Math.max(0, items.length - last));
  return items;
}

function root(
  state: GhState,
  errors: Array<{ message: string; type?: string; path?: string[] }>,
): Node {
  return {
    __typename: "Query",
    rateLimit: { __typename: "RateLimit", cost: 1, remaining: 4999, limit: 5000 },
    repository: ({ owner, name }: Args) => {
      const repo =
        state.mode === "missing-repo"
          ? undefined
          : state.repos.find(
              (candidate) =>
                candidate.owner.toLowerCase() === String(owner).toLowerCase() &&
                candidate.name.toLowerCase() === String(name).toLowerCase(),
            );
      if (repo) return repository(repo);
      errors.push({
        type: "NOT_FOUND",
        path: ["repository"],
        message: `Could not resolve to a Repository with the name '${owner}/${name}'.`,
      });
      return null;
    },
  };
}

function repository(repo: GhRepo): Node {
  const nameWithOwner = `${repo.owner}/${repo.name}`;
  const byMerge = [...repo.pullRequests].sort(
    (a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.number - b.number,
  );
  const node: Node = {
    __typename: "Repository",
    name: repo.name,
    nameWithOwner,
    defaultBranchRef: { __typename: "Ref", name: repo.defaultBranch },
    object: ({ oid, expression }: Args) => {
      if (expression !== undefined)
        throw new QueryError("fake gh: object(expression:) isn't modelled");
      const found = repo.pullRequests
        .flatMap((pr) => pr.commits)
        .find((commit) => commit.oid === String(oid).toLowerCase());
      return found ? commit(found) : null;
    },
    pullRequests: (args: Args) => {
      const states = [args.states ?? []].flat();
      const order = args.orderBy as { field?: string; direction?: string } | undefined;
      if (order && order.field !== "CREATED_AT")
        throw new QueryError(`fake gh: orderBy ${order.field} isn't modelled`);
      // Numbers grow with creation time.
      const sorted = [...repo.pullRequests].sort((a, b) =>
        order?.direction === "DESC" ? b.number - a.number : a.number - b.number,
      );
      const nodes = sorted.filter(
        (pr) =>
          (!states.length || states.includes("MERGED")) &&
          (args.headRefName === undefined || pr.headRefName === args.headRefName) &&
          (args.baseRefName === undefined || pr.base === args.baseRefName),
      );
      return {
        __typename: "PullRequestConnection",
        totalCount: nodes.length,
        nodes: page(nodes, args, "pullRequests").map(pullRequest),
      };
    },
  };
  function commit(found: GhCommit): Node {
    return {
      __typename: "Commit",
      oid: found.oid,
      tree: { __typename: "Tree", oid: found.tree },
      // GitHub lists the pull request that first brought the commit in, not later ones that contain it too.
      associatedPullRequests: (args: Args) => {
        const first = byMerge.find((pr) => pr.commits.some(({ oid }) => oid === found.oid));
        const nodes = first ? [pullRequest(first)] : [];
        return {
          __typename: "PullRequestConnection",
          totalCount: nodes.length,
          nodes: page(nodes, args, "associatedPullRequests"),
        };
      },
    };
  }
  function pullRequest(pr: GhPullRequest): Node {
    return {
      __typename: "PullRequest",
      number: pr.number,
      state: "MERGED",
      merged: true,
      mergedAt: pr.mergedAt,
      baseRefName: pr.base,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      repository: node,
      headRepository: {
        __typename: "Repository",
        nameWithOwner: pr.headRepository ?? nameWithOwner,
      },
      commits: (args: Args) => ({
        __typename: "PullRequestCommitConnection",
        totalCount: pr.commits.length,
        nodes: page(pr.commits, args, "commits").map((found) => ({
          __typename: "PullRequestCommit",
          commit: commit(found),
        })),
      }),
    };
  }
  return node;
}

// ---- The query wt-dash will send, for tests that call the fake as the app will.

const range = (count: number) => Array.from({ length: count }, (_, index) => index);

/** The lookup query: `aN` asks for commit `$oidN`, `bN` for merged pull requests from branch `$headN`. */
export function lookupQuery(oids: number, heads: number): string {
  const variables = [
    "$owner:String!",
    "$name:String!",
    ...range(oids).map((index) => `$oid${index}:GitObjectID!`),
    ...range(heads).map((index) => `$head${index}:String!`),
  ];
  return `query(${variables.join(",")}) {
  rateLimit { cost remaining }
  repository(owner:$owner, name:$name) {
    defaultBranchRef { name }
${range(oids)
  .map(
    (index) => `    a${index}: object(oid:$oid${index}) { ... on Commit {
      associatedPullRequests(first:5) { nodes { number state mergedAt baseRefName headRefName headRefOid
        repository { nameWithOwner defaultBranchRef { name } } } } } }`,
  )
  .join("\n")}
${range(heads)
  .map(
    (
      index,
    ) => `    b${index}: pullRequests(headRefName:$head${index}, states:MERGED, first:5, orderBy:{field:CREATED_AT,direction:DESC}) {
      nodes { number mergedAt baseRefName headRefOid headRepository { nameWithOwner }
        commits(last:250) { nodes { commit { oid tree { oid } } } } } }`,
  )
  .join("\n")}
  }
}`;
}

/** The chained query: `kN` asks for pull requests that merged branch `$baseN` into `$default`. */
export function chainedQuery(bases: number): string {
  const variables = [
    "$owner:String!",
    "$name:String!",
    "$default:String!",
    ...range(bases).map((index) => `$base${index}:String!`),
  ];
  return `query(${variables.join(",")}) {
  rateLimit { cost remaining }
  repository(owner:$owner, name:$name) {
${range(bases)
  .map(
    (index) =>
      `    k${index}: pullRequests(headRefName:$base${index}, baseRefName:$default, states:MERGED, first:5, orderBy:{field:CREATED_AT,direction:DESC}) { nodes { number mergedAt commits(last:250) { nodes { commit { oid } } } } }`,
  )
  .join("\n")}
  }
}`;
}

/** `gh` arguments for `query`, every value passed with `-f` as the app will. */
export function graphqlArgs(query: string, variables: Record<string, string>): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    ...Object.entries(variables).flatMap(([key, value]) => ["-f", `${key}=${value}`]),
  ];
}

/** The environment the app will run `gh` with. */
export const GH_ENV = { GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" };

// ---- The fixture's side: writing the model and reading the log.

export interface FakeGh {
  /** A folder holding only the fake `gh`, first on the sandbox PATH when `installed`. */
  bin: string;
  /** Whether the sandbox PATH has the fake; when false it has no `gh` at all. */
  installed: boolean;
  statePath: string;
  logPath: string;
  /** The model as last written. */
  state(): GhState;
  /** Changes the model and writes it before resolving; calls are applied in order. */
  update(change: (state: GhState) => void): Promise<GhState>;
  setMode(mode: GhMode, delayMs?: number): Promise<GhState>;
  /** Adds `owner/name` with no pull requests, unless the model has it. */
  addRepo(owner: string, name: string, defaultBranch?: string): Promise<GhState>;
  addPullRequest(owner: string, name: string, pullRequest: GhPullRequest): Promise<GhState>;
  /** Every call made so far, oldest first. */
  calls(): Promise<GhCall[]>;
}

/** Writes the fake's state, log and executable into `folder`. `installed` only records the fixture's choice. */
export async function createFakeGh(folder: string, installed: boolean): Promise<FakeGh> {
  const bin = join(folder, "bin");
  const statePath = join(folder, "state.json");
  const logPath = join(folder, "calls.jsonl");
  await mkdir(bin, { recursive: true });
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "gh-cli.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(logPath, "");
  let current = emptyGhState();
  let writing = Promise.resolve();
  const save = async () => {
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(current, null, 2));
    await rename(temporary, statePath);
  };
  await save();
  const update = (change: (state: GhState) => void): Promise<GhState> => {
    const done = writing.then(async () => {
      const next = structuredClone(current);
      change(next);
      current = next;
      await save();
      return structuredClone(current);
    });
    writing = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  };
  const repoIn = (state: GhState, owner: string, name: string) => {
    const repo = state.repos.find(
      (candidate) => candidate.owner === owner && candidate.name === name,
    );
    if (!repo) throw new Error(`The fake GitHub has no ${owner}/${name}; add it first`);
    return repo;
  };
  return {
    bin,
    installed,
    statePath,
    logPath,
    state: () => structuredClone(current),
    update,
    setMode: (mode, delayMs) =>
      update((state) => {
        state.mode = mode;
        if (delayMs === undefined) delete state.delayMs;
        else state.delayMs = delayMs;
      }),
    addRepo: (owner, name, defaultBranch = "main") =>
      update((state) => {
        if (!state.repos.some((repo) => repo.owner === owner && repo.name === name))
          state.repos.push({ owner, name, defaultBranch, pullRequests: [] });
      }),
    addPullRequest: (owner, name, pullRequest) =>
      update((state) => {
        const repo = repoIn(state, owner, name);
        if (repo.pullRequests.some(({ number }) => number === pullRequest.number))
          throw new Error(`${owner}/${name} already has PR #${pullRequest.number}`);
        repo.pullRequests.push(pullRequest);
      }),
    async calls() {
      const text = await readFile(logPath, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GhCall);
    },
  };
}

/** Appends one call to the log; used by gh-cli.ts. */
export async function logGhCall(path: string, call: GhCall): Promise<void> {
  await appendFile(path, `${JSON.stringify(call)}\n`);
}

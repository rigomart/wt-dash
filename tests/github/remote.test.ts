import { expect, test } from "bun:test";
import { parseGitHubUrl, readGitHubRepo } from "../../src/core/github/remote";
import type { CommandRunner } from "../../src/core/types";

test.each([
  ["https://github.com/acme/app.git", { owner: "acme", name: "app" }],
  ["https://github.com/acme/app", { owner: "acme", name: "app" }],
  ["https://github.com/acme/app/", { owner: "acme", name: "app" }],
  ["https://token@github.com/acme/my.app.git", { owner: "acme", name: "my.app" }],
  ["https://GitHub.com/Acme/App.git\n", { owner: "Acme", name: "App" }],
  ["git@github.com:acme/app.git", { owner: "acme", name: "app" }],
  ["git@github.com:acme/app", { owner: "acme", name: "app" }],
  ["ssh://git@github.com/acme/app.git", { owner: "acme", name: "app" }],
  ["ssh://git@github.com:22/acme/app.git", { owner: "acme", name: "app" }],
])("%s is a GitHub remote", (url, repo) => {
  expect(parseGitHubUrl(url)).toEqual(repo);
});

test.each([
  "http://github.com/acme/app.git",
  "https://gitlab.com/acme/app.git",
  "https://github.example.com/acme/app.git",
  "https://github.com.evil.dev/acme/app.git",
  "https://github.com/acme",
  "https://github.com/acme/app/tree/main",
  "git@gitlab.com:acme/app.git",
  "/srv/git/app.git",
  "../app",
  "",
])("%p is not", (url) => {
  expect(parseGitHubUrl(url)).toBeNull();
});

function config(values: Record<string, string>) {
  const asked: string[] = [];
  const runner: CommandRunner = async (_command, args) => {
    const key = args.at(-1)!;
    asked.push(key);
    const value = values[key];
    return value === undefined
      ? { stdout: "", stderr: "", exitCode: 1 }
      : { stdout: `${value}\n`, stderr: "", exitCode: 0 };
  };
  return { runner, asked };
}

test("the remote the default branch tracks names the repository, read as configured", async () => {
  const { runner, asked } = config({
    "branch.trunk.remote": "upstream",
    "remote.upstream.url": "git@github.com:acme/app.git",
    "remote.origin.url": "https://github.com/me/app.git",
  });
  expect(await readGitHubRepo("/repo", "trunk", runner)).toEqual({ owner: "acme", name: "app" });
  expect(asked).toEqual(["branch.trunk.remote", "remote.upstream.url"]);
});

test("without a tracked remote it is origin's; a remote off GitHub, or none, gives null", async () => {
  const origin = config({ "remote.origin.url": "https://github.com/me/app.git" });
  expect(await readGitHubRepo("/repo", "main", origin.runner)).toEqual({
    owner: "me",
    name: "app",
  });
  expect(origin.asked).toEqual(["branch.main.remote", "remote.origin.url"]);
  expect(await readGitHubRepo("/repo", null, origin.runner)).toEqual({ owner: "me", name: "app" });
  const gitlab = config({ "remote.origin.url": "https://gitlab.com/me/app.git" });
  expect(await readGitHubRepo("/repo", "main", gitlab.runner)).toBeNull();
  expect(await readGitHubRepo("/repo", "main", config({}).runner)).toBeNull();
});

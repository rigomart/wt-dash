import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

test("uses the default folders when none are given and resolves supplied folders independently", () => {
  expect(parseArgs([], "/Users/test", "/Users/test/code")).toMatchObject({
    roots: ["projects", "code", "dev", "src", "work"].map((folder) => `/Users/test/${folder}`),
    defaults: true,
    depth: 2,
    mode: "run",
  });
  expect(
    parseArgs(
      ["../work", "~/personal", "--depth", "4", "--wt-path", "/custom/wt"],
      "/Users/test",
      "/Users/test/code",
    ),
  ).toMatchObject({
    roots: ["/Users/test/work", "/Users/test/personal"],
    defaults: false,
    depth: 4,
    wtPath: "/custom/wt",
  });
});

test("rejects unknown options, missing values, and invalid scan depths", () => {
  for (const args of [
    ["--unknown"],
    ["--depth"],
    ["--wt-path"],
    ["--depth", "-1"],
    ["--depth", "1.5"],
    ["--depth", "Infinity"],
    ["--depth", "21"],
  ]) {
    expect(() => parseArgs(args, "/Users/test", "/repo")).toThrow();
  }
  expect(parseArgs(["--depth", "0", "--", "-folder"], "/Users/test", "/repo").roots).toEqual([
    "/repo/-folder",
  ]);
});

test("help, version and doctor have explicit modes", () => {
  expect(parseArgs(["--help"], "/home", "/repo").mode).toBe("help");
  expect(parseArgs(["-v"], "/home", "/repo").mode).toBe("version");
  expect(parseArgs(["--doctor", "."], "/home", "/repo").mode).toBe("doctor");
});

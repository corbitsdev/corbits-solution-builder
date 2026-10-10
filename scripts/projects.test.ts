import { describe, expect, test } from "bun:test";
import { parseLaunchLine } from "./lib/owner-host.ts";
import { bundleOf, projectSlug } from "./lib/project-transfer.ts";
import { parseArgs, uniqueBundlePath, UsageError } from "./projects.ts";

describe("parseArgs", () => {
  test("export takes --all or ids, never both or neither", () => {
    expect(parseArgs(["export", "--all"]).all).toBe(true);
    expect(parseArgs(["export", "tnt_1", "tnt_2"]).positional).toEqual(["tnt_1", "tnt_2"]);
    expect(() => parseArgs(["export"])).toThrow(UsageError);
    expect(() => parseArgs(["export", "--all", "tnt_1"])).toThrow(UsageError);
  });

  test("import needs a file; list takes nothing", () => {
    expect(() => parseArgs(["import"])).toThrow(UsageError);
    expect(parseArgs(["import", "a.json", "b.zip"]).positional).toEqual(["a.json", "b.zip"]);
    expect(() => parseArgs(["list", "x"])).toThrow(UsageError);
    expect(parseArgs(["list", "--json"]).json).toBe(true);
  });

  test("the host comes from flags or the environment, token alongside", () => {
    const flagged = parseArgs(["list", "--host", "http://127.0.0.1:5000/", "--token", "t"]);
    expect(flagged.host).toBe("http://127.0.0.1:5000");
    expect(flagged.token).toBe("t");
    const fromEnv = parseArgs(["list"], { SOLUTIONS_BUILDER_HOST_URL: "http://h:1", SOLUTIONS_BUILDER_HOST_TOKEN: "k" });
    expect(fromEnv.host).toBe("http://h:1");
    expect(() => parseArgs(["list", "--host", "http://h:1"])).toThrow(UsageError);
    expect(() => parseArgs(["list", "--token"])).toThrow(UsageError);
  });

  test("unknown commands and options are refused by name", () => {
    expect(() => parseArgs([])).toThrow("a command is required");
    expect(() => parseArgs(["frob"])).toThrow('unknown command "frob"');
    expect(() => parseArgs(["list", "--verbose"])).toThrow('unknown option "--verbose"');
  });

  test("--no-start, --archived and --out are read", () => {
    const options = parseArgs(["export", "--all", "--archived", "--out", "dump", "--no-start"]);
    expect(options).toMatchObject({ archived: true, out: "dump", start: false });
    expect(parseArgs(["export", "--all"]).out).toBe(".");
  });
});

describe("uniqueBundlePath", () => {
  test("two projects with one title get two files", () => {
    const taken = new Set<string>();
    expect(uniqueBundlePath("/d", "My App", "tnt_000000abcdef", taken)).toBe("/d/my-app.solutions-builder.json");
    expect(uniqueBundlePath("/d", "My App", "tnt_000000fedcba", taken)).toBe("/d/my-app-fedcba.solutions-builder.json");
  });
});

describe("parseLaunchLine", () => {
  test("reads the port and token off the host's handshake, or nothing yet", () => {
    expect(parseLaunchLine("Solution Builder host: http://127.0.0.1:4321 (api v1)\n")).toBeNull();
    expect(parseLaunchLine("Solution Builder launch URL: http://127.0.0.1:4321/?token=0a1b2c3d-0000-4000-8000-000000000000\n")).toEqual({
      origin: "http://127.0.0.1:4321",
      token: "0a1b2c3d-0000-4000-8000-000000000000",
    });
  });
});

describe("bundleOf", () => {
  test("refuses what is not a bundle, and a version 1 bundle from main, by name", () => {
    expect(() => bundleOf({ format: "something-else" })).toThrow("not a project bundle");
    expect(() => bundleOf({ format: "solutions-builder.project", version: 1, exportedAt: "x", project: { id: "p", title: "t", policy: {} }, artifacts: [], notes: "" })).toThrow("version 1 bundle");
  });

  test("accepts a version 4 bundle", () => {
    const bundle = bundleOf({ format: "solutions-builder.project", version: 4, exportedAt: "2026-01-01T00:00:00Z", project: { id: "p", title: "t", policy: {} }, artifacts: [], conversations: [], notes: "" });
    expect(bundle.project.title).toBe("t");
  });
});

test("projectSlug is sb- and twelve base-36 characters", () => {
  expect(projectSlug()).toMatch(/^sb-[0-9a-z]{12}$/);
});

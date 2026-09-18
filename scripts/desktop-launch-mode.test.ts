import { describe, expect, test } from "bun:test";
import {
  desktopLaunchMode,
  remoteHubUrl,
  shouldSpawnHost,
} from "./desktop-launch-mode.js";

describe("desktop launch mode", () => {
  test("absent hub URL is local and still spawns the host sidecar", () => {
    const mode = desktopLaunchMode({});
    expect(mode).toEqual({ kind: "local" });
    expect(shouldSpawnHost(mode)).toBe(true);
  });

  test("blank hub URL is local", () => {
    const mode = desktopLaunchMode({ SOLUTIONS_BUILDER_HUB_URL: "  " });
    expect(mode.kind).toBe("local");
    expect(shouldSpawnHost(mode)).toBe(true);
  });

  test("a remote hub URL does not spawn the host sidecar", () => {
    const mode = desktopLaunchMode({
      SOLUTIONS_BUILDER_HUB_URL: "https://hub.example.com/",
    });
    expect(mode).toEqual({ kind: "remote", url: "https://hub.example.com" });
    expect(shouldSpawnHost(mode)).toBe(false);
  });

  test("http loopback is a valid remote origin", () => {
    expect(remoteHubUrl("http://127.0.0.1:8080/app/")).toBe("http://127.0.0.1:8080/app");
  });

  test("file and missing-host URLs are refused rather than treated as local", () => {
    expect(() => remoteHubUrl("file:///etc/passwd")).toThrow(/http or https/);
    expect(() => remoteHubUrl("not a url")).toThrow(/not a valid URL/);
    expect(() => desktopLaunchMode({ SOLUTIONS_BUILDER_HUB_URL: "ftp://hub.example.com" })).toThrow(
      /http or https/,
    );
    expect(() => remoteHubUrl("https://user:pass@hub.example.com")).toThrow(/credentials/);
  });
});

import { describe, expect, test } from "bun:test";
import { LIFECYCLE_ASSET_NAME, lifecycleAssetName } from "./lifecycle-deploy.js";

describe("lifecycle-deploy", () => {
  test("names a project asset after the project id", () => {
    expect(lifecycleAssetName()).toBe(LIFECYCLE_ASSET_NAME);
    expect(lifecycleAssetName("tnt_AbC")).toBe(`${LIFECYCLE_ASSET_NAME}-tnt-abc`);
  });

  test("does not import the installer package", async () => {
    const source = await Bun.file(new URL("./lifecycle-deploy.ts", import.meta.url)).text();
    expect(source).not.toMatch(/from ["'][^"']*installer[^"']*["']/);
    expect(source).not.toMatch(/from ["'][^"']*workflow-closure[^"']*["']/);
  });
});

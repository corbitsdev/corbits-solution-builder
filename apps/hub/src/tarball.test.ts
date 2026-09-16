import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import ssri from "ssri";
import {
  packDirectory,
  packTarballFiles,
  pushTarball,
  tarballFilename,
  tarballIntegrity,
  tarballPushPath,
  type TarballFiles,
} from "./tarball.js";

const PKG: TarballFiles = {
  "package.json": new TextEncoder().encode(
    JSON.stringify({ name: "@scope/widget", version: "1.2.3" }),
  ),
  "dist/index.js": new TextEncoder().encode("export const x = 1;\n"),
};

/** Entry names and payloads out of a tar archive, parsed by hand: 512-byte
 *  records, the name in the first 100 bytes, the octal size at byte 124. */
function readTarEntries(tar: Uint8Array): { name: string; data: Uint8Array }[] {
  const bytes = Buffer.from(tar);
  const entries: { name: string; data: Uint8Array }[] = [];
  let offset = 0;
  for (;;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.length < 512 || header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").trim(), 8);
    const start = offset + 512;
    entries.push({ name, data: bytes.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("tarballFilename", () => {
  test("a scoped name flattens to the hub's tarball shape", () => {
    expect(tarballFilename("@scope/widget", "1.2.3")).toBe("@scope-widget-1.2.3.tgz");
  });

  test("a bare name just gains its version", () => {
    expect(tarballFilename("left-pad", "1.3.0")).toBe("left-pad-1.3.0.tgz");
  });

  test("no slash survives to become a path", () => {
    expect(tarballFilename("@a/b/c", "0.0.1")).not.toContain("/");
  });
});

describe("packTarballFiles", () => {
  test("packs real npm-tarball bytes: every entry under package/", async () => {
    const entries = readTarEntries(gunzipSync(Buffer.from(await packTarballFiles(PKG))));
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "package/dist/index.js",
      "package/package.json",
    ]);
    const manifest = entries.find((entry) => entry.name === "package/package.json")!;
    expect(Buffer.from(manifest.data).toString("utf8")).toBe(
      Buffer.from(PKG["package.json"]!).toString("utf8"),
    );
  });

  test("the same files pack to the same bytes, whatever order they arrive in", async () => {
    const reversed: TarballFiles = {};
    for (const key of Object.keys(PKG).reverse()) reversed[key] = PKG[key]!;
    const first = await packTarballFiles(PKG);
    const second = await packTarballFiles(reversed);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  test("entries cannot escape package/", async () => {
    await expect(packTarballFiles({ "../escape.js": new Uint8Array() })).rejects.toThrow();
    await expect(packTarballFiles({ "/absolute.js": new Uint8Array() })).rejects.toThrow();
  });
});

describe("packDirectory", () => {
  test("packs every regular file and skips what is not one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sb-tarball-test-"));
    try {
      await writeFile(join(dir, "package.json"), "{}");
      await writeFile(join(dir, "link.json"), "{}");
      await rm(join(dir, "link.json"));
      await symlink(join(dir, "package.json"), join(dir, "link.json"));
      const entries = readTarEntries(gunzipSync(Buffer.from(await packDirectory(dir))));
      expect(entries.map((entry) => entry.name)).toEqual(["package/package.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tarballIntegrity", () => {
  test("speaks the hub's integrity language over the packed bytes", async () => {
    const bytes = await packTarballFiles(PKG);
    expect(tarballIntegrity(bytes)).toBe(ssri.fromData(bytes, { algorithms: ["sha512"] }).toString());
  });
});

describe("pushTarball", () => {
  const bytes = new TextEncoder().encode("tarball bytes");

  test("PUTs the bytes at the hub's tarball route and returns its answer", async () => {
    const seen: { path: string; bytes: Uint8Array }[] = [];
    const result = await pushTarball(
      {
        putBytes: (path, sent) => {
          seen.push({ path, bytes: sent });
          return Promise.resolve({ commit: "abc", integrity: tarballIntegrity(sent) });
        },
      },
      { assetId: "asset-1", filename: "widget-1.2.3.tgz", bytes },
    );
    expect(result).toEqual({ commit: "abc", integrity: tarballIntegrity(bytes) });
    expect(seen.map((call) => call.path)).toEqual([
      tarballPushPath("asset-1", "widget-1.2.3.tgz"),
    ]);
    expect(seen[0]!.path).toBe("/assets/asset-1/tarballs/widget-1.2.3.tgz");
    expect(Buffer.from(seen[0]!.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  test("rejects when the hub reports anything but the bytes sent", async () => {
    await expect(
      pushTarball(
        { putBytes: () => Promise.resolve({ commit: "abc", integrity: "sha512-otherwise" }) },
        { assetId: "asset-1", filename: "widget-1.2.3.tgz", bytes },
      ),
    ).rejects.toThrow("different bytes");
  });
});

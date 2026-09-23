import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { ArchiveRefused, expandArchives, filesInZip, isZipArchive } from "./material-archive.ts";

async function zipFile(name: string, entries: Record<string, string | Uint8Array | { zip: Record<string, string> }>): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) {
    if (typeof content === "object" && !(content instanceof Uint8Array)) {
      const inner = new JSZip();
      for (const [innerPath, innerContent] of Object.entries(content.zip)) inner.file(innerPath, innerContent);
      zip.file(path, await inner.generateAsync({ type: "arraybuffer" }));
    } else {
      zip.file(path, content);
    }
  }
  return new File([await zip.generateAsync({ type: "arraybuffer" })], name, { type: "application/zip" });
}

describe("isZipArchive", () => {
  test("by the browser's type or by the extension when the browser gave none", () => {
    expect(isZipArchive({ name: "material.zip", type: "" })).toBe(true);
    expect(isZipArchive({ name: "material", type: "application/x-zip-compressed" })).toBe(true);
    expect(isZipArchive({ name: "notes.md", type: "text/markdown" })).toBe(false);
  });
});

describe("filesInZip", () => {
  test("attaches each keepable file under its path in the archive, in path order, with its type", async () => {
    const archive = await zipFile("material.zip", {
      "specs/requirements.md": "# Requirements",
      "data/costs.csv": "a,b\n1,2",
      "logo.png": new Uint8Array([137, 80, 78, 71]),
    });
    const files = await filesInZip(archive);
    expect(files.map((file) => [file.name, file.type])).toEqual([
      ["data/costs.csv", "text/csv"],
      ["logo.png", "image/png"],
      ["specs/requirements.md", "text/markdown"],
    ]);
    expect(await files[2]!.text()).toBe("# Requirements");
  });

  test("leaves out folders, what macOS adds, and kinds the specialists cannot read", async () => {
    const archive = await zipFile("material.zip", {
      "__MACOSX/._requirements.md": "junk",
      "specs/._requirements.md": "junk",
      "specs/.DS_Store": "junk",
      "Thumbs.db": "junk",
      "tool.exe": "binary",
      "specs/requirements.md": "# Requirements",
    });
    expect((await filesInZip(archive)).map((file) => file.name)).toEqual(["specs/requirements.md"]);
  });

  test("opens an archive inside an archive", async () => {
    const archive = await zipFile("outer.zip", { "inner.zip": { zip: { "deep/notes.txt": "hello" } }, "top.txt": "top" });
    expect((await filesInZip(archive)).map((file) => file.name)).toEqual(["deep/notes.txt", "top.txt"]);
  });

  test("refuses an archive with nothing keepable, and one that is not a zip, by name", async () => {
    const empty = await zipFile("empty.zip", { "tool.exe": "binary" });
    await expect(filesInZip(empty)).rejects.toThrow(ArchiveRefused);
    await expect(filesInZip(empty)).rejects.toThrow("empty.zip holds nothing this can keep.");
    const notZip = new File(["just text"], "notes.zip", { type: "application/zip" });
    await expect(filesInZip(notZip)).rejects.toThrow("notes.zip could not be read as a zip archive.");
  });
});

describe("expandArchives", () => {
  test("replaces each archive with its files in place and keeps everything else as it came", async () => {
    const archive = await zipFile("material.zip", { "b.md": "b", "a.md": "a" });
    const plain = new File(["c"], "c.md", { type: "text/markdown" });
    const files = await expandArchives([plain, archive]);
    expect(files.map((file) => file.name)).toEqual(["c.md", "a.md", "b.md"]);
    expect(files[0]).toBe(plain);
  });
});

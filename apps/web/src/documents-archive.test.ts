import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import type { ArtifactNode } from "./client.js";
import {
  MOCKUPS_FOLDER,
  archiveReadme,
  assembleDocumentsArchive,
  completedDocuments,
  documentFileName,
  documentsArchiveName,
  downloadProjectDocuments,
  mockupFileName,
} from "./documents-archive.ts";

const at = "2026-10-01T06:00:00.000Z";
function node(over: Partial<ArtifactNode> & { kind: string; stage: number }): ArtifactNode {
  return {
    id: `${over.kind}-${String(over.version ?? 1)}${over.variant ? `-${over.variant}` : ""}`,
    variant: null,
    title: over.kind,
    version: 1,
    artifactId: `art-${over.kind}`,
    contentHash: "",
    createdAt: at,
    supersededByNodeId: null,
    provenance: { producer: "specialist" },
    ...over,
  };
}

const PPTX = "data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,UEsDBA==";

// #323: the finished documents, newest of each, in process order; records stay out.
describe("completedDocuments", () => {
  test("keeps the newest unsuperseded version of each document lineage and orders by stage, kind and stakeholder", () => {
    const nodes = [
      node({ kind: "build_plan", stage: 6, version: 2 }),
      node({ kind: "product_requirements", stage: 6, version: 3 }),
      node({ kind: "product_requirements", stage: 6, version: 2, supersededByNodeId: "product_requirements-3" }),
      node({ kind: "audience_package", stage: 5, variant: "Tim Burke" }),
      node({ kind: "audience_package", stage: 5, variant: "Joe Filerman" }),
      node({ kind: "audience_deck", stage: 5, variant: "Joe Filerman" }),
      node({ kind: "design_artifact", stage: 4, mediaType: "text/html" }),
      node({ kind: "problem_brief", stage: 1 }),
      node({ kind: "source_material", stage: 1 }),
      node({ kind: "design_feedback", stage: 4 }),
      node({ kind: "build_evidence", stage: 8 }),
      node({ kind: "delivery_manifest", stage: 9 }),
    ];
    expect(completedDocuments(nodes).map((n) => `${n.kind}${n.variant ? `:${n.variant}` : ""}@${String(n.version)}`)).toEqual([
      "problem_brief@1",
      "design_artifact@1",
      "audience_package:Joe Filerman@1",
      "audience_package:Tim Burke@1",
      "audience_deck:Joe Filerman@1",
      "product_requirements@3",
      "build_plan@2",
    ]);
  });
});

describe("documentFileName", () => {
  test("names by stage and document, with the stakeholder, and the extension from the content or the kind", () => {
    expect(documentFileName(node({ kind: "product_requirements", stage: 6 }), "# PRD")).toBe("06-product-requirements.md");
    expect(documentFileName(node({ kind: "design_artifact", stage: 4, mediaType: "text/html" }), "<!doctype html>")).toBe("04-design.html");
    expect(documentFileName(node({ kind: "audience_deck", stage: 5, variant: "Barry Moneyman" }), PPTX)).toBe("05-slides-barry-moneyman.pptx");
    expect(documentFileName(node({ kind: "audience_package", stage: 5, variant: "Tim Burke" }), "## Package")).toBe("05-audience-package-tim-burke.md");
    expect(documentsArchiveName("Inteva Complete")).toBe("inteva-complete-documents.zip");
  });
});

describe("assembleDocumentsArchive", () => {
  test("writes each document under its name, slides as bytes, and a README that says how to get a PDF", async () => {
    const nodes = [
      node({ kind: "product_requirements", stage: 6, version: 3 }),
      node({ kind: "audience_deck", stage: 5, variant: "Joe Filerman" }),
      node({ kind: "build_plan", stage: 6 }),
    ];
    const contents: Record<string, string> = {
      product_requirements: "# Product requirements\n\nFR-1.",
      audience_deck: PPTX,
    };
    const archive = await assembleDocumentsArchive("Inteva Complete", nodes, async (n) => {
      const content = contents[n.kind];
      if (content === undefined) throw new Error("unreadable");
      return content;
    });
    expect(archive.files).toEqual(["05-slides-joe-filerman.pptx", "06-product-requirements.md"]);
    expect(archive.skipped).toEqual(["Build plan"]);
    const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["05-slides-joe-filerman.pptx", "06-product-requirements.md", "README.md"]);
    expect(await zip.file("06-product-requirements.md")!.async("string")).toBe("# Product requirements\n\nFR-1.");
    expect([...(await zip.file("05-slides-joe-filerman.pptx")!.async("uint8array"))]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const readme = await zip.file("README.md")!.async("string");
    expect(readme).toContain("# Inteva Complete — documents");
    expect(readme).toContain("06-product-requirements.md — Product requirements, version 3");
    expect(readme).toContain("Export → Print or save as PDF");
    expect(readme).toContain("Not included, since they could not be read: Build plan.");
  });

  test("the README lists slides with their stakeholder", () => {
    const readme = archiveReadme("P", [{ name: "05-slides-tim-burke.pptx", node: node({ kind: "audience_deck", stage: 5, variant: "Tim Burke" }) }]);
    expect(readme).toContain("05-slides-tim-burke.pptx — Slides for Tim Burke, version 1, written 2026-10-01");
  });
});

describe("downloadProjectDocuments", () => {
  test("reads the project, saves the zip under the project's name and says how many went in", async () => {
    const saved: string[] = [];
    const notice = await downloadProjectDocuments("proj_1", {
      projectView: async () => ({
        project: { title: "Inteva Complete" },
        tenantId: "tnt_1",
        nodes: [node({ kind: "product_requirements", stage: 6 }), node({ kind: "build_plan", stage: 6 })],
      }),
      artifactContent: async (_tenant, id) => ({ content: `# ${id}` }),
      save: (_blob, name) => {
        saved.push(name);
      },
    });
    expect(saved).toEqual(["inteva-complete-documents.zip"]);
    expect(notice).toBe("Saved 2 documents of Inteva Complete to inteva-complete-documents.zip.");
  });

  test("a project with nothing finished saves nothing and says so", async () => {
    const notice = await downloadProjectDocuments("proj_1", {
      projectView: async () => ({ project: { title: "Fresh" }, tenantId: "t", nodes: [node({ kind: "source_material", stage: 1 })] }),
      artifactContent: async () => ({ content: "" }),
      save: () => {
        throw new Error("must not save");
      },
    });
    expect(notice).toBe("Fresh has no finished documents yet.");
  });
});

// #334: each panel review is its own document, named for its reviewer.
describe("panel reviews in the archive", () => {
  test("four reviewers give four files, in reviewer order after the plan", () => {
    const nodes = [
      node({ kind: "build_plan", stage: 6 }),
      ...["Security", "Application", "Quality", "Platform"].map((who) => node({ kind: "engineering_review", stage: 6, variant: who })),
    ];
    expect(completedDocuments(nodes).map((n) => documentFileName(n, "# r"))).toEqual([
      "06-build-plan.md",
      "06-engineering-review-application.md",
      "06-engineering-review-platform.md",
      "06-engineering-review-quality.md",
      "06-engineering-review-security.md",
    ]);
  });
});

// #336: the design's screens ride along as pictures, in a folder of their own.
describe("mockups in the archive", () => {
  const design = '<!doctype html><html><body><section data-testid="screen-phone-home">a</section><section data-testid="screen-gantt">b</section></body></html>';
  const shots = [
    { name: "phone home", png: Uint8Array.of(1, 2) },
    { name: "gantt", png: Uint8Array.of(3) },
  ];

  test("each screen is a PNG under mockups/, named by its place and screen, and the README lists them", async () => {
    const nodes = [node({ kind: "design_artifact", stage: 4, mediaType: "text/html" }), node({ kind: "problem_brief", stage: 1 })];
    const asked: string[] = [];
    const archive = await assembleDocumentsArchive(
      "Inteva Complete",
      nodes,
      async (n) => (n.kind === "design_artifact" ? design : "# Brief"),
      async (html) => {
        asked.push(html);
        return shots;
      },
    );
    expect(asked).toEqual([design]);
    expect(archive.mockups).toEqual([`${MOCKUPS_FOLDER}/01-phone-home.png`, `${MOCKUPS_FOLDER}/02-gantt.png`]);
    expect(mockupFileName(0, { name: "Phone / Home" })).toBe("mockups/01-phone-home.png");
    const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
    expect(Object.keys(zip.files).filter((f) => !zip.files[f]!.dir).sort()).toEqual(["01-problem-brief.md", "04-design.html", "README.md", "mockups/01-phone-home.png", "mockups/02-gantt.png"]);
    expect([...(await zip.file("mockups/02-gantt.png")!.async("uint8array"))]).toEqual([3]);
    const readme = await zip.file("README.md")!.async("string");
    expect(readme).toContain("The design's screens as pictures, in mockups/:");
    expect(readme).toContain("- mockups/01-phone-home.png");
  });

  test("a design that cannot be drawn leaves the folder out and the HTML stands", async () => {
    const archive = await assembleDocumentsArchive("P", [node({ kind: "design_artifact", stage: 4, mediaType: "text/html" })], async () => design, async () => {
      throw new Error("no canvas here");
    });
    expect(archive.mockups).toEqual([]);
    expect(archive.files).toEqual(["04-design.html"]);
  });

  test("the notice counts the pictures", async () => {
    const notice = await downloadProjectDocuments("p", {
      projectView: async () => ({ project: { title: "P" }, tenantId: "t", nodes: [node({ kind: "design_artifact", stage: 4, mediaType: "text/html" })] }),
      artifactContent: async () => ({ content: design }),
      save: () => undefined,
      shoot: async () => shots,
    });
    expect(notice).toBe("Saved 1 document and 2 mockup pictures of P to p-documents.zip.");
  });
});

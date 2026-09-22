/**
 * Walks the whole UI.
 *
 * Renders every screen with fixture data and writes each to `/tmp/walk`, so
 * the product can be looked at as a product rather than one screenshot at a
 * time. Working from whichever screen someone last complained about fixes that
 * screen and misses the ones either side of it.
 *
 * The fixtures must carry what the real markup carries — the rail's icons are
 * a grid column, and omitting them makes the rail look broken in a way the
 * product is not. A harness that lies produces fixes for bugs nobody has.
 */
import { cp } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { ChatMessage } from "@corbits/react-ui";
import { GuideDock } from "../apps/web/src/components.js";
import { StageDocument } from "../apps/web/src/pages/workspace.js";
import { ArtifactStrip, VersionStrip } from "../apps/web/src/pages/workspace/artifact-strip.jsx";
import { ArtifactGraph } from "../apps/web/src/pages/graph.js";
import { AppBar } from "../apps/web/src/app.js";
import { ThemeProvider } from "@corbits/react-ui";
import { nextStep } from "@solutions-builder/app/next-step";
import { Projects } from "../apps/web/src/pages/projects.js";
import { Onboarding } from "../apps/web/src/pages/onboarding.js";

const now = "2026-09-08T12:00:00.000Z";

const projects = [
  { id: "prj_1", title: "An outreach agent", stage: 1, state: "in_progress", createdAt: now, updatedAt: now, policy: {} },
] as never;

const fixtureDetail = {
  project: { id: "prj_1", title: "An outreach agent" },
  stage: 1,
} as never;

/**
 * The product's own top bar, with fixture data — never a copy of it. A harness
 * that describes chrome the product does not have produces fixes for bugs
 * nobody has, and hides the surfaces it forgot to include.
 */
function Shell({
  at,
  body,
  fill,
}: {
  at: "projects" | "project" | "settings";
  body: ReactNode;
  fill?: boolean;
}) {
  return (
    <ThemeProvider>
      <div className="app">
        <AppBar
          view={at}
          detail={at === "project" ? fixtureDetail : null}
          decisions={[
            {
              id: "wai_1",
              projectId: "prj_1",
              projectTitle: "An outreach agent",
              title: "Stage 1 is waiting on a decision",
              consequence: "Problem Brief v1 ready — your approval opens Solution Shape",
              stage: 1,
              requiredAuthority: "project_owner",
              runId: "run_1",
              blockers: null,
            },
          ]}
          inbox={{ items: [], unreadCount: 0 }}
          bellOpen={false}
          onBellOpenChange={() => {}}
          onNavigate={() => {}}
          onOpenProject={() => {}}
          draftOpen
          onToggleDraft={() => {}}
        />
        <main className="canvas">
          {fill ? (
            <GuideDock step={step} at="stage" onGo={() => {}} />
          ) : null}
          <div className={`canvas-body${fill ? " is-fill" : ""}`}>{body}</div>
        </main>
      </div>
    </ThemeProvider>
  );
}

const messages: ChatMessage[] = [
  {
    id: "1",
    role: "agent",
    createdAt: now,
    parts: [
      {
        type: "text",
        text: "- Outreach is rebuilt **by hand every Monday**, and is stale before anyone acts on it.\n- A fix has to carry **the reason** a name was chosen, not just the name.\n- You approve every message before it sends.\n\nWho or what are you trying to reach — what is the target audience, and where does research fit?",
      },
    ],
  },
  { id: "2", role: "user", createdAt: now, parts: [{ type: "text", text: "Series A founders in fintech. Research means finding the company and who owns the problem." }] },
  { id: "3", role: "agent", createdAt: now, parts: [{ type: "text", text: "Should the agent send messages on its own, or draft them for your review before anything goes out?" }] },
];

const brief = `## In short

- Outreach is rebuilt **by hand every Monday**, and is stale before anyone acts on it.
- A fix has to carry **the reason** a name was chosen, not just the name.
- You approve every message before it sends.

## Problem statement

You want an agent that handles cold outbound — research, lead generation and the messages themselves. Right now that work is manual and it is eating the front of your week.

## Who is affected

You, primarily. If anyone else touches the list today, that changes the answer and I have assumed they do not.

## Success criteria

1. The morning list exists without anyone assembling it
2. Every name carries the reason it is there
3. You approve messages before anything sends

## What I assumed

- Outbound means sales pipeline, not hiring or fundraising
- Email is the channel, with LinkedIn possible later
`;

const step = nextStep({ state: "in_progress", stage: 1, hasDraft: true, soloApproval: true });

const briefNode = {
  id: "nod_1",
  artifactId: "art_1",
  version: 1,
  kind: "problem_brief",
  variant: null,
  stage: 1,
  title: "Brainstormer — stage 1",
  mediaType: "text/markdown",
  contentHash: "d37068f870f0",
  sizeBytes: 1180,
  sink: "local",
  supersededByNodeId: null as string | null,
  createdAt: now,
  provenance: { producer: "agent", agentRole: "brainstormer", model: "claude-opus-5" },
};
const node = briefNode as never;

const replacedBrief = {
  ...briefNode,
  supersededByNodeId: "nod_2",
} as never;

const currentBrief = {
  ...briefNode,
  id: "nod_2",
  artifactId: "art_2",
  version: 2,
  contentHash: "e48179a981a1",
  supersededByNodeId: null,
} as never;

const turns = messages.map((message) => ({
  id: message.id,
  role: message.role === "agent" ? "specialist" : "human",
  body: (message.parts[0] as { text: string }).text,
  quotes: [],
  resultNodeId: null,
  createdAt: message.createdAt,
})) as never;

const stripTabs = [
  {
    key: "1:problem_brief:",
    label: "Problem brief",
    kind: "problem_brief",
    stage: 1,
    head: briefNode,
    versions: [replacedBrief, currentBrief] as never,
    live: true,
  },
      {
        key: "4:design_doc:",
        label: "Design",
        kind: "design_doc",
        stage: 4,
        head: { ...briefNode, artifactId: "art_3", kind: "design_doc", stage: 4, version: 3, title: "Design" } as never,
        versions: [],
        live: false,
      },
      {
        key: "5:audience_package:Engineers",
        label: "Audience package · Engineers",
        kind: "audience_package",
        stage: 5,
        head: { ...briefNode, artifactId: "art_4", kind: "audience_package", stage: 5, variant: "Engineers", title: "Engineers package" } as never,
        versions: [],
        live: false,
      },
  {
    key: "9:delivery_manifest:",
    label: "Delivery manifest",
    kind: "delivery_manifest",
    stage: 9,
    head: { ...briefNode, artifactId: "art_5", kind: "delivery_manifest", stage: 9, title: "Delivery manifest" } as never,
    versions: [],
    live: false,
  },
];

const strip = (
  <>
    <ArtifactStrip tabs={stripTabs} selectedKey="1:problem_brief:" onSelect={() => {}} />
    <VersionStrip tab={stripTabs[0] as never} activeId={(currentBrief as { id: string }).id} onSelect={() => {}} />
  </>
);

const fixtureEvents = [
  { id: "ev:boundary", at: "", text: "Stage 1 · Problem discovery", tone: "boundary" },
  { id: "ev:1", at: now, text: "Problem brief · v1", tone: "line" },
  { id: "ev:2", at: now, text: "Review opened · Problem brief v2", tone: "line" },
  { id: "ev:3", at: now, text: "Turn aborted", tone: "line" },
] as never;

function Conversation({ withDocument }: { withDocument?: boolean }) {
  return (
    <StageDocument
      node={node}
      versions={[replacedBrief, currentBrief] as never}
      strip={withDocument ? strip : null}
      content={brief}
      tenantId="demo"
      turns={turns}
      openQuestion={{ text: "Which customer group should be the first priority?" }}
      // Renders the evaluator's ready cue on the approve control, so the
      // layout gate sees it rather than only the un-evaluated state.
      evaluation={{ ready: true, notes: [] }}
      canSubmit
      soloApproval
      busy={null}
      events={fixtureEvents}
      onSelectVersion={() => {}}
      onRevise={() => {}}
      onSubmit={() => {}}
    />
  );
}

const screens: Record<string, ReactNode> = {
  onboarding: (
    <Onboarding
      {...({
        providers: [],
        apiKeyProviders: [
          { providerId: "openai", label: "OpenAI", needsBaseUrl: false },
          { providerId: "anthropic", label: "Anthropic", needsBaseUrl: false },
        ],
        oauthCandidates: [
          { providerId: "codex", label: "ChatGPT / Codex", redirectUri: "x" },
          { providerId: "xai", label: "xAI grok", redirectUri: "y" },
        ],
        onConnected: async () => {},
        onCreated: () => {},
        onSkipProject: () => {},
      } as unknown as ComponentProps<typeof Onboarding>)}
    />
  ),
  projects: <Shell at="projects" body={<Projects {...({ projects, onOpen: () => {}, onChanged: () => {} } as unknown as ComponentProps<typeof Projects>)} />} />,
  chat: <Shell at="project" fill body={<Conversation />} />,
  split: <Shell at="project" fill body={<Conversation withDocument />} />,
  artifacts: (
    <Shell
      at="project"
      fill
      body={
        <ArtifactGraph
          nodes={[node]}
          edges={[]}
          contents={{ nod_1: brief }}
          tenantId="demo"
        />
      }
    />
  ),
  "artifacts-history": (
    <Shell
      at="project"
      fill
      body={
        <ArtifactGraph
          nodes={[replacedBrief, currentBrief]}
          edges={[{ childNodeId: "nod_2", sourceNodeId: "nod_1" }]}
          contents={{ nod_1: brief, nod_2: brief }}
          tenantId="demo"
        />
      }
    />
  ),
};

// The stylesheet the built page actually links, never whichever file sorts
// first — a stale sheet turns this walk into fiction.
const html = await Bun.file("dist/index.html").text();
const sheet = /assets\/index-[A-Za-z0-9_-]+\.css/.exec(html)?.[0];
if (!sheet) throw new Error("dist/index.html links no stylesheet; run `bun run ui:build` first.");

// A complete page, not a fragment. Emitting markup and leaving the stylesheet
// to whatever opens it is how an unstyled screenshot once got read as a design
// regression: the walk links the sheet itself, and copies the assets beside it
// so the file:// page resolves fonts and images too.
await cp("dist/assets", "/tmp/walk/assets", { recursive: true });
for (const [name, node] of Object.entries(screens)) {
  await Bun.write(
    `/tmp/walk/${name}.html`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="${sheet}"></head><body>` +
      renderToStaticMarkup(node as never) +
      `</body></html>`,
  );
}
await Bun.write("/tmp/walk/.sheet", sheet);
console.log(`${Object.keys(screens).join(" ")}  (sheet: ${sheet})`);

function assertWalk(name: string, html: string, checks: { include?: string[]; exclude?: string[] }) {
  for (const needle of checks.include ?? []) {
    if (!html.includes(needle)) throw new Error(`${name} is missing ${JSON.stringify(needle)}`);
  }
  for (const needle of checks.exclude ?? []) {
    if (html.includes(needle)) throw new Error(`${name} still contains ${JSON.stringify(needle)}`);
  }
}

const artifactsHtml = await Bun.file("/tmp/walk/artifacts.html").text();
assertWalk("artifacts", artifactsHtml, {
  include: ["Problem brief", "Version 1", "In short", 'class="document"', "library-layout", "queue-item", "drafted by the brainstormer"],
  exclude: [
    "History map",
    "graph-node",
    "lineage edge",
    "All versions",
    "SUPERSEDED",
    "versions across",
    "Loading…",
    "Built from — nothing yet",
    "Earlier versions — none",
  ],
});
if (artifactsHtml.includes("Artifacts (1)")) {
  throw new Error("artifacts still shows the stage-only Artifacts ghost");
}

const historyHtml = await Bun.file("/tmp/walk/artifacts-history.html").text();
assertWalk("artifacts-history", historyHtml, {
  include: [
    "Problem brief",
    "Replaced by version 2",
    "Earlier versions",
    "Version 2",
    "Built from",
  ],
  exclude: ["History map", "graph-node", "lineage edge", "SUPERSEDED", "versions across", "All versions", "Loading…"],
});

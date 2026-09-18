/**
 * The app shell.
 *
 * State lives here and flows down; every mutation goes back through the API and
 * then a refresh, so what the interface shows is what the host durably holds
 * rather than an optimistic guess.
 */
import { useCallback, useEffect, useState, useRef } from "react";
import {
  api,
  ApiFailure,
  type HostStatus,
  type ProjectDetail,
  type ProjectSummary,
  type Provider,
  type Wait,
  type Guidance,
  type ArtifactNode,
} from "./client.js";
import { CircleCheck, FolderKanban, PanelRight, PanelRightClose, Settings as SettingsIcon } from "lucide-react";
import { Banner, Button, Mark, StateLabel, stageName } from "./components.jsx";
import { ARTIFACT_STAGE, type ArtifactKind } from "@solutions-builder/app/artifacts";
import { PrintView, setPrintProject, usePrintTarget } from "./print.jsx";
import { DecisionQueue } from "./pages/decisions.jsx";
import { Projects } from "./pages/projects.jsx";
import { Settings } from "./pages/settings.jsx";
import { ArtifactGraph } from "./pages/graph.jsx";
import { nextStep } from "@solutions-builder/app/next-step";
import { StageTour } from "./tour.jsx";
import type { RunState } from "@solutions-builder/app/ledger";
import { GuideDock } from "./components.jsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarItem,
  SidebarSection,
  Tabs,
  BootScreen,
  NotificationsBell,
} from "@corbits/react-ui";
import { subscribeInbox, type InboxState } from "./inbox.ts";
import { Onboarding } from "./pages/onboarding.jsx";
import { Auth } from "./pages/auth.jsx";
import { StageWorkspace } from "./pages/workspace.jsx";
import { standingForProject, type StageStatus } from "./run-fold.ts";
import { deliverGate, type GateIntent } from "./run-signal.ts";
import type { Stage } from "@solutions-builder/app/ledger";
import { firstRunScreen, type HubAuthState } from "./first-run.ts";
import { getHubSession } from "./hub-auth.ts";

/**
 * Where you are. A project is not a separate destination from its stage: you
 * open a project and you are in it, with a breadcrumb back to the list. What
 * used to be "Stage workspace" and "Artifacts" in the rail were two views of
 * one open project, which is why neither name explained itself.
 */
type View = "decisions" | "projects" | "project" | "settings";

/**
 * What a stage's panel creates, one word each, in the order the panel makes
 * them. Material is handed over, not created, so it is not here.
 */
const KIND_WORDS: Readonly<Record<ArtifactKind, string | null>> = {
  source_material: null,
  problem_brief: "Brief",
  solution_constraints: "Constraints",
  chosen_approach: "Approach",
  design_artifact: "Design",
  design_feedback: "Feedback",
  audience_package: "Package",
  audience_deck: "Deck",
  product_requirements: "Requirements",
  build_plan: "Plan",
  engineering_review: "Review",
  cost_approval: "Approval",
  build_packet: "Packet",
  build_evidence: "Build",
  build_review: "Panel",
  delivery_manifest: "Manifest",
  delivery_verification: "Verification",
};

/** One kind the current panel creates: its word, and the newest live artifact of that kind, if any. */
type StageArtifact = { kind: ArtifactKind; word: string; nodeId: string | null };

/** The kinds the stage's panel creates, each with its newest live artifact on the project. */
function stageArtifacts(stage: number, nodes: readonly ArtifactNode[]): StageArtifact[] {
  const out: StageArtifact[] = [];
  for (const [kind, owner] of Object.entries(ARTIFACT_STAGE) as [ArtifactKind, number][]) {
    const word = KIND_WORDS[kind];
    if (owner !== stage || !word) continue;
    const newest = nodes
      .filter((node) => node.kind === kind && node.supersededByNodeId === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    out.push({ kind, word, nodeId: newest?.id ?? null });
  }
  return out;
}

/** Sections within an open project. */
type ProjectTab = "stage" | "artifacts";

const VIEWS: View[] = ["decisions", "projects", "project", "settings"];

/** Deep link, so a screen can be opened directly: `/?view=settings`. */
function initialView(): View {
  const requested = new URLSearchParams(window.location.search).get("view");
  return VIEWS.includes(requested as View) ? (requested as View) : "projects";
}

/**
 * The first moments, before the host has said anything.
 *
 * Deliberately not a spinner over a half-built layout: there is no layout yet,
 * because which one is right is exactly what is unknown. One line, and after a
 * while an admission that it is taking longer than it should.
 */
/** The hub's "install first" conflict is not a failure of the request: there is nothing yet. */
function emptyUntilInstalled<T>(empty: T): (cause: unknown) => T {
  return (cause) => {
    if (cause instanceof ApiFailure && cause.detail.install) return empty;
    throw cause;
  };
}

function Booting({ offline }: { offline: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <BootScreen
      message={
        offline
          ? "The host is not answering yet."
          : slow
            ? "Still starting — the first run migrates the database."
            : "Starting…"
      }
      brand={<Mark size={26} />}
      footer={<span>Powered by Corbits</span>}
    />
  );
}


/**
 * The navigation rail.
 *
 * Its own component so `scripts/walk-ui.tsx` renders the product's rail rather
 * than a hand-kept copy of it. The copy had already drifted twice — it carried
 * no pinned decision at all, so a fix to that surface was invisible to every
 * screenshot, and its icons were empty `<svg>` elements, which made a working
 * rail look broken and sent me fixing a bug that did not exist.
 */
export function AppRail({
  view,
  decisions,
  projects,
  collapsed,
  offline,
  connected,
  onNavigate,
  onInspect,
  stage = null,
  onOpenArtifact,
}: {
  view: View;
  decisions: Wait[];
  projects: ProjectSummary[];
  collapsed: boolean;
  offline: boolean;
  connected: boolean;
  onNavigate: (view: View) => void;
  onInspect: (projectId: string) => void;
  /** The open project's current panel and what it creates; null off a project. */
  stage?: { number: number; artifacts: StageArtifact[] } | null;
  onOpenArtifact?: ((nodeId: string) => void) | undefined;
}) {
  return (
      <Sidebar collapsed={collapsed}>
        <SidebarHeader className="gap-2.5">
          <Mark />
          <p className="min-w-0 truncate text-sm font-semibold">Solutions Builder</p>
        </SidebarHeader>

        <SidebarContent>
          <SidebarSection label="Work">
              <SidebarItem
                active={view === "projects" || view === "project"}
                icon={<FolderKanban aria-hidden="true" />}
                count={projects.length}
                href="#projects"
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate("projects");
                }}
              >
                Projects
              </SidebarItem>
              <SidebarItem
                active={view === "decisions"}
                icon={<CircleCheck aria-hidden="true" />}
                count={decisions.length}
                href="#decisions"
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate("decisions");
                }}
              >
                Decision queue
              </SidebarItem>
          </SidebarSection>

          {/* What the open panel creates, each word a way to the artifact in
              the Artifacts panel. A kind not produced yet is named but not
              linked: the panel is still where it is made. */}
          {stage ? (
            <div className="rail-stage" aria-label="What this stage creates">
              <p className="rail-stage-head">{stageName(stage.number)} creates</p>
              <ul className="rail-stage-list">
                {stage.artifacts.map((artifact) =>
                  artifact.nodeId ? (
                    <li key={artifact.kind}>
                      <a
                        href={`#artifact:${artifact.nodeId}`}
                        onClick={(event) => {
                          event.preventDefault();
                          onOpenArtifact?.(artifact.nodeId!);
                        }}
                      >
                        {artifact.word}
                      </a>
                    </li>
                  ) : (
                    <li key={artifact.kind} className="is-pending" title="Not produced yet">
                      {artifact.word}
                    </li>
                  ),
                )}
              </ul>
            </div>
          ) : null}

          {/* One pending decision, pinned. More than one is a queue, and the
              queue has a screen of its own. */}
          {decisions[0] ? (
            <div className="rail-decision">
              <StateLabel tone="warning">Action required</StateLabel>
              <p className="rail-decision-title">{decisions[0].title}</p>
              <p className="rail-decision-meta">{decisions[0].projectTitle}</p>
              <Button
                variant="link"
                onClick={() => onInspect(decisions[0]!.projectId)}
              >
                Inspect evidence
              </Button>
            </div>
          ) : null}
        </SidebarContent>

        <SidebarFooter>
          <SidebarSection label="Settings">
              <SidebarItem
                active={view === "settings"}
                icon={<SettingsIcon aria-hidden="true" />}
                href="#settings"
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate("settings");
                }}
              >
                Settings
              </SidebarItem>
          </SidebarSection>

          {/* Says only what someone would act on. A healthy host is not news. */}
          {offline ? (
            <p className="rail-note">
              <StateLabel tone="error">Reconnecting</StateLabel>
            </p>
          ) : !connected ? (
            <Button variant="link" onClick={() => onNavigate("settings")}>
              Connect a model
            </Button>
          ) : null}
        </SidebarFooter>
      </Sidebar>
  );
}

export function App() {
  const [view, setView] = useState<View>(initialView);
  // A document being printed lies over the app rather than replacing it, so
  // nothing in flight underneath is lost.
  const printing = usePrintTarget();
  const [projectTab, setProjectTab] = useState<ProjectTab>("stage");
  // The conversation and the artifact library fill the window; every other
  // view scrolls. Computed here rather than inline so a class list stays a
  // class list.
  const fills = view === "project" && (projectTab === "stage" || projectTab === "artifacts");
  // Below this width the rail is icons only: two full columns of chrome plus a
  // conversation does not fit, and stacking the rail on top buries the work.
  const [narrow, setNarrow] = useState(
    () => globalThis.matchMedia?.("(max-width: 1080px)").matches ?? false,
  );
  useEffect(() => {
    const query = globalThis.matchMedia?.("(max-width: 1080px)");
    if (!query) return;
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [draftOpen, setDraftOpen] = useState(true);

  const [status, setStatus] = useState<HostStatus | null>(null);
  const [decisions, setDecisions] = useState<Wait[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<
    { providerId: string; label: string; needsBaseUrl: boolean }[]
  >([]);
  const [oauthCandidates, setOauthCandidates] = useState<
    { providerId: string; label: string; redirectUri: string }[]
  >([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [standing, setStanding] = useState<StageStatus | null>(null);
  // Resolved once and threaded down as a prop: every artifact read goes
  // through `@corbits/artifacts` over `/hub`, which is tenant-scoped.
  const [tenantId, setTenantId] = useState<string | null>(null);
  // The artifact the Artifacts panel opens on, when the rail sent us there.
  const [openedArtifact, setOpenedArtifact] = useState<string | null>(null);
  // Guidance describes one project at one moment. Showing yesterday's
  // orientation against today's state is worse than showing none.
  useEffect(() => {
    setGuidance(null);
  }, [selected, detail?.current?.state, detail?.nodes.length]);
  const [graph, setGraph] = useState<{
    nodes: import("./client.js").ArtifactNode[];
    edges: { childNodeId: string; sourceNodeId: string }[];
  }>({ nodes: [], edges: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [skippedSetup, setSkippedSetup] = useState(false);
  // Signup/login first: the workspace tenant is created as that session.
  const [auth, setAuth] = useState<HubAuthState>("unknown");
  // The client is the installer. Once the host answers and a hub session
  // exists, the tenant is checked against the app the client ships with;
  // missing or stale, it is installed before any screen that depends on it
  // renders. First run and upgrade are the same call.
  const [installed, setInstalled] = useState<"checking" | "installing" | "ready">("checking");

  const refresh = useCallback(async () => {
    try {
      // Status and providers answer before the workspace exists. Decisions and
      // projects do not: until the client has installed the app the hub
      // refuses them with a conflict marked `install`, and the install runs
      // only once `status` is set. Fetching all four together meant a first
      // run never set `status` and the boot screen never went away. Until the
      // install, an uninstalled workspace is an empty one.
      const [statusResult, providersResult] = await Promise.all([api.status(), api.providers()]);
      const [decisionsResult, projectsResult, tenantIdResult] = await Promise.all([
        api.decisions().catch(emptyUntilInstalled({ decisions: [] })),
        api.projects().catch(emptyUntilInstalled({ projects: [] })),
        api.workspaceTenantId().catch(() => null),
      ]);
      setStatus(statusResult);
      setDecisions(decisionsResult.decisions);
      setProjects(projectsResult.projects);
      setProviders(providersResult.providers);
      setApiKeyProviders(providersResult.apiKeyProviders);
      setOauthCandidates(providersResult.oauthCandidates);
      setTenantId(tenantIdResult);
      setOffline(false);
    } catch {
      // The host going away is a visible state, not a blank screen.
      setOffline(true);
    }
  }, []);

  // Runs once the host has answered and a hub session exists. Deliberately
  // not keyed on `installed`: the effect sets that state itself, and
  // re-running on its own state change cancelled the install it was awaiting,
  // so a first run stayed on "Setting up your workspace…" until someone
  // reloaded. A ref rather than a cancellation flag, so StrictMode's second
  // mount neither starts a second install nor abandons the first.
  const installStarted = useRef(false);
  useEffect(() => {
    if (status === null || auth !== "signed-in" || installStarted.current) return;
    installStarted.current = true;
    void (async () => {
      try {
        const state = await api.installState();
        if (!state.installed) {
          setInstalled("installing");
          await api.install();
          await refresh();
        }
      } catch (cause) {
        // The app still opens: what is missing shows as it is met, and the
        // host says why it could not install.
        setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      } finally {
        setInstalled("ready");
      }
    })();
  }, [status === null, auth, refresh]);

  useEffect(() => {
    if (status === null) return;
    void getHubSession()
      .then((session) => setAuth(session ? "signed-in" : "signed-out"))
      .catch(() => setAuth("signed-out"));
  }, [status === null]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // The bell owns its own unread state; a mailbox event also refreshes the
  // decision queue immediately rather than waiting on the 5s poll above —
  // an inbox item is often exactly the nudge that a decision landed.
  const [inbox, setInbox] = useState<InboxState>({ items: [], unreadCount: 0 });
  useEffect(() => subscribeInbox(setInbox, () => void refresh()), [refresh]);

  // The Decision Queue renders the exact versions a gate would freeze, and it
  // reads them from the open project. Without this the primary action on the
  // primary screen is disabled on first load, because nothing is selected yet.
  // Nothing selected is not a state worth showing anyone: prefer the project
  // with a gate open, then the most recent one.
  useEffect(() => {
    if (selected !== null) return;
    const next = decisions[0]?.projectId ?? projects[0]?.id;
    if (next) setSelected(next);
  }, [decisions, projects, selected]);

  useEffect(() => {
    setPrintProject(detail?.project.title ?? null);
  }, [detail?.project.title]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setStanding(null);
      return;
    }
    let cancelled = false;
    void api
      .project(selected)
      .then(async (result) => {
        const nextStanding = await standingForProject(result).catch(() => null);
        if (!cancelled) {
          setDetail(result);
          setStanding(nextStanding);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selected, projects]);

  useEffect(() => {
    if (view !== "project" || !selected) return;
    void api
      .graph(selected)
      .then(setGraph)
      .catch(() => setGraph({ nodes: [], edges: [] }));
  }, [view, selected, detail]);

  const reloadDetail = useCallback(async () => {
    // Both at once: the stage view cannot start its draft until the detail
    // lands, so a serial refresh here was dead time on every approval.
    const [, next] = await Promise.all([
      refresh(),
      selected ? api.project(selected).catch(() => null) : Promise.resolve(null),
    ]);
    if (selected) {
      setDetail(next);
      setStanding(next ? await standingForProject(next).catch(() => null) : null);
    }
  }, [refresh, selected]);

  const openProject = (projectId: string) => {
    setSelected(projectId);
    setOpenedArtifact(null);
    setProjectTab("stage");
    setView("project");
  };

  const decide = async (
    wait: Wait,
    decision: "approve" | "reject" | "revise",
    reason: string,
    /** The stage a send-back returns to: any up to this one, as the ledger allows. */
    target: number = wait.stage - 1,
  ) => {
    setBusy(decision);
    setError(null);
    try {
      const project = await api.project(wait.projectId);
      const versions = project.nodes
        .filter((node) => node.stage === wait.stage && node.supersededByNodeId === null)
        .map((node) => ({
          artifactId: node.artifactId,
          versionId: node.id,
          contentHash: node.contentHash,
        }));

      // The command depends on the stage, because the ledger says so: stage 7
      // approves a cost, stage 9 accepts a manifest, everything else approves.
      const command =
        decision === "approve"
          ? wait.stage === 7
            ? "cost.approve"
            : wait.stage === 9
              ? "delivery.accept"
              : "stage.approve"
          : wait.stage === 9
            ? decision === "reject"
              ? "delivery.reject"
              : "delivery.revise"
            : decision === "reject"
              ? "stage.reject"
              : "stage.revise";

      const intent: GateIntent = {
        command,
        runId: wait.runId,
        versions,
        rationale: reason,
        ...(decision !== "approve"
          ? {
              reason: reason || "Routed back without a stated reason.",
              targetStage: Math.min(wait.stage, Math.max(1, Math.round(target))),
            }
          : {}),
      };

      // The decision is a signal on the run, by this person, at this gate.
      await deliverGate(project, wait.stage as Stage, await standingForProject(project).catch(() => null), intent);
      setSelected(wait.projectId);
      await reloadDetail();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  // Nothing is decided until the host has answered. Rendering the app shell
  // while `status` is still null and correcting to onboarding a moment later is
  // how a first launch flashes the wrong screen — the person sees an app they
  // do not have access to yet, then watches it be taken away.
  //
  // The host is slow to start on purpose: pglite unpacks a WASM image and the
  // hub applies its schema. Saying so is better than guessing at a layout.
  const screen = firstRunScreen({ status, auth, installed });
  if (screen === "boot") {
    return <Booting offline={offline} />;
  }
  if (screen === "auth") {
    return <Auth onSignedIn={() => setAuth("signed-in")} />;
  }
  if (screen === "install") {
    return (
      <BootScreen
        message={installed === "installing" ? "Setting up your workspace…" : "Checking your workspace…"}
        brand={<Mark size={26} />}
        footer={<span>Powered by Corbits</span>}
      />
    );
  }
  if (status === null) {
    return <Booting offline={offline} />;
  }

  // Held until there is both somewhere to draft from and something to work on.
  // Connecting a model and then landing on an empty app is not an onboarding.
  // Inference is required — the product cannot draft a stage without it, so
  // step 1 is not skippable. Only the first-project step can be deferred.
  const showOnboarding =
    !status.inference.connected || (projects.length === 0 && !skippedSetup);

  if (showOnboarding) {
    return (
      <Onboarding
        providers={providers}
        apiKeyProviders={apiKeyProviders}
        oauthCandidates={oauthCandidates}
        onConnected={refresh}
        onCreated={(projectId) => {
          setSkippedSetup(true);
          void refresh();
          openProject(projectId);
        }}
      />
    );
  }

  return (
    <>
    <div className="app">
      <AppRail
        view={view}
        decisions={decisions}
        projects={projects}
        collapsed={narrow}
        offline={offline}
        connected={status?.inference.connected ?? false}
        onNavigate={setView}
        onInspect={(projectId: string) => {
          setSelected(projectId);
          setView("decisions");
        }}
        stage={
          view === "project" && detail
            ? { number: detail.current?.stage ?? 1, artifacts: stageArtifacts(detail.current?.stage ?? 1, graph.nodes) }
            : null
        }
        onOpenArtifact={(nodeId) => {
          setOpenedArtifact(nodeId);
          setProjectTab("artifacts");
        }}
      />

      <main className="canvas">
        <div className="canvas-head">
          {view === "project" && detail ? (
            <>
              <button type="button" className="crumb" onClick={() => setView("projects")}>
                Projects
              </button>
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
              <h1>
                {detail.project.title}
                {/* The panel, named: which stage this is, and Artifacts when that is the panel open. */}
                <span className="head-panel">
                  {" "}
                  ({stageName(detail.current?.stage ?? 1)}
                  {projectTab === "artifacts" ? " / Artifacts" : ""})
                </span>
              </h1>
            </>
          ) : (
            <h1>
              {view === "decisions"
                ? "Decision queue"
                : view === "projects"
                  ? "Projects"
                  : "Settings"}
            </h1>
          )}

          <div className="head-actions">
          <NotificationsBell count={inbox.unreadCount}>
            {inbox.items.length === 0 ? (
              <p className="inbox-empty">Nothing in your inbox.</p>
            ) : (
              <ul className="inbox-list">
                {inbox.items.map((item) => (
                  <li key={item.uid} className={item.unread ? "is-unread" : ""}>
                    <strong>{item.subject}</strong>
                    <span>{item.from}</span>
                  </li>
                ))}
              </ul>
            )}
          </NotificationsBell>
          {view === "project" && detail ? (
            <>
              <Tabs
                className="head-tabs"
                label="This project"
                active={projectTab}
                onChange={(id) => setProjectTab(id as ProjectTab)}
                tabs={[
                  { id: "stage", label: "Conversation" },
                  {
                    id: "artifacts",
                    label: "Artifacts",
                    ...(graph.nodes.length > 0 ? { count: graph.nodes.length } : {}),
                  },
                ]}
              >
                {() => null}
              </Tabs>
              {/* Always in the bar so the tabs never shift when it toggles. */}
              <button
                type="button"
                className="head-toggle"
                aria-pressed={draftOpen}
                aria-label={draftOpen ? "Hide the draft" : "Show the draft"}
                disabled={projectTab !== "stage"}
                onClick={() => setDraftOpen((open) => !open)}
              >
                {draftOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRight aria-hidden="true" />}
              </button>
            </>
          ) : null}

          {/* Bottom right, over the canvas: always to hand, never competing
              with the toolbar, and never a band of the window given to one
              sentence. */}
          {view === "project" && detail ? (
            <GuideDock
              stage={detail.current?.stage ?? 1}
              step={nextStep({
                state: (detail.current?.state ?? null) as RunState | null,
                stage: detail.current?.stage ?? 1,
                // So the guide and the composer name the same act. Two words
                // for one decision is how a person stops trusting either.
                soloApproval: detail.soloApproval,
                hasDraft: detail.nodes.some(
                  (node) => node.stage === (detail.current?.stage ?? 1),
                ),
                ...(detail.current?.stage === 5
                  ? {
                      quorum: {
                        recorded: detail.approvals.filter(
                          (approval) => approval.command === "audience.decide",
                        ).length,
                        needed:
                          (detail.project.policy as { audienceQuorum?: number })
                            .audienceQuorum ?? 0,
                        blocked: detail.approvals.filter(
                          (approval) =>
                            approval.command === "audience.decide" &&
                            approval.decision !== "proceed",
                        ).length,
                      },
                    }
                  : {}),
              })}
              guidance={guidance}
              explaining={explaining}
              at={projectTab === "artifacts" ? "artifacts" : "stage"}
              onExplain={() => {
                setExplaining(true);
                void api
                  .guidance(detail.project.id)
                  .then((result) => setGuidance(result.guidance))
                  .catch(() => setGuidance(null))
                  .finally(() => setExplaining(false));
              }}
              onGo={(where) => {
                if (where === "settings") setView("settings");
                else if (where === "decisions") setView("decisions");
                else setProjectTab(where === "artifacts" ? "artifacts" : "stage");
              }}
            />
          ) : null}
          </div>
        </div>

        <div className={fills ? "canvas-body is-fill" : "canvas-body"}>

        {offline ? (
          <Banner tone="error" title="The host is not answering" />
        ) : null}

        {error ? (
          <Banner tone="error" title="That decision was refused">
            {error}
          </Banner>
        ) : null}

        {view === "decisions" ? (
          <DecisionQueue
            decisions={decisions}
            detail={detail}
            busy={busy}
            selectedProjectId={selected}
            onOpen={(wait) => setSelected(wait.projectId)}
            onInspect={(wait) => openProject(wait.projectId)}
            onStart={() => setView("projects")}
            onDecide={decide}
          />
        ) : null}

        {view === "projects" ? (
          <Projects projects={projects} onOpen={openProject} onChanged={refresh} />
        ) : null}

        {view === "project" ? (
          detail ? (
            <>
              {projectTab === "stage" ? (
                <>
                  {/* Imported and never rendered, so the walkthrough simply
                      did not exist. It runs once, on the surface it describes,
                      and remembers that it has. */}
                  <StageTour enabled={detail.current !== null} stage={detail.current?.stage ?? 1} />
                  <StageWorkspace
                    detail={detail}
                    standing={standing}
                    draftOpen={draftOpen}
                    tenantId={tenantId ?? ""}
                    onChanged={reloadDetail}
                    onOpenSettings={() => setView("settings")}
                    onOpenDecisions={() => setView("decisions")}
                  />
                </>
              ) : (
                <ArtifactGraph
                  nodes={graph.nodes}
                  edges={graph.edges}
                  tenantId={tenantId ?? ""}
                  {...(openedArtifact ? { openedId: openedArtifact } : {})}
                  onAddMaterial={async (files) => {
                    await api.attachMaterial(detail.project.id, files);
                    await reloadDetail();
                  }}
                />
              )}
            </>
          ) : (
            <Banner title="No project open" />
          )
        ) : null}

        {view === "settings" ? (
          <Settings
            status={status}
            providers={providers}
            apiKeyProviders={apiKeyProviders}
            oauthCandidates={oauthCandidates}
            onChanged={refresh}
          />
        ) : null}
        </div>
      </main>
    </div>
    {printing ? <PrintView target={printing} /> : null}
    </>
  );
}

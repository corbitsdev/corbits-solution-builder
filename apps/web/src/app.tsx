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
} from "./client.js";
import {
  ArrowLeft,
  Download,
  PanelRight,
  PanelRightClose,
  Settings as SettingsIcon,
} from "lucide-react";
import { Banner, Mark, downloadArtifact, stageName } from "./components.jsx";
import { PrintView, setPrintProject, usePrintTarget } from "./print.jsx";
import { Projects } from "./pages/projects.jsx";
import { Settings } from "./pages/settings.jsx";
import { ArtifactGraph } from "./pages/graph.jsx";
import { nextStep } from "@solutions-builder/app/next-step";
import { StageTour } from "./tour.jsx";
import { GuideDock } from "./components.jsx";
import {
  Tabs,
  BootScreen,
  HorizontalStepper,
  NotificationsBell,
  ThemeToggle,
  type WorkflowStep,
} from "@corbits/react-ui";
import { subscribeInbox, type InboxState } from "./inbox.ts";
import { Onboarding } from "./pages/onboarding.jsx";
import { Auth } from "./pages/auth.jsx";
import { StageWorkspace } from "./pages/workspace.jsx";
import { assembleBundle, bundleFileName } from "./project-export.ts";
import { firstRunScreen, type HubAuthState } from "./first-run.ts";
import { getHubSession } from "./hub-auth.ts";

/**
 * Where you are. A project is not a separate destination from its stage: you
 * open a project and you are in it, with a way back to the list. Decisions
 * are not a destination either — they fold into the bell.
 */
type View = "projects" | "project" | "settings";

/** Sections within an open project. */
type ProjectTab = "stage" | "artifacts";

const VIEWS: View[] = ["projects", "project", "settings"];

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


/** The nine stages as stepper segments: done in ink, current stretched, rest hairline. */
function stageSteps(stage: number): WorkflowStep[] {
  return Array.from({ length: 9 }, (_, index) => {
    const number = index + 1;
    return {
      number,
      label: stageName(number),
      status: number < stage ? "completed" : number === stage ? "current" : "pending",
    };
  });
}

/**
 * The bar across the top.
 *
 * Its own component so `scripts/walk-ui.tsx` renders the product's chrome
 * rather than a hand-kept copy of it — the rail version of this drifted twice
 * before it was replaced.
 *
 * Three zones: where you are (back + mark + name), where the project is in
 * its nine stages (only in a project — elsewhere the centre stays empty so
 * the bar never shifts), and what needs you. The bell is the decision fold:
 * waits render under "Needs you" and open their project on click, mailbox
 * items under "Activity". There is no decisions destination any more.
 */
export function AppBar({
  view,
  detail,
  decisions,
  inbox,
  bellOpen,
  onBellOpenChange,
  onNavigate,
  onOpenProject,
  projectTab,
  onProjectTab,
  draftOpen,
  onToggleDraft,
  exporting,
  onExport,
  artifactCount = 0,
}: {
  view: View;
  detail: ProjectDetail | null;
  decisions: Wait[];
  inbox: InboxState;
  bellOpen: boolean;
  onBellOpenChange: (open: boolean) => void;
  onNavigate: (view: View) => void;
  onOpenProject: (projectId: string) => void;
  /** Project-view chrome; absent elsewhere so nothing dead renders. */
  projectTab?: ProjectTab;
  onProjectTab?: (tab: ProjectTab) => void;
  draftOpen?: boolean;
  onToggleDraft?: () => void;
  exporting?: boolean;
  onExport?: () => void;
  artifactCount?: number;
}) {
  const inProject = view === "project" && detail !== null;
  return (
    <header className="topbar">
      <div className="topbar-left">
        {inProject ? (
          <>
            <button
              type="button"
              className="iconbtn"
              title="All projects"
              aria-label="All projects"
              onClick={() => onNavigate("projects")}
            >
              <ArrowLeft aria-hidden="true" />
            </button>
            <Mark size={20} />
            <span className="wordmark">{detail.project.title}</span>
          </>
        ) : (
          <>
            <Mark size={20} />
            <span className="wordmark">Solutions Builder</span>
          </>
        )}
      </div>

      <div className="topbar-center">
        {inProject ? (
          <>
            <HorizontalStepper variant="segments" steps={stageSteps(detail.stage)} />
            <span className="step-name">{stageName(detail.stage)}</span>
          </>
        ) : null}
      </div>

      <div className="topbar-actions">
        {inProject && projectTab !== undefined && onProjectTab ? (
          <>
            <Tabs
              className="head-tabs"
              label="This project"
              active={projectTab}
              onChange={(id) => onProjectTab(id as ProjectTab)}
              tabs={[
                { id: "stage", label: "Conversation" },
                {
                  id: "artifacts",
                  label: "Artifacts",
                  ...(artifactCount > 0 ? { count: artifactCount } : {}),
                },
              ]}
            >
              {() => null}
            </Tabs>
            <button
              type="button"
              className="iconbtn"
              aria-pressed={draftOpen}
              aria-label={draftOpen ? "Hide the draft" : "Show the draft"}
              disabled={projectTab !== "stage"}
              onClick={onToggleDraft}
            >
              {draftOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRight aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="iconbtn"
              title="Export bundle"
              aria-label="Export bundle"
              disabled={exporting}
              onClick={onExport}
            >
              <Download aria-hidden="true" />
            </button>
          </>
        ) : null}
        <NotificationsBell
          count={decisions.length + inbox.unreadCount}
          marker="dot"
          open={bellOpen}
          onOpenChange={onBellOpenChange}
        >
          {decisions.length > 0 ? (
            <>
              <p className="notif-group">Needs you</p>
              {decisions.map((wait) => (
                <button
                  key={wait.id}
                  type="button"
                  className="notif"
                  onClick={() => {
                    onBellOpenChange(false);
                    onOpenProject(wait.projectId);
                  }}
                >
                  <span className="statusdot action" aria-hidden="true" />
                  <span className="notif-body">
                    <b>{wait.projectTitle}</b>
                    <span>{wait.consequence}</span>
                  </span>
                </button>
              ))}
            </>
          ) : null}
          {inbox.items.length > 0 ? (
            <>
              <p className="notif-group">Activity</p>
              {inbox.items.map((item) => (
                <div key={item.uid} className="notif">
                  <span className="statusdot idle" aria-hidden="true" />
                  <span className="notif-body">
                    <b>{item.subject}</b>
                    <span>{item.from}</span>
                  </span>
                </div>
              ))}
            </>
          ) : null}
          {decisions.length === 0 && inbox.items.length === 0 ? (
            <p className="notif-empty">Nothing waiting on you.</p>
          ) : (
            <div className="notif-foot">That's everything</div>
          )}
        </NotificationsBell>
        <button
          type="button"
          className="iconbtn"
          title="Settings"
          aria-label="Settings"
          onClick={() => onNavigate("settings")}
        >
          <SettingsIcon aria-hidden="true" />
        </button>
        <ThemeToggle />
      </div>
    </header>
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

  const [draftOpen, setDraftOpen] = useState(true);
  const [bellOpen, setBellOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

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
  // Resolved once and threaded down as a prop: every artifact read goes
  // through `@corbits/artifacts` over `/hub`, which is tenant-scoped.
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [graph, setGraph] = useState<{
    nodes: import("./client.js").ArtifactNode[];
    edges: { childNodeId: string; sourceNodeId: string }[];
  }>({ nodes: [], edges: [] });
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [skippedSetup, setSkippedSetup] = useState(false);
  // Signup/login first: the workspace tenant is created as that session.
  const [auth, setAuth] = useState<HubAuthState>("unknown");
  // Set only for an embedded (local desktop) hub whose owner could not be
  // minted automatically — a keychain the host cannot read, or a hub that
  // refused the minted account. `null` until a mint attempt fails.
  const [mintError, setMintError] = useState<string | null>(null);
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
    } catch (cause) {
      // A 401/403 means the session cookie no longer holds (e.g. the host
      // restarted): that is "not signed in", not "not answering". Only a
      // dropped connection or a real server error is offline.
      if (cause instanceof ApiFailure && (cause.httpStatus === 401 || cause.httpStatus === 403)) {
        setAuth("signed-out");
        setOffline(false);
        return;
      }
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

  // A local desktop (the hub embedded in this same host process) has one
  // owner and no sign-up screen: the owner's password lives only in the
  // keychain, minted here on first run and signed in on the browser's
  // behalf. A remote hub is never a single-user desktop, so it keeps the
  // real account flow (`pages/auth.tsx`) instead of attempting this.
  const mintAttempted = useRef(false);
  const mintOwner = useCallback(async () => {
    setMintError(null);
    // The embedded hub can still be settling when the first mint lands — one
    // quiet retry before the failure becomes a screen.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await api.mintOwner();
        const session = await getHubSession();
        if (session) {
          setAuth("signed-in");
          return;
        }
        setMintError("The hub accepted the workspace owner but did not sign them in.");
        return;
      } catch (cause) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        setMintError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      }
    }
  }, []);
  useEffect(() => {
    if (status?.hub.mode !== "embedded" || auth !== "signed-out" || mintAttempted.current) return;
    mintAttempted.current = true;
    void mintOwner();
  }, [status?.hub.mode, auth, mintOwner]);

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
      return;
    }
    let cancelled = false;
    void api
      .projectView(selected)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selected, projects]);

  useEffect(() => {
    if (view !== "project" || !selected) return;
    void api
      .artifactGraph(selected)
      .then(setGraph)
      .catch(() => setGraph({ nodes: [], edges: [] }));
  }, [view, selected, detail]);

  const reloadDetail = useCallback(async () => {
    // Both at once: the stage view cannot start its draft until the detail
    // lands, so a serial refresh here was dead time on every approval.
    const [, next] = await Promise.all([
      refresh(),
      selected ? api.projectView(selected).catch(() => null) : Promise.resolve(null),
    ]);
    if (selected) setDetail(next);
  }, [refresh, selected]);

  const openProject = (projectId: string) => {
    setSelected(projectId);
    setProjectTab("stage");
    setView("project");
  };

  /**
   * The bundle is assembled in the browser (`project-export.ts`) and saved as
   * a download — the same path the projects list's export menu item takes.
   */
  const exportProject = async () => {
    if (exporting || !detail) return;
    setExporting(true);
    try {
      const bundle = await assembleBundle(detail.project.id, {
        projectView: api.projectView,
        artifactContent: api.artifactContent,
        stageAgentStatus: api.stageAgentStatus,
        readStageThread: api.readStageThread,
      });
      downloadArtifact(JSON.stringify(bundle, null, 2), bundleFileName(detail.project.title));
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setExporting(false);
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
    // Embedded: no sign-up screen. The owner mints automatically; while that
    // is in flight this looks like any other boot screen, and only an
    // actual failure (keychain unreadable, hub refused the account) shows
    // anything, explicit and with a retry — never a credentials form for a
    // desktop app with nobody else to sign in as.
    if (status?.hub.mode === "embedded") {
      if (mintError) {
        return (
          <Auth
            onSignedIn={() => setAuth("signed-in")}
            mintFailure={{
              reason: mintError,
              onRetry: () => {
                mintAttempted.current = false;
                void mintOwner();
              },
            }}
          />
        );
      }
      return (
        <BootScreen
          message="Setting up your local workspace…"
          brand={<Mark size={26} />}
          footer={<span>Powered by Corbits</span>}
        />
      );
    }
    // Remote: a hosted hub is never a single-user desktop, so this is the
    // real account flow — sign up or sign in against it.
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
  const inferenceConnected = providers.some((provider) => provider.status === "ready");
  const showOnboarding = !inferenceConnected || (projects.length === 0 && !skippedSetup);

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
      <AppBar
        view={view}
        detail={detail}
        decisions={decisions}
        inbox={inbox}
        bellOpen={bellOpen}
        onBellOpenChange={setBellOpen}
        onNavigate={setView}
        onOpenProject={openProject}
        projectTab={projectTab}
        onProjectTab={setProjectTab}
        draftOpen={draftOpen}
        onToggleDraft={() => setDraftOpen((open) => !open)}
        exporting={exporting}
        onExport={() => void exportProject()}
        artifactCount={graph.nodes.length}
      />

      <main className="canvas">
        {/* Bottom right, over the canvas: always to hand, never competing
            with the toolbar, and never a band of the window given to one
            sentence. */}
        {view === "project" && detail ? (
          <GuideDock
            stage={detail.stage}
            step={nextStep({
              // No lifecycle run to read a state off any more (CL-8612
              // contract v6): a selected project is always "in progress"
              // from the guide's point of view — there is no
              // waiting_approval/cost_approved distinction left to draw.
              state: "in_progress",
              stage: detail.stage,
              // So the guide and the composer name the same act. Two words
              // for one decision is how a person stops trusting either.
              soloApproval: detail.soloApproval,
              hasDraft: detail.nodes.some(
                (node) => node.stage === (detail.stage),
              ),
            })}
            at={projectTab === "artifacts" ? "artifacts" : "stage"}
            onGo={(where) => {
              if (where === "settings") setView("settings");
              else if (where === "decisions") setBellOpen(true);
              else setProjectTab(where === "artifacts" ? "artifacts" : "stage");
            }}
          />
        ) : null}

        <div className={fills ? "canvas-body is-fill" : "canvas-body"}>

        {offline ? (
          <Banner tone="error" title="The host is not answering" />
        ) : null}

        {error ? (
          <Banner tone="error" title="That was refused">
            {error}
          </Banner>
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
                  <StageTour enabled={true} stage={detail.stage} />
                  <StageWorkspace
                    key={detail.project.id}
                    detail={detail}
                    draftOpen={draftOpen}
                    tenantId={tenantId ?? ""}
                    onChanged={reloadDetail}
                    onOpenSettings={() => setView("settings")}
                    onOpenDecisions={() => setBellOpen(true)}
                  />
                </>
              ) : (
                <ArtifactGraph
                  nodes={graph.nodes}
                  edges={graph.edges}
                  tenantId={tenantId ?? ""}
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

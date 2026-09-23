/**
 * Stage 6's right pane: one document, not a wall of notes. The requirements
 * author and four panel principals stay real, lazily-deployed agents (CL-8737);
 * a reply lives only in its own mail thread. The surface is the same
 * `.stage-inner` / `.doc` paper as the other stages.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiFailure } from "../../client.js";
import { subscribeMailbox } from "../../mailbox-events.ts";
import { Markdown } from "../../markdown.jsx";
import { Banner, Button } from "../../components.jsx";
import { StagePanes } from "./workspace-chrome.tsx";
import { HowItRuns } from "./how-it-runs.tsx";

/** One role's mail-based ask/reply against stage 6's five real agents
 *  (CL-8737): requirements author or one panel principal, each its own
 *  deployment, address and thread -- never an artifact, never a decision. */
type Stage6RoleState = {
  status: "idle" | "starting" | "waiting" | "done" | "error";
  address: string | null;
  reply: string | null;
  error: string | null;
  requestedAt: number;
};

const STAGE6_IDLE_ROLE: Stage6RoleState = { status: "idle", address: null, reply: null, error: null, requestedAt: 0 };

const STAGE6_PANEL_ROLES: readonly { key: string; label: string }[] = [
  { key: "application", label: "Application" },
  { key: "quality", label: "Quality" },
  { key: "platform", label: "Platform" },
  { key: "security", label: "Security" },
];

const STAGE6_REQUIREMENTS_ROLE_KEY = "requirements-author";

const PAGES: readonly { key: string; label: string }[] = [
  { key: "requirements", label: "Product requirements" },
  ...STAGE6_PANEL_ROLES.map((role) => ({ key: role.key, label: `${role.label} review` })),
];

/**
 * Stage 6's requirements author and four panel principals, each a real,
 * lazily-deployed agent (CL-8737) -- distinct from `ProductRequirements`/
 * `PanelReviews`, which read a persisted artifact these agents never write.
 * A reply here lives only in its own mail thread, read back with
 * `readStageThread`, so a missing or failed reply never touches
 * `workflowView.allowed.approve` or the plan itself.
 *
 * The requirements author is asked once per opening input (the material
 * stage 6 opened with); the four reviewers are asked only on an explicit
 * click, against the architect's current draft -- re-requesting one never
 * disturbs the other three or the requirements reply.
 *
 * When `pane` is false the plan document already owns the right pane; this
 * still runs the roles, but does not dump a second surface.
 */
export function Stage6Panel({
  tenantId,
  projectId,
  requirementsInput,
  reviewInput,
  requirementsBlock = null,
  requirementsMinted,
  onRequirementsDrafted,
  strip,
  conversation,
  reader,
  pane,
}: {
  tenantId: string;
  projectId: string;
  requirementsInput: string | null;
  reviewInput: string | null;
  /** The workflow-minted `## Requirements (authoritative ids)` block
   *  (`P/requirements.ts`'s `renderRequirementsBlock`) -- prefixed onto the
   *  panel review body so a reviewer checks the Architect's stack citations
   *  against the same ids the Architect was bound to. Empty ("None minted
   *  yet.") until `mint_requirements` has run for this project. */
  requirementsBlock?: string | null;
  /** `workflowView.requirements.length > 0` -- once minting has run for this
   *  project, `requirementsInput` is stage 6's opening material on every
   *  reload, not a fresh ask, so the requirements author must not re-run
   *  (same gate `use-opening-dispatch.ts` holds the Architect's opening to). */
  requirementsMinted: boolean;
  /** Fires once the requirements author's PRODUCT_REQUIREMENTS document is
   *  accepted (its reply lands) — `index.tsx` mints the workflow's
   *  requirement ids from it (CL-8862), before the Architect drafts. */
  onRequirementsDrafted?: (markdown: string) => void;
  strip: ReactNode;
  conversation: ReactNode;
  reader: ReactNode;
  /** When false, the plan's StageDocument already fills the right pane. */
  pane: boolean;
}) {
  const [requirements, setRequirements] = useState<Stage6RoleState>(STAGE6_IDLE_ROLE);
  const [reviews, setReviews] = useState<Record<string, Stage6RoleState>>({});
  const [page, setPage] = useState("requirements");
  const requirementsRequestedFor = useRef<string | null>(null);
  // The requirements-author's accepted document mints the workflow's
  // requirement ids exactly once per reply -- a poll or re-render seeing the
  // same "done" reply again must never re-mint (CL-8862).
  const requirementsMintedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!onRequirementsDrafted) return;
    if (requirements.status !== "done" || !requirements.reply) return;
    if (requirementsMintedFor.current === requirements.reply) return;
    requirementsMintedFor.current = requirements.reply;
    onRequirementsDrafted(requirements.reply);
  }, [requirements, onRequirementsDrafted]);

  const runRole = useCallback(
    (roleKey: string, body: string, onUpdate: (updater: (prev: Stage6RoleState) => Stage6RoleState) => void) => {
      onUpdate((prev) => ({ ...prev, status: "starting", error: null }));
      void (async () => {
        try {
          const deployment = await api.ensureStage6RoleAgent(projectId, roleKey);
          const requestedAt = Date.now();
          onUpdate((prev) => ({ ...prev, address: deployment.address, status: "waiting", requestedAt }));
          await api.sendStageMail(tenantId, deployment.address, { body });
        } catch (cause) {
          onUpdate((prev) => ({
            ...prev,
            status: "error",
            error: cause instanceof ApiFailure ? cause.detail.message : String(cause),
          }));
        }
      })();
    },
    [projectId, tenantId],
  );

  // The requirements author runs first, once per opening input -- a fresh
  // send-back or a new project resets `requirementsInput` and asks again.
  // Once minting has run, `requirementsInput` is stage 6's own opening
  // material on every reload, not a fresh ask, so this must not re-fire.
  useEffect(() => {
    if (!requirementsInput || requirementsMinted) return;
    if (requirementsRequestedFor.current === requirementsInput) return;
    requirementsRequestedFor.current = requirementsInput;
    runRole(STAGE6_REQUIREMENTS_ROLE_KEY, requirementsInput, setRequirements);
  }, [requirementsInput, requirementsMinted, runRole]);

  const requestReview = (roleKey: string) => {
    if (!reviewInput) return;
    const body = requirementsBlock ? `${requirementsBlock}\n\n${reviewInput}` : reviewInput;
    runRole(roleKey, body, (updater) => setReviews((prev) => ({ ...prev, [roleKey]: updater(prev[roleKey] ?? STAGE6_IDLE_ROLE) })));
  };

  // Reads each waiting role's thread back -- a mailbox nudge wakes this
  // immediately, same as the stage's own chat thread; a bounded interval
  // backstops a missed nudge. Never resends a request: this only reads.
  const waitingAddresses = [
    ...(requirements.status === "waiting" && requirements.address ? [["requirements", requirements] as const] : []),
    ...Object.entries(reviews).filter(([, state]) => state.status === "waiting" && state.address),
  ];
  const anyWaiting = waitingAddresses.length > 0;
  useEffect(() => {
    if (!anyWaiting) return;
    const checkOne = async (
      address: string,
      requestedAt: number,
      apply: (reply: string) => void,
      onFail: (message: string) => void,
    ) => {
      const thread = await api.readStageThread(tenantId, [address]).catch((cause: unknown) => {
        onFail(cause instanceof ApiFailure ? cause.detail.message : String(cause));
        return null;
      });
      if (!thread) return;
      const reply = thread.find((message) => message.author === "agent" && Date.parse(message.at) >= requestedAt);
      if (reply) apply(reply.body);
    };
    const checkAll = () => {
      if (requirements.status === "waiting" && requirements.address) {
        void checkOne(
          requirements.address,
          requirements.requestedAt,
          (reply) => setRequirements((prev) => (prev.status === "waiting" ? { ...prev, status: "done", reply } : prev)),
          (message) => setRequirements((prev) => (prev.status === "waiting" ? { ...prev, status: "error", error: message } : prev)),
        );
      }
      for (const [roleKey, state] of Object.entries(reviews)) {
        if (state.status !== "waiting" || !state.address) continue;
        void checkOne(
          state.address,
          state.requestedAt,
          (reply) =>
            setReviews((prev) =>
              prev[roleKey]?.status === "waiting" ? { ...prev, [roleKey]: { ...prev[roleKey]!, status: "done", reply } } : prev,
            ),
          (message) =>
            setReviews((prev) =>
              prev[roleKey]?.status === "waiting" ? { ...prev, [roleKey]: { ...prev[roleKey]!, status: "error", error: message } } : prev,
            ),
        );
      }
    };
    checkAll();
    const subscription = subscribeMailbox(tenantId, checkAll);
    const timer = setInterval(checkAll, 8_000);
    return () => {
      clearInterval(timer);
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyWaiting, tenantId]);

  const current = page === "requirements" ? requirements : (reviews[page] ?? STAGE6_IDLE_ROLE);
  const currentPage = PAGES.find((entry) => entry.key === page) ?? PAGES[0]!;
  const busy = current.status === "starting" || current.status === "waiting";
  const meta =
    current.status === "starting" || current.status === "waiting"
      ? "drafting"
      : current.status === "done"
        ? "draft"
        : current.status === "error"
          ? "failed"
          : page === "requirements"
            ? "waiting on opening material"
            : reviewInput
              ? "not yet requested"
              : "waiting on a plan draft";

  // Once a plan draft exists, `index.tsx` renders the plan itself as
  // `StageDocument` and this panel no longer owns the right pane -- but the
  // requirements author's document and the four panel reviews (and the
  // "Request review" buttons that ask for them) must stay reachable, not
  // disappear with it. A compact companion, not the full two-pane
  // `StagePanes` layout `reader` already fills.
  if (!pane) {
    return (
      <div className="stage6-companion">
        <div className="docmeta">
          <select aria-label="Stage 6 document" value={page} onChange={(event) => setPage(event.target.value)}>
            {PAGES.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
          <span className="inline-note">{meta}</span>
          {page !== "requirements" ? (
            <Button variant="ghost" loading={busy} disabled={!reviewInput || busy} onClick={() => requestReview(page)}>
              {current.status === "done" ? "Request again" : "Request review"}
            </Button>
          ) : null}
        </div>
        {current.status === "error" ? (
          <Banner tone="error" title={page === "requirements" ? "The requirements could not be drafted" : "This review could not be completed"}>
            {current.error}
          </Banner>
        ) : null}
        {current.status === "done" && current.reply ? (
          <details className="document-fold">
            <summary className="document-fold-summary">
              <span className="document-fold-title">{currentPage.label}</span>
            </summary>
            <div className="document-fold-body">
              <Markdown source={current.reply} />
            </div>
          </details>
        ) : null}
      </div>
    );
  }

  return (
    <StagePanes strip={strip} conversation={conversation}>
      {reader ?? (
        <div className="stage-inner">
          <div className="doc">
            <h1>{currentPage.label}</h1>
            <div className="docmeta">
              <span>
                {meta}
                {page === "requirements" ? " · Requirements Author" : ` · ${STAGE6_PANEL_ROLES.find((role) => role.key === page)?.label}`}
              </span>
              <div className="document-tools">
                <select aria-label="Stage 6 document" value={page} onChange={(event) => setPage(event.target.value)}>
                  {PAGES.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                {page !== "requirements" ? (
                  <Button variant="ghost" loading={busy} disabled={!reviewInput || busy} onClick={() => requestReview(page)}>
                    {current.status === "done" ? "Request again" : "Request review"}
                  </Button>
                ) : null}
              </div>
            </div>
            {reviewInput ? <HowItRuns planText={reviewInput} /> : null}
            {current.status === "idle" && page === "requirements" ? (
              <p className="inline-note">Waiting on this stage's opening material.</p>
            ) : null}
            {current.status === "idle" && page !== "requirements" && !reviewInput ? (
              <p className="inline-note">A draft plan is needed before the panel can review it.</p>
            ) : null}
            {current.status === "idle" && page !== "requirements" && reviewInput ? (
              <p className="inline-note">Not yet requested.</p>
            ) : null}
            {busy ? <p className="inline-note">Drafting…</p> : null}
            {current.status === "error" ? (
              <Banner tone="error" title={page === "requirements" ? "The requirements could not be drafted" : "This review could not be completed"}>
                {current.error}
              </Banner>
            ) : null}
            {current.status === "done" && current.reply ? <Markdown source={current.reply} /> : null}
          </div>
        </div>
      )}
    </StagePanes>
  );
}

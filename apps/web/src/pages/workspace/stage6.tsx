/**
 * Stage 6's right pane: one document, not a wall of notes. The requirements
 * author and four panel principals stay real, lazily-deployed agents (CL-8737);
 * a reply lives only in its own mail thread. The surface is the same
 * `.stage-inner` / `.doc` paper as the other stages.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@corbits/react-ui";
import { ChevronDown, Users } from "lucide-react";
import { api, ApiFailure, STAGE6_REQUIREMENTS_ROLE_KEY as REQUIREMENTS_ROLE_KEY, type ArtifactNode } from "../../client.js";
import { useWaitingReplies } from "./use-waiting-replies.ts";
import { useBusyWhile } from "../../use-busy.ts";
import { Markdown } from "../../markdown.jsx";
import { Banner, Button, CopyButton } from "../../components.jsx";
import { requirementsDocument, reviewDocument, withAttachedDocuments, type StageDocument } from "./document-mentions.ts";
import { DocumentExportMenu, draftNode } from "../../document-export.jsx";
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
  /** The reply is the project's recorded document already (#328), not a fresh one to record. */
  recorded?: boolean;
};

const STAGE6_IDLE_ROLE: Stage6RoleState = { status: "idle", address: null, reply: null, error: null, requestedAt: 0 };

const STAGE6_PANEL_ROLES: readonly { key: string; label: string }[] = [
  { key: "application", label: "Application" },
  { key: "quality", label: "Quality" },
  { key: "platform", label: "Platform" },
  { key: "security", label: "Security" },
];

const STAGE6_REQUIREMENTS_ROLE_KEY = REQUIREMENTS_ROLE_KEY;

/** The artifact kind a stage 6 page's draft is exported under (#242): the requirements as the document they become, a panel review under its own name. */
function draftKindOf(page: string): string {
  return page === "requirements" ? "product_requirements" : `build_plan_review_${page}`;
}

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
  requirementsNode = null,
  reviewNodes = null,
  onDocumentsChanged,
  onDocuments,
  requirementsAsk = null,
  onRequirementsDrafted,
  strip,
  conversation,
  reader,
  pane,
  toolsSlot = null,
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
  /** The project's recorded product requirements document, newest version
   *  (#328): shown on a reload instead of asking or waiting. */
  requirementsNode?: ArtifactNode | null;
  /** The project's recorded panel reviews, newest version each, by reviewer (#334). */
  reviewNodes?: ReadonlyMap<string, ArtifactNode> | null;
  /** A document was recorded (#334): the project's artifact graph should be re-read. */
  onDocumentsChanged?: () => void;
  /** The stage's documents as they stand (#345): what a message to the architect may attach. */
  onDocuments?: (documents: StageDocument[]) => void;
  /** A chat message the workspace routed to the requirements author (#407). */
  requirementsAsk?: { body: string; at: number } | null;
  /** Fires once the requirements author's PRODUCT_REQUIREMENTS document is
   *  accepted (its reply lands) — `index.tsx` records it as the project's
   *  document unless `recorded` says it already is (#328), and mints the
   *  workflow's requirement ids from it (CL-8862), before the Architect
   *  drafts. */
  onRequirementsDrafted?: (markdown: string, recorded: boolean) => void;
  strip: ReactNode;
  conversation: ReactNode;
  reader: ReactNode;
  /** When false, the plan's StageDocument already fills the right pane. */
  pane: boolean;
  /** A place in the plan's own toolbar for the panel's request control. */
  toolsSlot?: HTMLElement | null;
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
    onRequirementsDrafted(requirements.reply, requirements.recorded ?? false);
  }, [requirements, onRequirementsDrafted]);

  // On a reload the author is not asked again, so the document is read
  // back (#328): the recorded one when the project has it; else, for a
  // project that minted its ids before the document was ever recorded, the
  // author's own thread, once, and what it wrote is recorded then.
  const recoveredFor = useRef<string | null>(null);
  useEffect(() => {
    if (requirements.status !== "idle") return;
    if (requirementsNode) {
      if (recoveredFor.current === requirementsNode.id) return;
      recoveredFor.current = requirementsNode.id;
      void api
        .artifactContent(tenantId, requirementsNode.id)
        .then((result) => setRequirements((prev) => (prev.status === "idle" ? { ...prev, status: "done", reply: result.content, recorded: true } : prev)))
        .catch(() => undefined);
      return;
    }
    if (!requirementsMinted) return;
    if (recoveredFor.current === `thread:${projectId}`) return;
    recoveredFor.current = `thread:${projectId}`;
    void (async () => {
      const status = await api.stage6RoleAgentStatus(projectId, STAGE6_REQUIREMENTS_ROLE_KEY).catch(() => null);
      if (!status) return;
      const thread = await api.readStageThread(tenantId, [status.address]).catch(() => []);
      const reply = [...thread].reverse().find((message) => message.author === "agent");
      if (!reply) return;
      setRequirements((prev) => (prev.status === "idle" ? { ...prev, address: status.address, status: "done", reply: reply.body, recorded: false } : prev));
    })();
  }, [requirements.status, requirementsNode, requirementsMinted, projectId, tenantId]);

  // The panel reviews the same way (#334): a recorded review is read
  // back; a project that reviewed before reviews were recorded has each
  // reviewer's thread read back once; and a review that lands is recorded.
  const reviewRecoveredFor = useRef(new Set<string>());
  useEffect(() => {
    for (const role of STAGE6_PANEL_ROLES) {
      const state = reviews[role.key] ?? STAGE6_IDLE_ROLE;
      if (state.status !== "idle") continue;
      const node = reviewNodes?.get(role.label) ?? null;
      const mark = node ? `node:${node.id}` : requirementsMinted ? `thread:${projectId}:${role.key}` : null;
      if (!mark || reviewRecoveredFor.current.has(mark)) continue;
      reviewRecoveredFor.current.add(mark);
      const settle = (reply: string, recorded: boolean, address: string | null) =>
        setReviews((prev) => {
          const held = prev[role.key] ?? STAGE6_IDLE_ROLE;
          return held.status === "idle" ? { ...prev, [role.key]: { ...held, address, status: "done", reply, recorded } } : prev;
        });
      if (node) {
        void api
          .artifactContent(tenantId, node.id)
          .then((result) => settle(result.content, true, null))
          .catch(() => undefined);
        continue;
      }
      void (async () => {
        const status = await api.stage6RoleAgentStatus(projectId, role.key).catch(() => null);
        if (!status) return;
        const thread = await api.readStageThread(tenantId, [status.address]).catch(() => []);
        const reply = [...thread].reverse().find((message) => message.author === "agent");
        if (reply) settle(reply.body, false, status.address);
      })();
    }
  }, [reviews, reviewNodes, requirementsMinted, projectId, tenantId]);

  const reviewRecordedFor = useRef(new Set<string>());
  useEffect(() => {
    for (const role of STAGE6_PANEL_ROLES) {
      const state = reviews[role.key];
      if (!state || state.status !== "done" || !state.reply || state.recorded) continue;
      const mark = `${role.key}:${String(state.requestedAt)}:${String(state.reply.length)}`;
      if (reviewRecordedFor.current.has(mark)) continue;
      reviewRecordedFor.current.add(mark);
      const reply = state.reply;
      void api
        .persistEngineeringReview(projectId, role.key, role.label, reply)
        .then(() => {
          setReviews((prev) => (prev[role.key]?.reply === reply ? { ...prev, [role.key]: { ...prev[role.key]!, recorded: true } } : prev));
          onDocumentsChanged?.();
        })
        .catch(() => undefined);
    }
  }, [reviews, projectId, onDocumentsChanged]);

  const runRole = useCallback(
    (roleKey: string, body: string, onUpdate: (updater: (prev: Stage6RoleState) => Stage6RoleState) => void) => {
      onUpdate((prev) => ({ ...prev, status: "starting", error: null, recorded: false }));
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
  const waiting = [
    ...(requirements.status === "waiting" && requirements.address
      ? [{ key: STAGE6_REQUIREMENTS_ROLE_KEY, address: requirements.address, requestedAt: requirements.requestedAt }]
      : []),
    ...Object.entries(reviews).flatMap(([key, state]) =>
      state.status === "waiting" && state.address ? [{ key, address: state.address, requestedAt: state.requestedAt }] : [],
    ),
  ];
  const settle = (key: string, next: Partial<Stage6RoleState>) => {
    if (key === STAGE6_REQUIREMENTS_ROLE_KEY) setRequirements((prev) => (prev.status === "waiting" ? { ...prev, ...next } : prev));
    else setReviews((prev) => (prev[key]?.status === "waiting" ? { ...prev, [key]: { ...prev[key]!, ...next } } : prev));
  };
  useWaitingReplies(
    tenantId,
    waiting,
    (key, reply) => settle(key, { status: "done", reply }),
    (key, error) => settle(key, { status: "error", error }),
  );

  // What the stage has written so far, as documents a message may name (#345).
  const documents: StageDocument[] = [
    ...(requirements.status === "done" && requirements.reply ? [requirementsDocument(requirements.reply)] : []),
    ...STAGE6_PANEL_ROLES.flatMap((role) => {
      const state = reviews[role.key];
      return state?.status === "done" && state.reply ? [reviewDocument(role.label, state.reply)] : [];
    }),
  ];
  const documentsKey = documents.map((doc) => `${doc.key}:${String(doc.content.length)}`).join("|");
  useEffect(() => {
    onDocuments?.(documents);
    // Re-reported when a document arrives or changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentsKey]);

  // Addressing a companion specialist directly (#345): the ask, with any
  // named documents attached, goes to that role's own thread; the reply
  // becomes the next version of its document through the same paths a
  // first request takes.
  const [ask, setAsk] = useState("");
  const askRole = (roleKey: string, text = ask) => {
    const asked = withAttachedDocuments(text.trim(), documents.filter((doc) => doc.key !== (roleKey === STAGE6_REQUIREMENTS_ROLE_KEY ? "requirements" : `review:${roleKey}`)));
    if (!asked) return;
    // A companion role sees only what it is sent, and after a redeploy it
    // remembers nothing (#409): the author always gets the approved
    // inputs and the current document as the prior revision; a reviewer
    // gets the ids and the plan, as a first request does.
    const body =
      roleKey === STAGE6_REQUIREMENTS_ROLE_KEY
        ? [
            asked,
            requirements.reply ? `---\n\n## Attached: Product requirements (prior revision, keep its ids)\n\n${requirements.reply.trim()}` : null,
            requirementsInput ? `---\n\n## Attached: Approved inputs this document is drawn from\n\n${requirementsInput.trim()}` : null,
          ]
            .filter((part): part is string => part !== null)
            .join("\n\n")
        : [asked, requirementsBlock, reviewInput ? `---\n\n## Attached: The build plan under review\n\n${reviewInput.trim()}` : null].filter((part): part is string => part !== null).join("\n\n");
    setAsk("");
    if (roleKey === STAGE6_REQUIREMENTS_ROLE_KEY) runRole(roleKey, body, setRequirements);
    else runRole(roleKey, body, (updater) => setReviews((prev) => ({ ...prev, [roleKey]: updater(prev[roleKey] ?? STAGE6_IDLE_ROLE) })));
  };

  // A requirements request typed to the architect lands here (#407).
  const routedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!requirementsAsk || routedFor.current === requirementsAsk.at) return;
    routedFor.current = requirementsAsk.at;
    setPage("requirements");
    askRole(STAGE6_REQUIREMENTS_ROLE_KEY, requirementsAsk.body);
    // `askRole` reads the documents of the moment; the request is what fires this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirementsAsk]);

  // The companion roles say what they are doing while they work (#407).
  const requirementsBusy = requirements.status === "starting" || requirements.status === "waiting";
  useBusyWhile(requirementsBusy, requirementsNode || requirements.reply ? "Requirements author is rewriting the requirements" : "Requirements author is writing the requirements");
  const reviewingRole = STAGE6_PANEL_ROLES.find((role) => reviews[role.key]?.status === "starting" || reviews[role.key]?.status === "waiting");
  useBusyWhile(reviewingRole !== undefined, `${reviewingRole?.label ?? "A"} reviewer is reviewing the plan`);

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
            ? requirementsMinted || requirementsNode
              ? "looking for the requirements document"
              : "waiting on opening material"
            : reviewInput
              ? "not yet requested"
              : "waiting on a plan draft";

  // Once a plan draft exists, the plan fills the right pane as the stage's
  // one document and the architect's chat is the stage's one conversation.
  // The requirements and the four reviews are tabs of their own in the
  // strip, and a chat message asking for a requirements change reaches the
  // author (#407), so nothing here takes a band of the window: only the
  // panel's request control, in the plan's own toolbar, and any failure.
  if (!pane) {
    const failures = [
      requirements.status === "error" ? { key: "requirements", title: "The requirements could not be drafted", error: requirements.error } : null,
      ...STAGE6_PANEL_ROLES.map((role) =>
        reviews[role.key]?.status === "error"
          ? { key: role.key, title: `The ${role.label.toLowerCase()} review could not be completed`, error: reviews[role.key]!.error }
          : null,
      ),
    ].filter((failure) => failure !== null);
    return (
      <>
        {failures.map((failure) => (
          <Banner key={failure.key} tone="error" title={failure.title}>
            {failure.error}
          </Banner>
        ))}
        {toolsSlot
          ? createPortal(
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" disabled={!reviewInput}>
                    <Users aria-hidden="true" />
                    Request review
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {STAGE6_PANEL_ROLES.map((role) => {
                    const state = reviews[role.key] ?? STAGE6_IDLE_ROLE;
                    const working = state.status === "starting" || state.status === "waiting";
                    return (
                      <MenuItem key={role.key} disabled={working} onSelect={() => requestReview(role.key)}>
                        {role.label} review
                        {working ? " · reviewing…" : state.status === "done" ? " · ask again" : ""}
                      </MenuItem>
                    );
                  })}
                </MenuContent>
              </Menu>,
              toolsSlot,
            )
          : null}
      </>
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
                {current.status === "done" && current.reply ? (
                  <>
                    <CopyButton text={current.reply} />
                    <DocumentExportMenu node={draftNode(draftKindOf(page), 6, currentPage.label)} tenantId={tenantId} content={current.reply} />
                  </>
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

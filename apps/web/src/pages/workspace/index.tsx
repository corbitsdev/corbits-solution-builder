/**
 * The stage workspace.
 *
 * A stage is a document someone has to read and react to, so the document is
 * the page. Before one exists there is a single question and nothing else;
 * once one exists the draft box is gone and the document takes the room, with
 * the conversation that produced it alongside.
 *
 * Reacting to a document means saying what is wrong with a specific part of
 * it, so selecting text in the document opens a comment on that passage.
 * Comments queue rather than sending one at a time — a reader marks up a whole
 * draft and then hands it back, which is both how people actually read and the
 * only way the specialist sees the notes as one coherent set.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiFailure,
  STAGE_DRAFT_KIND,
  type ArtifactNode,
  type ProjectDetail,
} from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { Markdown } from "../../markdown.jsx";
import { AudiencePackages } from "../audiences.jsx";
import { DesignFeedbackView } from "../design.jsx";
import { Tabs } from "@corbits/react-ui";
import { Banner, Button, Screen, StateLabel, stageName, versionDigest } from "../../components.jsx";
import { STAGE_GOAL } from "./gate.jsx";
import { StageConversation } from "./thread.jsx";
import type { FoldedFeedback, StageStatus } from "../../run-fold.ts";

export { StageDocument, DocumentBody } from "./document.jsx";
export { ApprovalsRecord, STAGE_GOAL } from "./gate.jsx";

const LAST_STAGE = 9;

/** 1 + the highest stage that has a live, approved draft artifact — the
 *  mail-chat contract's own stage cursor (CL-8612): no lifecycle run, no
 *  gate signal, just the artifact graph the person already approved into. */
function currentStageFromArtifacts(nodes: readonly ArtifactNode[]): number {
  let stage = 1;
  for (let candidate = 1; candidate <= LAST_STAGE; candidate += 1) {
    const approved = nodes.some(
      (node) => node.stage === candidate && node.kind === STAGE_DRAFT_KIND[candidate] && node.supersededByNodeId === null,
    );
    if (!approved) break;
    stage = Math.min(candidate + 1, LAST_STAGE);
  }
  return stage;
}

/** Stands in for a version that would not load, so it never reads as empty. */
const UNREADABLE = "_This version could not be read. It is still on disk — try again._";

export function StageWorkspace({
  detail,
  tenantId,
  onChanged,
  onOpenSettings,
}: {
  detail: ProjectDetail;
  /**
   * Accepted for compatibility with callers still on the pre-mail-chat
   * shape; unused here — the mail-chat contract (CL-8612) has no lifecycle
   * run to fold a position from, no draft/versions split, and stage 9's
   * decisions live entirely in the existing approvals UI, not this page.
   */
  standing?: StageStatus | null;
  draftOpen?: boolean;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  onOpenSettings: () => void;
  onOpenDecisions?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<
    import("../../client.js").Remediation | undefined
  >(undefined);

  // 1 + the highest stage with a live, approved draft artifact. No lifecycle
  // run, no gate signal — just the artifact graph the person already
  // approved into (CL-8612). `stageFloor` is bumped optimistically the
  // instant an approval lands, ahead of `detail` catching up on refetch, so
  // the UI advances the moment the person clicks rather than waiting on a
  // round trip through `onChanged`.
  const derivedStage = useMemo(() => currentStageFromArtifacts(detail.nodes), [detail.nodes]);
  const [stageFloor, setStageFloor] = useState(derivedStage);
  const stage = Math.max(derivedStage, stageFloor);
  useEffect(() => {
    if (derivedStage > stageFloor) setStageFloor(derivedStage);
  }, [derivedStage, stageFloor]);

  // The specialist for this project's stage: deployed lazily the first time
  // the stage is opened (CL-8612 contract v6 — one mail agent per stage,
  // never a lifecycle workflow run). `agentAddress` is the single source of
  // truth for "the agent is known" — the composer and every stage panel key
  // off it directly rather than a separate readiness flag, so there is no
  // window where the address is known but something built on top of it is
  // still disabled.
  const [agentAddress, setAgentAddress] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAgentAddress(null);
    api
      .ensureStageAgent(detail.project.id, stage)
      .then((deployment) => {
        if (!cancelled) setAgentAddress(deployment.address);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id, stage]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const loadThread = useCallback(async () => {
    if (!agentAddress) return;
    try {
      setMessages(await api.readStageThread(tenantId, [agentAddress]));
    } catch (cause) {
      setError(
        `The conversation for this stage could not be read: ${
          cause instanceof ApiFailure ? cause.detail.message : String(cause)
        }`,
      );
    }
  }, [agentAddress, tenantId]);

  // Polled every 3s while the agent's address is known: the specialist's own
  // replies land in the mailbox on its own time, with nothing to push a
  // client-side event for them.
  useEffect(() => {
    if (!agentAddress) return;
    void loadThread();
    const timer = setInterval(() => void loadThread(), 3_000);
    return () => clearInterval(timer);
  }, [agentAddress, loadThread]);

  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);

  // Stage 1's own opening problem statement, read straight off its
  // lifecycle deployment (`api.projectOpening`, scoped to the workspace
  // tenant `createProject` actually deployed it into) rather than
  // `detail.opening` — `loadProjectView`'s own fold reads that scoped to
  // the project's own child tenant, where that deployment never lived, and
  // so always comes back null, silently starving the auto-send below.
  const [opening, setOpening] = useState<{ body: string } | null | undefined>(undefined);
  useEffect(() => {
    if (stage !== 1) return;
    let cancelled = false;
    api
      .projectOpening(detail.project.id)
      .then((result) => {
        if (!cancelled) setOpening(result);
      })
      .catch(() => {
        if (!cancelled) setOpening(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id, stage]);

  // The stage-1 opening problem statement is the first message of that
  // stage's thread, sent once. A later stage's opening is instead the just-
  // approved draft, sent from `approve()` below the moment the stage
  // advances — this only fires the very first message of a fresh thread.
  const openedRef = useRef<string | null>(null);
  const [pendingOpening, setPendingOpening] = useState<{ stage: number; body: string } | null>(null);
  useEffect(() => {
    if (!agentAddress || messages.length > 0) return;
    const body = stage === 1 ? (opening?.body ?? null) : pendingOpening?.stage === stage ? pendingOpening.body : null;
    if (!body) return;
    const key = `${detail.project.id}:${stage}`;
    if (openedRef.current === key) return;
    openedRef.current = key;
    void api
      .sendStageMail(tenantId, agentAddress, { body })
      .then(() => loadThread())
      .catch((cause: unknown) => {
        setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
  }, [agentAddress, messages.length, stage, detail.project.id, opening, pendingOpening, tenantId, loadThread]);

  const send = async (body: string) => {
    if (!agentAddress || body.trim().length === 0) return;
    setSending(true);
    setError(null);
    setRemediation(undefined);
    try {
      await api.sendStageMail(tenantId, agentAddress, { body });
      await loadThread();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
    } finally {
      setSending(false);
    }
  };

  const latestSpecialistMessage = [...messages].reverse().find((message) => message.author === "agent") ?? null;

  /**
   * Persists the specialist's latest reply as this stage's approved draft,
   * advances the UI to the next stage, and sends the approved text on as
   * that stage's opening mail — deploying its specialist lazily the same way
   * opening any stage does. No gate signal, no lifecycle run: the artifact
   * write and the client's own stage cursor are the whole approval.
   */
  const approve = async () => {
    if (!latestSpecialistMessage || stage >= LAST_STAGE) return;
    setApproving(true);
    setError(null);
    setRemediation(undefined);
    try {
      const materials = detail.nodes.filter((node) => node.kind === "source_material").map((node) => node.id);
      await api.persistStageDraft(detail.project.id, stage, latestSpecialistMessage.body, materials);
      const next = stage + 1;
      setStageFloor(next);
      setPendingOpening({ stage: next, body: latestSpecialistMessage.body });
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
    } finally {
      setApproving(false);
    }
  };

  const panelReviews = detail.nodes.filter(
    (node) => node.stage === stage && node.kind === "engineering_review",
  );
  const requirements =
    detail.nodes.find((node) => node.stage === stage && node.kind === "product_requirements" && node.supersededByNodeId === null) ??
    null;

  return (
    <div className="stage-view">
      {error ? (
        <Banner
          tone="error"
          title={error}
          {...(remediation
            ? {
                action: {
                  label: remediation.label,
                  onClick: () => {
                    if (remediation.kind === "retry") {
                      setError(null);
                      setRemediation(undefined);
                      return;
                    }
                    onOpenSettings();
                  },
                },
              }
            : {})}
        />
      ) : null}

      {!agentAddress ? (
        <Screen title={`Stage ${stage} of 9 · ${stageName(stage)}`} description={STAGE_GOAL[stage]} tight>
          <p className="inline-note">Starting the {stageName(stage).toLowerCase()} specialist…</p>
        </Screen>
      ) : null}

      {agentAddress && stage === 4 ? (
        <DesignPanel
          detail={detail}
          tenantId={tenantId}
          onChanged={onChanged}
          onApprove={approve}
          onRevise={(prompt) => send(prompt)}
          latestReply={latestSpecialistMessage}
        />
      ) : null}

      {agentAddress && stage === 5 ? (
        <div className="stage-scroll">
          <AudiencePackages
            detail={detail}
            tenantId={tenantId}
            onChanged={onChanged}
            drafting={sending}
            onDraftPackages={(audiences) => void send(`Write the packages again for: ${audiences.join(", ")}.`)}
          />
        </div>
      ) : null}

      {agentAddress && stage === 8 ? (
        <div className="stage-scroll">
          <BuildPanel detail={detail} tenantId={tenantId} onChanged={onChanged} onOpenSettings={onOpenSettings} />
        </div>
      ) : null}

      {agentAddress && (requirements || panelReviews.length > 0) ? (
        <div className="stage-companions">
          {requirements ? (
            <ProductRequirements
              node={requirements}
              tenantId={tenantId}
              canRewrite={agentAddress !== null}
              busy={sending}
              onRewrite={() => void send("Write the requirements again, and the plan against them.")}
            />
          ) : null}
          {panelReviews.length > 0 ? <PanelReviews reviews={panelReviews} tenantId={tenantId} /> : null}
        </div>
      ) : null}

      {agentAddress && stage !== 4 && stage !== 5 && stage !== 8 ? (
        <>
          <Screen
            title={`Stage ${stage} of 9 · ${stageName(stage)}`}
            description={STAGE_GOAL[stage]}
            status={
              stage >= LAST_STAGE ? null : (
                <Button variant="primary" loading={approving} disabled={!latestSpecialistMessage} onClick={() => void approve()}>
                  Approve and continue
                </Button>
              )
            }
            tight
          >
            {latestSpecialistMessage ? (
              <div className="document-body">
                <Markdown source={latestSpecialistMessage.body} />
              </div>
            ) : messages.length > 0 ? (
              <p className="inline-note">Waiting on the specialist's first reply…</p>
            ) : (
              <p className="inline-note">Say what you'd like below to start the conversation.</p>
            )}
          </Screen>
          <StageConversation
            stage={stage}
            messages={messages}
            value={composer}
            onValueChange={setComposer}
            onSend={() => {
              const body = composer;
              setComposer("");
              void send(body);
            }}
            working={sending}
            disabled={!agentAddress}
          />
        </>
      ) : null}
    </div>
  );
}

/** Loads the stage-4 design history and its feedback, then renders the flow. */
function DesignPanel({
  detail,
  tenantId,
  onChanged,
  onApprove,
  onRevise,
  latestReply,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  /** Persists the specialist's latest reply and advances to stage 5. */
  onApprove: () => Promise<unknown>;
  /** Sends free-form feedback text to the stage-4 specialist's mail thread. */
  onRevise: (prompt: string) => Promise<unknown>;
  /** The specialist's latest unpersisted reply — the mockup, before approval. */
  latestReply: ChatMessage | null;
}) {
  // The design history is just this project's `design_artifact` nodes —
  // already on `detail`, so no route of its own is needed to read it. Under
  // the mail-chat contract nothing writes one of these until approval, so
  // the specialist's latest reply stands in as a not-yet-persisted design
  // while none exists yet.
  const persisted = useMemo(
    () => detail.nodes.filter((node) => node.kind === "design_artifact").sort((left, right) => left.version - right.version),
    [detail.nodes],
  );
  const draftNode: ArtifactNode | null = latestReply
    ? {
        id: `reply:${latestReply.id}`,
        kind: "design_artifact",
        variant: null,
        stage: 4,
        title: stageName(4),
        version: (persisted.at(-1)?.version ?? 0) + 1,
        artifactId: `reply:${latestReply.id}`,
        contentHash: "",
        sizeBytes: latestReply.body.length,
        mediaType: "text/html",
        createdAt: latestReply.at,
        supersededByNodeId: null,
        provenance: { producer: "specialist" },
      }
    : null;
  const designs = persisted.length > 0 ? persisted : draftNode ? [draftNode] : [];
  const [contentByNode, setContentByNode] = useState(new Map<string, string>());
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const contents = await Promise.all(
      persisted.map(async (design) => {
        // An unreadable version is not an empty one. Saying so on the version
        // itself keeps the rest of the history usable.
        const artifact = await api.artifactContent(tenantId, design.id).catch(() => null);
        return [design.id, artifact?.content ?? UNREADABLE] as const;
      }),
    );
    setContentByNode(new Map(draftNode ? [...contents, [draftNode.id, latestReply?.body ?? ""] as const] : contents));
  }, [persisted, tenantId, draftNode?.id, latestReply?.body]);

  useEffect(() => {
    void load().catch((cause: unknown) => {
      setLoadError(`The design history could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }, [load]);

  return (
    // The stage fills the window and clips, so this is the region that
    // scrolls: a mockup, its comments and the feedback form together run
    // well past one screen.
    <div className="design-review">
      {loadError ? (
        <Banner tone="error" title="The design history could not be read">
          {loadError}
        </Banner>
      ) : null}
      <DesignFeedbackView
        designs={designs}
        feedbackByNode={new Map<string, FoldedFeedback>()}
        contentByNode={contentByNode}
        tenantId={tenantId}
        approval={{
          soloApproval: detail.soloApproval,
          canApprove: latestReply !== null,
          onApprove: () => onApprove(),
        }}
        revise={(_feedback, prompt) => onRevise(prompt)}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

/** Stage 7 → 8: cost approval, then the freeze interlock. */
/**
 * Stage 8: build supervision, talking to the stage's own mail agent.
 *
 * Contract v6 gives stage 8 a posix tool inside its own single-step run
 * rather than a separate host build-worker bridge with its own signal
 * chain: there is no lifecycle run to park a build attempt's state on
 * any more, so "start"/"cancel"/"accept"/"fail" are sent as plain mail, the
 * same way any other stage's specialist is talked to. The rich event
 * timeline the old bridge reported (live output, exit status, packaged
 * archive) has no replacement yet — CL-8072 follow-up.
 */
function BuildPanel({
  detail,
  tenantId,
  onChanged,
  onOpenSettings,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  onOpenSettings: () => void;
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .ensureStageAgent(detail.project.id, 8)
      .then((deployment) => {
        if (!cancelled) setAddress(deployment.address);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id]);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      setMessages(await api.readStageThread(tenantId, [address]));
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  }, [address, tenantId]);

  useEffect(() => {
    if (!address) return;
    void load();
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [address, load]);

  const send = async (label: string, body: string) => {
    if (!address) return;
    setBusy(label);
    setError(null);
    try {
      await api.sendStageMail(tenantId, address, { body });
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-tour="build-panel">
      <Screen
        title="Build supervision"
        status={address ? <StateLabel tone="selected">talking to the build specialist</StateLabel> : null}
      >
        {error ? (
          <Banner tone="error" title="The build attempt could not be changed" action={{ label: "Open Settings", onClick: onOpenSettings }}>
            {error}
          </Banner>
        ) : null}
        {!address ? <p className="inline-note">Starting the build specialist…</p> : null}
        <div className="button-row">
          <Button variant="primary" loading={busy === "start"} disabled={!address} onClick={() => void send("start", "Start the build attempt.")}>
            Start the build attempt
          </Button>
          <Button variant="destructive" loading={busy === "cancel"} disabled={!address} onClick={() => void send("cancel", "Cancel the build attempt.")}>
            Cancel the build attempt
          </Button>
          <Button variant="primary" loading={busy === "accept"} disabled={!address} onClick={() => void send("accept", "Accept this build attempt's work as evidence.")}>
            Accept as evidence
          </Button>
          <Button variant="destructive" loading={busy === "fail"} disabled={!address} onClick={() => void send("fail", "Mark this build attempt failed.")}>
            Mark this attempt failed
          </Button>
        </div>
      </Screen>
      <StageConversation
        stage={8}
        messages={messages}
        value={composer}
        onValueChange={setComposer}
        onSend={() => {
          const body = composer;
          setComposer("");
          void send("message", body);
        }}
        working={busy !== null}
        disabled={!address}
      />
    </div>
  );
}

/**
 * The senior engineer panel's four independent reviews.
 *
 * Shown side by side and never merged. Section 8 makes the four principals
 * independent, and a UI that concatenates them into one scrolling document
 * undoes that at the last step — the reader has to be able to see that
 * security and platform reached their verdicts separately.
 */
/**
 * Stage 6's requirements, beside the plan: what stages 1 to 4 agreed,
 * gathered into the document the plan is written against. Folded to one line
 * by default, since the plan is what the person is here to read.
 */
function ProductRequirements({
  node,
  tenantId,
  canRewrite,
  busy,
  onRewrite,
}: {
  node: ArtifactNode;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  canRewrite: boolean;
  busy: boolean;
  onRewrite: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    void api
      .artifactContent(tenantId, node.id)
      .then((result) => {
        if (!cancelled) setContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setContent(UNREADABLE);
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, tenantId]);
  return (
    <Screen
      title="Product requirements"
      description="What stages 1 to 4 agreed, gathered into the one document the plan is written against. The plan cites its ids."
      status={<StateLabel tone="info">Version {node.version}</StateLabel>}
      tight
    >
      <details className="document-fold">
        <summary className="document-fold-summary">
          <span className="document-fold-title">Requirements</span>
          <span className="document-fold-digest">{versionDigest(node)}</span>
        </summary>
        <div className="document-body document-fold-body">
          {content === null ? <p className="inline-note">Loading…</p> : <Markdown source={content} />}
        </div>
      </details>
      {canRewrite ? (
        <div className="button-row">
          <Button loading={busy} onClick={onRewrite}>
            Write the requirements again
          </Button>
        </div>
      ) : null}
    </Screen>
  );
}

function PanelReviews({ reviews, tenantId }: { reviews: ArtifactNode[]; tenantId: string }) {
  const live = reviews.filter((node) => node.supersededByNodeId === null);
  const [openId, setOpenId] = useState<string | null>(live[0]?.id ?? null);
  const [contents, setContents] = useState(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      live.map(async (node) => {
        const result = await api.artifactContent(tenantId, node.id).catch(() => null);
        return [node.id, result?.content ?? UNREADABLE] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setContents(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [live.map((node) => node.id).join(","), tenantId]);

  const open = live.find((node) => node.id === openId) ?? live[0] ?? null;
  const body = open ? (contents.get(open.id) ?? "") : "";
  const verdictOf = (text: string) => {
    const match = /##\s*Verdict\s*\n+([^\n#]+)/i.exec(text);
    return match?.[1]?.trim() ?? null;
  };
  // Folded, the line carries every principal's verdict, so the four can be
  // compared without opening any of them.
  const verdicts = live
    .map((node) => `${node.variant ?? node.title}: ${verdictOf(contents.get(node.id) ?? "") ?? "…"}`)
    .join(" · ");

  return (
    <Screen
      title="Independent engineering review"
      description="Four principals reviewed this plan separately. Their findings are not merged."
      tight
    >
      <details className="document-fold">
        <summary className="document-fold-summary">
          <span className="document-fold-title">Reviews</span>
          <span className="document-fold-digest">{verdicts}</span>
        </summary>
        <div className="document-fold-body">
          <Tabs
            label="Panel principals"
            active={open?.id ?? ""}
            onChange={setOpenId}
            tabs={live.map((node) => ({
              id: node.id,
              label: node.variant ?? node.title,
            }))}
          >
            {/* The review reads inside the panel the tab controls, so switching
                principals announces the finding rather than an empty region. */}
            {() => (
              <>
                <p className="inline-note">
                  {open ? (verdictOf(contents.get(open.id) ?? "") ?? "No verdict stated.") : null}
                </p>
                <div className="document-body">
                  {body ? <Markdown source={body} /> : <p className="inline-note">Loading…</p>}
                </div>
              </>
            )}
          </Tabs>
        </div>
      </details>
    </Screen>
  );
}


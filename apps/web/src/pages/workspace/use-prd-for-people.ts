/**
 * The PRD for people (#737), kept current at every stage (#740).
 *
 * The document depends on two artifacts only: the product requirements and
 * the design. It is written when it is missing or older than the newest of
 * either, whatever stage the project is at, and its record names the
 * versions it was written from. Writing it touches nothing else: no
 * estimate, approval or build attempt reads it.
 *
 * The writer is the Requirements explainer, a real deployment with its own
 * thread; its reply is read back from that thread and recorded as the
 * project's prd_for_people document.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure, STAGE6_PEOPLE_ROLE_KEY, type ArtifactNode } from "../../client.js";
import { subscribeMailbox } from "../../mailbox-events.ts";
import { useBusyWhile } from "../../use-busy.ts";
import { PRD_FOR_PEOPLE_KIND, cleanPeopleDocument, composePeopleBrief, mockupKey } from "../../prd-for-people.ts";
import { screenNamesOf, type MockupShot } from "../../mockup-shots.ts";
import { cachedFramedMockupShots } from "../../mockup-cache.ts";
import { IDLE_COMPANION, type CompanionState } from "./companion-state.ts";

/** The newest unsuperseded node of a kind, or null. */
export function newestOfKind(nodes: readonly ArtifactNode[], kind: string): ArtifactNode | null {
  return nodes.filter((node) => node.kind === kind && node.supersededByNodeId === null).sort((a, b) => b.version - a.version || Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
}

/**
 * Whether the PRD for people needs writing: there is a PRD, and the
 * document is missing or older than the PRD or the design. Decided from
 * the record alone, so a reload reaches the same answer.
 */
export function prdForPeopleStale(
  people: Pick<ArtifactNode, "createdAt"> | null,
  requirements: Pick<ArtifactNode, "createdAt"> | null,
  design: Pick<ArtifactNode, "createdAt"> | null,
): boolean {
  if (!requirements) return false;
  if (!people) return true;
  const written = Date.parse(people.createdAt);
  return written < Date.parse(requirements.createdAt) || (design !== null && written < Date.parse(design.createdAt));
}

/** The design's text, read once per design version; "" when it cannot be read, null while reading or without a design. */
export function useDesignHtml(tenantId: string, design: ArtifactNode | null): string | null {
  const [html, setHtml] = useState<string | null>(null);
  const designId = design?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!designId) {
      setHtml(null);
      return;
    }
    setHtml(null);
    api
      .artifactContent(tenantId, designId)
      .then((result) => {
        if (!cancelled) setHtml(result.content);
      })
      .catch(() => {
        // Unreadable: the writer goes without pictures rather than never being asked.
        if (!cancelled) setHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, designId]);
  return html;
}

/** PNG bytes as base64, in chunks a call stack can take. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * The design's screens drawn in their bodies, by screen key, as data URLs
 * (#737): what the PRD for people's references resolve to on the page.
 * Drawn once per design text, and only while wanted.
 */
export function useDesignPictures(designHtml: string | null, enabled: boolean): ReadonlyMap<string, string> | undefined {
  const [pictures, setPictures] = useState<{ html: string; map: ReadonlyMap<string, string> } | null>(null);
  useEffect(() => {
    if (!enabled || !designHtml || pictures?.html === designHtml) return;
    let cancelled = false;
    cachedFramedMockupShots(designHtml, 12)
      .then((shots: MockupShot[]) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const shot of shots) map.set(mockupKey(shot.name), `data:image/png;base64,${bytesToBase64(shot.png)}`);
        setPictures({ html: designHtml, map });
      })
      .catch(() => {
        if (!cancelled) setPictures({ html: designHtml, map: new Map() });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, designHtml, pictures?.html]);
  return pictures?.html === designHtml ? pictures.map : undefined;
}

/** The newest design's pictures for a project, for a reader of the PRD for people anywhere. */
export function useProjectDesignPictures(tenantId: string, nodes: readonly ArtifactNode[], enabled: boolean): ReadonlyMap<string, string> | undefined {
  const design = newestOfKind(nodes, "design_artifact");
  const html = useDesignHtml(tenantId, enabled ? design : null);
  return useDesignPictures(html, enabled);
}

export function usePrdForPeople({
  projectId,
  tenantId,
  nodes,
  approvedInputs = null,
  onDocumentsChanged,
}: {
  projectId: string;
  tenantId: string;
  nodes: readonly ArtifactNode[];
  /** Build plan's opening material, when the page has it: context the writer may be shown. */
  approvedInputs?: string | null;
  onDocumentsChanged?: () => void;
}): {
  people: CompanionState;
  /** Sends the writer a body and reads its reply back; the reply becomes the next version. */
  send: (body: string) => void;
  designHtml: string | null;
  requirementsNode: ArtifactNode | null;
  peopleNode: ArtifactNode | null;
} {
  const requirementsNode = newestOfKind(nodes, "product_requirements");
  const designNode = newestOfKind(nodes, "design_artifact");
  const peopleNode = newestOfKind(nodes, PRD_FOR_PEOPLE_KIND);
  const designHtml = useDesignHtml(tenantId, designNode);
  const [people, setPeople] = useState<CompanionState>(IDLE_COMPANION);

  const send = useCallback(
    (body: string) => {
      setPeople((prev) => ({ ...prev, status: "starting", error: null, recorded: false }));
      void (async () => {
        try {
          const deployment = await api.ensureStage6RoleAgent(projectId, STAGE6_PEOPLE_ROLE_KEY);
          const requestedAt = Date.now();
          setPeople((prev) => ({ ...prev, address: deployment.address, status: "waiting", requestedAt }));
          await api.sendStageMail(tenantId, deployment.address, { body });
        } catch (cause) {
          setPeople((prev) => ({ ...prev, status: "error", error: cause instanceof ApiFailure ? cause.detail.message : String(cause) }));
        }
      })();
    },
    [projectId, tenantId],
  );

  // A recorded document is read back on a reload.
  const recoveredFor = useRef<string | null>(null);
  useEffect(() => {
    if (people.status !== "idle" || !peopleNode) return;
    if (recoveredFor.current === peopleNode.id) return;
    recoveredFor.current = peopleNode.id;
    void api
      .artifactContent(tenantId, peopleNode.id)
      .then((result) => setPeople((prev) => (prev.status === "idle" ? { ...prev, status: "done", reply: cleanPeopleDocument(result.content), recorded: true } : prev)))
      .catch(() => undefined);
  }, [people.status, peopleNode, tenantId]);

  // Written when stale, once per (PRD version, design version), at any stage.
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!requirementsNode) return;
    if (designNode && designHtml === null) return;
    if (!prdForPeopleStale(peopleNode, requirementsNode, designNode)) return;
    if (people.status === "starting" || people.status === "waiting") return;
    const key = `${requirementsNode.id}:${designNode?.id ?? "-"}`;
    if (askedFor.current === key) return;
    askedFor.current = key;
    void (async () => {
      const requirements = await api.artifactContent(tenantId, requirementsNode.id).then((result) => result.content, () => null);
      if (!requirements) return;
      const prior = peopleNode ? await api.artifactContent(tenantId, peopleNode.id).then((result) => result.content, () => null) : null;
      send(composePeopleBrief({ requirements, screens: designHtml ? screenNamesOf(designHtml) : [], approvedInputs, prior }));
    })();
    // `approvedInputs` is context of the moment; the PRD and design versions are what decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirementsNode?.id, designNode?.id, peopleNode?.id, designHtml, people.status, tenantId, send]);

  // The reply is read back from the writer's thread.
  useEffect(() => {
    if (people.status !== "waiting" || !people.address) return;
    const address = people.address;
    const requestedAt = people.requestedAt;
    const check = async () => {
      const thread = await api.readStageThread(tenantId, [address]).catch((cause: unknown) => {
        setPeople((prev) => (prev.status === "waiting" ? { ...prev, status: "error", error: cause instanceof ApiFailure ? cause.detail.message : String(cause) } : prev));
        return null;
      });
      if (!thread) return;
      const reply = thread.find((message) => message.author === "agent" && Date.parse(message.at) >= requestedAt);
      // The reply as the document (#742): without the writer's word about it.
      if (reply) setPeople((prev) => (prev.status === "waiting" ? { ...prev, status: "done", reply: cleanPeopleDocument(reply.body) } : prev));
    };
    void check();
    const subscription = subscribeMailbox(tenantId, () => void check());
    const timer = setInterval(() => void check(), 20_000);
    return () => {
      clearInterval(timer);
      subscription.unsubscribe();
    };
  }, [people.status, people.address, people.requestedAt, tenantId]);

  // A reply that lands is recorded, naming the versions it was written from.
  const recordedFor = useRef<string | null>(null);
  useEffect(() => {
    if (people.status !== "done" || !people.reply || people.recorded) return;
    const mark = `${String(people.requestedAt)}:${String(people.reply.length)}`;
    if (recordedFor.current === mark) return;
    recordedFor.current = mark;
    const reply = people.reply;
    const sources = [requirementsNode?.id, designNode?.id].filter((id): id is string => typeof id === "string");
    void api
      .persistPrdForPeople(projectId, reply, sources)
      .then(() => {
        setPeople((prev) => (prev.reply === reply ? { ...prev, recorded: true } : prev));
        onDocumentsChanged?.();
      })
      .catch(() => undefined);
  }, [people, projectId, requirementsNode?.id, designNode?.id, onDocumentsChanged]);

  const busy = people.status === "starting" || people.status === "waiting";
  useBusyWhile(busy, peopleNode ? "Requirements explainer is rewriting the PRD for people" : "Requirements explainer is writing the PRD for people");

  return { people, send, designHtml, requirementsNode, peopleNode };
}

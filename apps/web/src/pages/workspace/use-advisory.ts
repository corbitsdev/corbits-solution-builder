/**
 * The workspace's two advisory agents — both optional, both silent on
 * failure, neither ever writes an artifact or touches the approve gate.
 *
 * Stage 1's brief evaluator (CL-8736): a second, deployed-on-demand agent
 * mailed a copy of the current draft, its reply read back as an advisory
 * verdict beside the gate.
 *
 * The Product guide (CL-8737): calm orientation across the nine stages,
 * asked for rather than shown. The checklist is computed from the workflow
 * view and artifact nodes — always available, never wrong — and is what the
 * guide starts as and falls back to.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import type { ArtifactNode } from "../../client.js";
import type { ProjectWorkflowView } from "../../project-workflow.ts";
import { evaluatorVerdict as guidanceEvaluatorVerdict } from "./guidance.js";
import { deterministicGuidance, guidancePrompt, parseGuidanceReply, type Guidance } from "./product-guide.js";

export type StageEvaluator = {
  readonly verdict: ReturnType<typeof guidanceEvaluatorVerdict>;
};

export function useStageEvaluator(projectId: string, tenantId: string, stage: number, draftMessage: ChatMessage | null): StageEvaluator {
  const [evaluatorAddress, setEvaluatorAddress] = useState<string | null>(null);
  const [evaluatorSentFor, setEvaluatorSentFor] = useState<string | null>(null);
  const [evaluatorMessages, setEvaluatorMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    setEvaluatorAddress(null);
    setEvaluatorSentFor(null);
    setEvaluatorMessages([]);
  }, [projectId]);

  useEffect(() => {
    if (stage !== 1 || !draftMessage || draftMessage.id === evaluatorSentFor) return;
    let cancelled = false;
    const draftId = draftMessage.id;
    const draftBody = draftMessage.body;
    void api
      .ensureStage1EvaluatorAgent(projectId)
      .then((deployment) => {
        if (cancelled) return null;
        setEvaluatorAddress(deployment.address);
        return api.sendStageMail(tenantId, deployment.address, {
          body: draftBody,
          subject: "Stage 1 draft for review",
        });
      })
      .then(() => {
        if (!cancelled) setEvaluatorSentFor(draftId);
      })
      .catch(() => {
        // Silent: the evaluator is advisory, the stage works without it.
      });
    return () => {
      cancelled = true;
    };
  }, [stage, draftMessage, evaluatorSentFor, projectId, tenantId]);

  useEffect(() => {
    if (!evaluatorAddress) return;
    let cancelled = false;
    const poll = () => {
      void api
        .readStageThread(tenantId, [evaluatorAddress])
        .then((result) => {
          if (!cancelled) setEvaluatorMessages(result);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [evaluatorAddress, tenantId]);

  return { verdict: guidanceEvaluatorVerdict(evaluatorMessages) };
}

export type ProductGuideState = {
  readonly guide: Guidance;
  readonly asking: boolean;
  readonly ask: () => Promise<void>;
};

export function useProductGuide(
  projectId: string,
  projectTitle: string,
  tenantId: string,
  stage: number,
  nodes: readonly ArtifactNode[],
  workflowView: ProjectWorkflowView | null,
): ProductGuideState {
  const [guide, setGuide] = useState<Guidance>(() => deterministicGuidance(workflowView, stage, nodes));
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setGuide(deterministicGuidance(workflowView, stage, nodes));
  }, [workflowView, stage, nodes]);

  const ask = useCallback(async () => {
    if (asking) return;
    setAsking(true);
    const floor = deterministicGuidance(workflowView, stage, nodes);
    const prompt = guidancePrompt(workflowView, stage, projectTitle);
    const attempt = async (): Promise<Guidance | null> => {
      try {
        const guideDeployment = await api.ensureGuideAgent(projectId);
        const sentAt = Date.now();
        await api.sendStageMail(tenantId, guideDeployment.address, { body: prompt, subject: "Guidance request" });
        for (let tries = 0; tries < 8; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const thread = await api.readStageThread(tenantId, [guideDeployment.address]);
          const reply = [...thread]
            .reverse()
            .find((message) => message.author === "agent" && Date.parse(message.at) >= sentAt);
          if (reply) return parseGuidanceReply(reply.body, floor);
        }
        return null;
      } catch {
        return null;
      }
    };
    const result = (await attempt()) ?? (await attempt());
    setGuide(result ?? floor);
    setAsking(false);
  }, [asking, workflowView, stage, nodes, projectId, projectTitle, tenantId]);

  return { guide, asking, ask };
}

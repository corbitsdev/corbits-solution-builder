/**
 * What to do next, always.
 *
 * This product is a guided sequence, and the moment someone has to ask "what
 * now?" it has failed them. So every state a run can be in resolves to one
 * named next action here — including the states that are endings, which say
 * so plainly rather than leaving a screen that simply stops.
 *
 * Pure, and exhaustive over the ledger's states, so `smoke:guidance` can prove
 * there is no state that leaves a person without a next move.
 */
import type { RunState, Stage } from "./ledger.js";

export type NextStep = {
  /** The action, in the imperative. Short enough to be a button. */
  title: string;
  /** Why it is the next thing, in one sentence. */
  detail: string;
  /** Which surface it happens on. */
  where: "stage" | "artifacts" | "decisions" | "settings";
  /** An ending rather than an instruction: shown calmly, not as a prompt. */
  ending?: boolean;
};

export function nextStep(input: {
  state: RunState | null;
  stage: number;
  hasDraft: boolean;
  quorum?: { recorded: number; needed: number; blocked: number };
  /**
   * Whether the actor is the only person who could approve this stage.
   * Undefined is treated as "not solo" — the safer, more-steps default —
   * so a caller that has not resolved it yet never sees the collapsed,
   * self-approving wording by accident.
   */
  soloApproval?: boolean;
}): NextStep {
  const { state, stage, hasDraft, soloApproval } = input;

  if (state === null) {
    return {
      title: "Start a project",
      detail: "Describe a problem worth solving and the first specialist takes it from there.",
      where: "decisions",
    };
  }

  switch (state) {
    case "in_progress": {
      if (stage === 5 && input.quorum) {
        const { recorded, needed, blocked } = input.quorum;
        if (blocked > 0) {
          return {
            title: "Address the blocking decision",
            detail:
              "An audience asked for changes or rejected the package. Revise it, then ask them again.",
            where: "stage",
          };
        }
        if (recorded < needed) {
          return {
            title: `Record ${needed - recorded} more audience decision${needed - recorded === 1 ? "" : "s"}`,
            detail: `${recorded} of ${needed} audiences have decided. Approval unlocks when the quorum is met.`,
            where: "stage",
          };
        }
        return {
          title: "Submit this stage for approval",
          detail: "Every audience has agreed to proceed.",
          where: "stage",
        };
      }
      if (!hasDraft) {
        return {
          title: stage === 1 ? "Describe the problem" : "Draft this stage",
          detail:
            stage === 1
              ? "Say what hurts, in your own words. The specialist asks about the problem, not a solution."
              : "The approved work from earlier stages is already in hand.",
          where: "stage",
        };
      }
      // "Submit for approval" is a lie when the submitter and the approver
      // are the same person — nobody sends anything to anybody. Solo says so
      // plainly; only a real second approver earns the word "send".
      if (soloApproval) {
        return {
          title: stage === 7 ? "Approve the cost" : "Approve and continue",
          detail:
            "If something is wrong, say so in the conversation and a new version comes back. You hold the only approval this stage needs.",
          where: "stage",
        };
      }
      return {
        title: "Send for approval",
        detail:
          "If something is wrong, say so in the conversation and a new version comes back. If it is right, send it on for approval.",
        where: "stage",
      };
    }

    case "waiting_approval":
      return {
        title: "Approve or send back",
        detail: "This stage is waiting on a human decision before anything moves.",
        where: "decisions",
      };

    case "backtracked":
      return {
        title: "Resume at the earlier stage",
        detail: "The work was routed back. Nothing was deleted — the earlier versions are retained.",
        where: "stage",
      };

    case "cost_approved":
      return {
        title: "Freeze the build packet",
        detail: "The spend is approved. Freezing fixes exactly what the builder is allowed to use.",
        where: "stage",
      };

    case "approved_frozen":
      return {
        title: "Start the build",
        detail: "The packet is frozen and the builder can begin.",
        where: "stage",
      };

    case "queued":
      return {
        title: "Start the build attempt",
        detail: "Nothing runs until you say so.",
        where: "stage",
      };

    case "running":
      return {
        title: "Watch the build",
        detail: "The builder is working. You will be asked before anything material changes.",
        where: "stage",
      };

    case "waiting_human":
      return {
        title: "Answer the builder's question",
        detail: "The build is paused on a decision only you can make.",
        where: "decisions",
      };

    case "interrupted":
      return {
        title: "Resume or abandon the attempt",
        detail: "The build stopped part way. Its evidence so far is retained either way.",
        where: "stage",
      };

    case "evidence_accepted":
      return {
        title: "Review the delivery",
        detail: "The build's evidence was accepted. What it produced is ready to be judged.",
        where: "stage",
      };

    case "delivery_review":
      return {
        title: "Accept or reject the delivery",
        detail: "Read the manifest and decide whether this is the software you asked for.",
        where: "decisions",
      };

    case "delivered":
      return {
        title: "Delivered",
        detail: "This project is finished. Every version and decision along the way is retained.",
        where: "artifacts",
        ending: true,
      };

    case "failed":
      return {
        title: "Start again from the last good stage",
        detail: "This run failed. Nothing it produced was discarded — the earlier versions stand.",
        where: "artifacts",
        ending: true,
      };

    case "cancelled":
      return {
        title: "Cancelled",
        detail: "This run was stopped deliberately. Its artifacts are retained.",
        where: "artifacts",
        ending: true,
      };

    case "archived":
      return {
        title: "Archived",
        detail: "Kept for the record and out of the way. Nothing was deleted.",
        where: "artifacts",
        ending: true,
      };

    case "deleted":
      return {
        title: "Deleted",
        detail: "This project was removed at your request.",
        where: "artifacts",
        ending: true,
      };
  }
}

/**
 * "What is happening right now" — a status headline, not an instruction.
 *
 * `nextStep` answers "what should I do"; this answers "what is going on",
 * which is a different sentence for the same moment (compare its
 * `waiting_approval` title, "Approve it or send it back", to this one,
 * "Waiting for your approval"). The runtime executor is what makes this
 * possible at all: `parked` and `hasDraft` come from actually asking the
 * platform's own workflow run where it is, not from guessing at a state
 * string. Words only — no step id, no signal name, no enum value ever
 * reaches this function's return value.
 */
export function activityHeadline(input: {
  state: RunState;
  stage: Stage;
  /** Whether the stage's runtime run is currently parked at a signal gate. */
  parked: boolean;
  hasDraft: boolean;
  quorum?: { recorded: number; needed: number; blocked: number };
}): string {
  const { state, stage, parked, hasDraft, quorum } = input;

  if (state === "waiting_approval") {
    if (stage === 5 && quorum) {
      if (quorum.blocked > 0) return "An audience asked for changes";
      const remaining = quorum.needed - quorum.recorded;
      if (remaining > 0) {
        return `Waiting on ${remaining} more audience decision${remaining === 1 ? "" : "s"}`;
      }
      return "Waiting for your approval";
    }
    if (stage === 7) return "Waiting for you to approve the cost";
    return "Waiting for your approval";
  }

  if (state === "in_progress") {
    if (parked && hasDraft) return "Revising the draft";
    return "Drafting";
  }

  // Every other state already has a plain, person-facing title — reused
  // rather than restated, so there is exactly one place these words live.
  return nextStep({ state, stage, hasDraft: true, ...(quorum ? { quorum } : {}) }).title;
}

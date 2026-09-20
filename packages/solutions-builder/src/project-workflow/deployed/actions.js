// Deployed mirror of packages/solutions-builder/src/project-workflow/{contracts,actions}.ts,
// re-expressed as a self-contained plain-JS module: `interchange.actions` is
// imported by the sidecar directly, with no access to the rest of this
// workspace, so the reducer is duplicated here rather than imported.
//
// `initProject` reads its structured init payload out of the fired run's
// trigger content: at this platform pin every top-level run (regardless of
// its declared `trigger.type`) is fired through the mail-shaped trigger
// route (vendor/interchange/packages/hub-api/src/workflow-run-trigger.ts,
// vendor/interchange/packages/workflow-host/src/child/run-child.ts:1183-1193),
// so `trigger.payload` is a decoded `Mail` object, not an arbitrary caller
// JSON value. The proof script JSON-encodes the real init payload into the
// trigger's `content` string; this module reads it back off the resolved
// mail part's inline `text`.
//
// `applyDecision`'s `readArtifact` is bound to the SYNTHETIC fixture table
// below -- phase 2 isolates loop repetition and restart, not the artifact
// read path (that is out of scope; see the README).

const SYNTHETIC_ARTIFACT_FIXTURE = new Map([
  ["deployed-proof-project-stage-1-artifact@1", "stage 1 content (synthetic fixture)"],
  ["deployed-proof-project-stage-1-artifact@2", "stage 1 content, revised (synthetic fixture)"],
  ["deployed-proof-project-stage-2-artifact@1", "stage 2 content (synthetic fixture)"],
  ["deployed-proof-project-stage-2-artifact@2", "stage 2 content (synthetic fixture)"],
]);

async function readArtifact(artifactId, version) {
  const content = SYNTHETIC_ARTIFACT_FIXTURE.get(`${artifactId}@${version}`);
  return content === undefined ? null : { content };
}

async function contentSha256(content) {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDecisionShape(value) {
  if (!isRecord(value)) return null;
  if (
    typeof value.decisionId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.stage !== "number" || !Number.isInteger(value.stage) ||
    typeof value.reviewId !== "string" ||
    typeof value.artifactId !== "string" ||
    typeof value.version !== "number" || !Number.isInteger(value.version) ||
    typeof value.sha256 !== "string" ||
    (value.outcome !== "approve" && value.outcome !== "send_back")
  ) {
    return null;
  }
  if (value.outcome === "send_back") {
    if (typeof value.reason !== "string" || value.reason.length === 0) return null;
    if (typeof value.targetStage !== "number" || !Number.isInteger(value.targetStage)) return null;
  }
  return value;
}

function nextReviewId(stage, count) {
  return `stage-${stage}-review-${count}`;
}
function nextArtifactId(projectId, stage) {
  return `${projectId}-stage-${stage}-artifact`;
}

export async function initProject(input) {
  const part = isRecord(input) && Array.isArray(input.parts) ? input.parts.find((p) => typeof p?.text === "string") : undefined;
  if (!part) throw new Error("initProject requires the fired trigger content to carry the JSON init payload");
  const payload = JSON.parse(part.text);
  const firstStage = payload.stages[0];
  const authorizedPrincipals = {};
  for (const s of payload.stages) authorizedPrincipals[s.stage] = s.authorizedPrincipalIds;
  return {
    projectId: payload.projectId,
    stage: firstStage.stage,
    done: false,
    reviews: {
      [firstStage.stage]: {
        reviewId: payload.firstReview.reviewId,
        artifactId: payload.firstReview.artifactId,
        version: payload.firstReview.version,
        sha256: null,
        status: "open",
      },
    },
    decisions: [],
    authorizedPrincipals,
    stageOrder: payload.stages.map((s) => s.stage),
    reviewCounts: { [firstStage.stage]: 1 },
  };
}

export async function applyDecision(input) {
  const state = {
    projectId: input.projectId,
    stage: input.stage,
    done: input.done,
    reviews: input.reviews,
    decisions: input.decisions,
    authorizedPrincipals: input.authorizedPrincipals,
    stageOrder: input.stageOrder,
    reviewCounts: input.reviewCounts,
  };
  const principalId = typeof input.principalId === "string" ? input.principalId : null;
  const payload = validateDecisionShape(input.decision);
  if (payload === null || principalId === null) return state;
  if (state.decisions.some((d) => d.decisionId === payload.decisionId)) return state;

  const refused = (code) => ({
    ...state,
    decisions: [
      ...state.decisions,
      {
        decisionId: payload.decisionId,
        stage: payload.stage,
        outcome: payload.outcome,
        accepted: false,
        reason: code,
        principalId,
        ...(payload.targetStage !== undefined ? { targetStage: payload.targetStage } : {}),
      },
    ],
  });

  const authorized = state.authorizedPrincipals[state.stage] ?? [];
  if (!authorized.includes(principalId)) return refused("unauthorized");
  if (payload.projectId !== state.projectId) return refused("wrong_project");
  if (payload.stage !== state.stage) return refused("wrong_stage");
  const review = state.reviews[state.stage];
  if (!review || payload.reviewId !== review.reviewId) return refused("stale_review");
  if (payload.artifactId !== review.artifactId) return refused("wrong_artifact");
  if (payload.version !== review.version) return refused("stale_version");

  const artifact = await readArtifact(payload.artifactId, payload.version);
  if (artifact === null) return refused("artifact_unreadable");
  const actualSha256 = await contentSha256(artifact.content);
  if (actualSha256 !== payload.sha256) return refused("hash_mismatch");
  if (review.sha256 !== null && actualSha256 !== review.sha256) return refused("hash_mismatch");

  if (payload.outcome === "send_back") {
    const targetStage = payload.targetStage;
    if (targetStage > state.stage || !state.stageOrder.includes(targetStage)) return refused("invalid_target_stage");
    const reviews = { ...state.reviews };
    for (const [key, r] of Object.entries(reviews)) {
      if (Number(key) >= targetStage && r.status !== "stale") reviews[key] = { ...r, status: "stale" };
    }
    const count = (state.reviewCounts[targetStage] ?? 0) + 1;
    reviews[targetStage] = {
      reviewId: nextReviewId(targetStage, count),
      artifactId: nextArtifactId(state.projectId, targetStage),
      version: count,
      sha256: null,
      status: "open",
    };
    return {
      ...state,
      stage: targetStage,
      reviews,
      decisions: [
        ...state.decisions,
        { decisionId: payload.decisionId, stage: payload.stage, outcome: "send_back", accepted: true, reason: payload.reason, principalId, targetStage },
      ],
      reviewCounts: { ...state.reviewCounts, [targetStage]: count },
    };
  }

  const approvedReviews = { ...state.reviews, [state.stage]: { ...review, sha256: actualSha256, status: "approved" } };
  const record = { decisionId: payload.decisionId, stage: payload.stage, outcome: "approve", accepted: true, principalId };
  const currentIndex = state.stageOrder.indexOf(state.stage);
  const nextStage = state.stageOrder[currentIndex + 1];
  if (nextStage === undefined) {
    return { ...state, reviews: approvedReviews, decisions: [...state.decisions, record], done: true };
  }
  const count = (state.reviewCounts[nextStage] ?? 0) + 1;
  const reviews = {
    ...approvedReviews,
    [nextStage]: { reviewId: nextReviewId(nextStage, count), artifactId: nextArtifactId(state.projectId, nextStage), version: count, sha256: null, status: "open" },
  };
  return { ...state, stage: nextStage, reviews, decisions: [...state.decisions, record], reviewCounts: { ...state.reviewCounts, [nextStage]: count } };
}

/** Identity: parks the loop's carried state in a step output (see workflow.js). */
export async function holdState(input) {
  return input;
}

export async function recordExhausted(input) {
  return { exhausted: true, carry: input };
}

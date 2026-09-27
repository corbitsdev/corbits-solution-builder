import { describe, expect, test } from "bun:test";
import {
  approveStage,
  digestOf,
  ensureReviewOpen,
  packageRefOf,
  packageRefsOf,
  packagesEqual,
  recordAudienceVote,
  reviewableArtifact,
  sendBack,
  type StageApprovalDeps,
} from "./stage-approval.ts";
import type { ArtifactNode } from "./client.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";

function node(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return {
    id: "art_1",
    kind: "problem_statement",
    variant: null,
    stage: 1,
    title: "Draft",
    version: 1,
    artifactId: "art_1",
    contentHash: "art_1@1",
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent" },
    ...overrides,
  };
}

function view(overrides: Partial<ProjectWorkflowView> = {}): ProjectWorkflowView {
  return {
    stage: 1,
    done: false,
    openReview: null,
    reviews: {},
    decisions: [],
    lastRefusal: null,
    allowed: { openReview: true, approve: false, sendBack: true, approveReason: "no_open_review" },
    freeze: null,
    requirements: [],
    audiencePolicy: null,
    audienceDecisions: {},
    audiencePackages: {},
    stage5Quorum: null,
    generatedTitle: null,
    ...overrides,
  };
}

describe("reviewableArtifact", () => {
  const written = (overrides: Partial<ArtifactNode> = {}) =>
    node({ id: "a", stage: 6, version: 1, createdAt: "2026-09-24T10:00:00.000Z", provenance: { producer: "agent", agentRole: "architect" }, ...overrides });

  test("signals persist_needed when a draft is sitting unpersisted and no node carries a specialist's stamp", () => {
    const nodes = [node({ id: "a", version: 1 })];
    const result = reviewableArtifact({ nodes, stage: 1, kind: "problem_statement", latestDraft: { body: "draft" } });
    expect(result).toEqual({ status: "persist_needed" });
  });

  test("finds the persisted version when the chat draft is the one it was persisted from", () => {
    const result = reviewableArtifact({
      nodes: [written()],
      stage: 6,
      kind: "problem_statement",
      latestDraft: { body: "draft" },
      latestDraftAt: "2026-09-24T09:59:00.000Z",
    });
    expect(result).toEqual({ status: "found", node: written() });
  });

  test("a draft newer than the newest persisted version (after a send-back) is persisted, not the old version reviewed again", () => {
    const result = reviewableArtifact({
      nodes: [written()],
      stage: 6,
      kind: "problem_statement",
      latestDraft: { body: "re-issued plan" },
      latestDraftAt: "2026-09-24T10:55:00.000Z",
    });
    expect(result).toEqual({ status: "persist_needed" });
  });

  test("without a draft timestamp the persisted version is found as before (stage 8's archive, stage 5's packages)", () => {
    const result = reviewableArtifact({ nodes: [written({ stage: 8, kind: "build_archive" })], stage: 8, kind: "build_archive", latestDraft: { bundle: true }, latestDraftAt: null });
    expect(result).toMatchObject({ status: "found" });
  });

  test("signals none when there is no draft and nothing to review", () => {
    expect(reviewableArtifact({ nodes: [], stage: 1, kind: "problem_statement", latestDraft: null })).toEqual({ status: "none" });
  });
});

describe("digestOf", () => {
  test("uses the hub's own contentSha256 when present", async () => {
    expect(await digestOf("ignored", "abc123")).toBe("abc123");
  });

  test("computes sha256 hex over content otherwise", async () => {
    const digest = await digestOf("hello");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await digestOf("hello")).toBe(digest);
  });
});

function depsFor(views: ProjectWorkflowView[]): { deps: StageApprovalDeps; decisions: Record<string, unknown>[] } {
  const decisions: Record<string, unknown>[] = [];
  let viewCalls = 0;
  const deps: StageApprovalDeps = {
    view: async () => {
      const v = views[Math.min(viewCalls, views.length - 1)]!;
      viewCalls += 1;
      return v;
    },
    decide: async (_projectId, decision) => {
      decisions.push(decision);
      return { ok: true as const };
    },
    now: () => "2026-01-01T00:00:00.000Z",
  };
  return { deps, decisions };
}

describe("approveStage", () => {
  test("opens then approves when no review is open, and returns ok once the stage advances", async () => {
    const ref = { artifactId: "art_1", version: 1, sha256: "hash1" };
    const opened = view({ openReview: { reviewId: "stage-1-review-1", artifactId: ref.artifactId, version: ref.version, sha256: ref.sha256, status: "open" } });
    const advanced = view({ stage: 2 });
    // approveStage reads the view once, then ensureReviewOpen reads it again
    // before deciding to send open_review — the fixture needs both no-review reads.
    const { deps, decisions } = depsFor([view(), view(), opened, advanced]);
    const result = await approveStage(deps, { projectId: "p1", stage: 1, ref });
    expect(result).toEqual({ ok: true, stage: 2 });
    expect(decisions.map((d) => d["kind"])).toEqual(["open_review", "approve"]);
  });

  test("skips open_review when the exact review is already open", async () => {
    const ref = { artifactId: "art_1", version: 1, sha256: "hash1" };
    const opened = view({ openReview: { reviewId: "stage-1-review-1", artifactId: ref.artifactId, version: ref.version, sha256: ref.sha256, status: "open" } });
    const advanced = view({ stage: 2 });
    const { deps, decisions } = depsFor([opened, opened, advanced]);
    const result = await approveStage(deps, { projectId: "p1", stage: 1, ref });
    expect(result).toEqual({ ok: true, stage: 2 });
    expect(decisions.map((d) => d["kind"])).toEqual(["approve"]);
  });

  test("returns a refusal reason when our approve decision comes back refused", async () => {
    const ref = { artifactId: "art_1", version: 1, sha256: "hash1" };
    const opened = view({ openReview: { reviewId: "stage-1-review-1", artifactId: ref.artifactId, version: ref.version, sha256: ref.sha256, status: "open" } });
    let approveDecisionId: string | null = null;
    const deps: StageApprovalDeps = {
      view: async () => {
        if (approveDecisionId) {
          return view({
            openReview: opened.openReview,
            decisions: [{ decisionId: approveDecisionId, kind: "approve", stage: 1, accepted: false, reason: "stale_review", principalId: "p" }],
          });
        }
        return opened;
      },
      decide: async (_projectId, decision) => {
        if (decision["kind"] === "approve") approveDecisionId = decision["decisionId"] as string;
        return { ok: true as const };
      },
      now: () => "2026-01-01T00:00:00.000Z",
    };
    const result = await approveStage(deps, { projectId: "p1", stage: 1, ref });
    expect(result).toEqual({ ok: false, reason: "stale_review" });
  });

  test("returns wrong_stage when the view has already moved on", async () => {
    const { deps } = depsFor([view({ stage: 3 })]);
    const result = await approveStage(deps, { projectId: "p1", stage: 1, ref: { artifactId: "a", version: 1, sha256: "h" } });
    expect(result).toEqual({ ok: false, reason: "wrong_stage" });
  });

  test("waits for the review to actually apply before approving (opens only on the 3rd poll)", async () => {
    const ref = { artifactId: "art_1", version: 1, sha256: "hash1" };
    let calls = 0;
    const deps: StageApprovalDeps = {
      view: async () => {
        calls += 1;
        if (calls <= 3) return view();
        if (calls === 4) {
          return view({ openReview: { reviewId: "stage-1-review-1", artifactId: ref.artifactId, version: ref.version, sha256: ref.sha256, status: "open" } });
        }
        return view({ stage: 2 });
      },
      decide: async () => ({ ok: true as const }),
      now: () => "2026-01-01T00:00:00.000Z",
    };
    const result = await approveStage(deps, { projectId: "p1", stage: 1, ref });
    expect(result).toEqual({ ok: true, stage: 2 });
    expect(calls).toBeGreaterThanOrEqual(5);
  }, 10_000);

  test("returns immediately when the open_review decision itself is refused, and never sends approve", async () => {
    const ref = { artifactId: "art_1", version: 1, sha256: "hash1" };
    let openId: string | null = null;
    let approveSent = false;
    const deps: StageApprovalDeps = {
      view: async () => {
        if (openId) {
          return view({ decisions: [{ decisionId: openId, kind: "open_review", stage: 1, accepted: false, reason: "unauthorized", principalId: "p" }] });
        }
        return view();
      },
      decide: async (_projectId, decision) => {
        if (decision["kind"] === "open_review") openId = decision["decisionId"] as string;
        if (decision["kind"] === "approve") approveSent = true;
        return { ok: true as const };
      },
      now: () => "2026-01-01T00:00:00.000Z",
    };
    const result = await approveStage(deps, { projectId: "p1", stage: 1, ref });
    expect(result).toEqual({ ok: false, reason: "unauthorized" });
    expect(approveSent).toBe(false);
  });

  test("re-approving after a send-back round gets fresh decision ids (a later epoch)", async () => {
    const ref = { artifactId: "art_1", version: 1, sha256: "hash1" };
    const openReview = { reviewId: "stage-1-review-1", artifactId: ref.artifactId, version: ref.version, sha256: ref.sha256, status: "open" as const };

    const round1Ids: string[] = [];
    let round1Calls = 0;
    const deps1: StageApprovalDeps = {
      view: async () => {
        round1Calls += 1;
        return round1Calls <= 2 ? view({ decisions: [], openReview }) : view({ stage: 2 });
      },
      decide: async (_projectId, decision) => {
        round1Ids.push(decision["decisionId"] as string);
        return { ok: true as const };
      },
      now: () => "2026-01-01T00:00:00.000Z",
    };
    await approveStage(deps1, { projectId: "p1", stage: 1, ref });

    const round2Ids: string[] = [];
    let round2Calls = 0;
    const deps2: StageApprovalDeps = {
      view: async () => {
        round2Calls += 1;
        // After the send-back the old review is stale: both pre-decision reads
        // show no open review, the poll then sees the fresh review open, and
        // the approve poll sees the stage advance.
        const sentBack = { decisions: [{ decisionId: "d1", kind: "send_back" as const, stage: 1, accepted: true, principalId: "p" }] };
        if (round2Calls <= 2) return view(sentBack);
        if (round2Calls === 3) return view({ ...sentBack, openReview });
        return view({ stage: 2 });
      },
      decide: async (_projectId, decision) => {
        round2Ids.push(decision["decisionId"] as string);
        return { ok: true as const };
      },
      now: () => "2026-01-01T00:00:00.000Z",
    };
    await approveStage(deps2, { projectId: "p1", stage: 1, ref });

    expect(round2Ids).not.toEqual(round1Ids);
  });

  test("a retry against the same committed state re-derives identical decision ids", async () => {
    const ref = { artifactId: "art_1", version: 1, sha256: "hash1" };
    const openReview = { reviewId: "stage-1-review-1", artifactId: ref.artifactId, version: ref.version, sha256: ref.sha256, status: "open" as const };
    const ids: string[][] = [[], []];
    for (const i of [0, 1] as const) {
      let calls = 0;
      const deps: StageApprovalDeps = {
        view: async () => {
          calls += 1;
          return calls === 1 ? view({ decisions: [], openReview }) : view({ stage: 2 });
        },
        decide: async (_projectId, decision) => {
          ids[i]!.push(decision["decisionId"] as string);
          return { ok: true as const };
        },
        now: () => "2026-01-01T00:00:00.000Z",
      };
      await approveStage(deps, { projectId: "p1", stage: 1, ref });
    }
    expect(ids[0]).toEqual(ids[1]);
  });

  test("maps a decide() signal_id_conflict to a value result rather than throwing", async () => {
    const ref = { artifactId: "art_1", version: 1, sha256: "hash1" };
    const deps: StageApprovalDeps = {
      view: async () => view(),
      decide: async () => {
        throw { status: 409, code: "signal_id_conflict" };
      },
      now: () => "2026-01-01T00:00:00.000Z",
    };
    const result = await approveStage(deps, { projectId: "p1", stage: 1, ref });
    expect(result).toEqual({ ok: false, reason: "signal_id_conflict" });
  });

  test("rethrows a decide() failure that is not a signal_id_conflict", async () => {
    const ref = { artifactId: "art_1", version: 1, sha256: "hash1" };
    const deps: StageApprovalDeps = {
      view: async () => view(),
      decide: async () => {
        throw new Error("network down");
      },
      now: () => "2026-01-01T00:00:00.000Z",
    };
    await expect(approveStage(deps, { projectId: "p1", stage: 1, ref })).rejects.toThrow("network down");
  });
});

describe("sendBack", () => {
  test("sends a send_back decision and reports the resulting stage", async () => {
    const { deps, decisions } = depsFor([view({ stage: 2 })]);
    const result = await sendBack(deps, { projectId: "p1", stage: 3, targetStage: 2, reason: "needs rework" });
    expect(result).toEqual({ ok: true, stage: 2 });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: "send_back", targetStage: 2, reason: "needs rework" });
  });
});

describe("stakeholder packages on stage 5 (#50)", () => {
  const pkgNode = (variant: string, overrides: Partial<ArtifactNode> = {}) =>
    node({ id: `n_${variant}`, kind: "audience_package", stage: 5, variant, artifactId: `art_${variant}`, version: 2, contentSha256: `sha_${variant}`, ...overrides });

  test("packageRefOf names the artifact, its version and the hub's digest, computing one only when the hub has none", async () => {
    let reads = 0;
    const read = async (_nodeId: string) => {
      reads += 1;
      return "hello";
    };
    expect(await packageRefOf(pkgNode("alice"), read)).toEqual({ artifactId: "art_alice", version: 2, sha256: "sha_alice" });
    expect(reads).toBe(0);
    const computed = await packageRefOf(pkgNode("bob", { contentSha256: null }), read);
    expect(reads).toBe(1);
    expect(computed).toEqual({ artifactId: "art_bob", version: 2, sha256: await digestOf("hello") });
  });

  test("packageRefsOf keys each package by its stakeholder and skips a nameless one", async () => {
    const refs = await packageRefsOf([pkgNode("alice"), pkgNode("draft", { variant: null })], async () => "");
    expect(refs).toEqual({ alice: { artifactId: "art_alice", version: 2, sha256: "sha_alice" } });
  });

  test("packagesEqual compares by value, over the same stakeholders", () => {
    const alice = { artifactId: "art_alice", version: 2, sha256: "sha_alice" };
    expect(packagesEqual({ alice }, { alice: { ...alice } })).toBe(true);
    expect(packagesEqual({ alice }, { alice: { ...alice, version: 3 } })).toBe(false);
    expect(packagesEqual({ alice }, {})).toBe(false);
    expect(packagesEqual({}, { alice })).toBe(false);
  });

  test("ensureReviewOpen re-opens a review already open on the same ref when a stakeholder's package changed", async () => {
    const ref = { artifactId: "art_alice", version: 2, sha256: "sha_alice" };
    const policy = { quorum: 1, stakeholders: ["alice", "bob"] };
    const before = { alice: ref, bob: { artifactId: "art_bob", version: 1, sha256: "sha_bob_1" } };
    const after = { alice: ref, bob: { artifactId: "art_bob", version: 2, sha256: "sha_bob_2" } };
    const open = { reviewId: "stage-5-review-1", ...ref, status: "open" as const };
    const opened = view({ stage: 5, openReview: open, audiencePolicy: policy, audiencePackages: before });
    const { deps, decisions } = depsFor([opened, view({ stage: 5, openReview: { ...open, reviewId: "stage-5-review-2" }, audiencePolicy: policy, audiencePackages: after })]);
    const result = await ensureReviewOpen(deps, { projectId: "p1", stage: 5, ref, policy, packages: after });
    expect(result.ok).toBe(true);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: "open_review", stage: 5, policy, packages: after });
  });

  test("ensureReviewOpen leaves a review alone when the ref, the policy and the packages all match", async () => {
    const ref = { artifactId: "art_alice", version: 2, sha256: "sha_alice" };
    const policy = { quorum: 1, stakeholders: ["alice"] };
    const packages = { alice: ref };
    const opened = view({ stage: 5, openReview: { reviewId: "stage-5-review-1", ...ref, status: "open" }, audiencePolicy: policy, audiencePackages: packages });
    const { deps, decisions } = depsFor([opened]);
    const result = await ensureReviewOpen(deps, { projectId: "p1", stage: 5, ref, policy, packages: { alice: { ...ref } } });
    expect(result.ok).toBe(true);
    expect(decisions).toEqual([]);
  });

  test("recordAudienceVote sends the package the stakeholder decided on", async () => {
    const reviewed = { artifactId: "art_alice", version: 2, sha256: "sha_alice" };
    const decided = view({
      stage: 5,
      audienceDecisions: { alice: { audience: "alice", decision: "proceed", note: "", principalId: "p", at: "", decisionId: "dec-1", package: reviewed } },
    });
    const { deps, decisions } = depsFor([decided]);
    const result = await recordAudienceVote(deps, { projectId: "p1", stage: 5, audience: "alice", decision: "proceed", decisionId: "dec-1", package: reviewed });
    expect(result).toEqual({ ok: true });
    expect(decisions[0]).toMatchObject({ kind: "audience", audience: "alice", decision: "proceed", decisionId: "dec-1", ...reviewed });
  });
});

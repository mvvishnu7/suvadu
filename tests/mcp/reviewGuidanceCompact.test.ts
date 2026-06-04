import test from "node:test";
import assert from "node:assert/strict";
import { compactReviewGuidanceForMcp } from "../../src/mcp/server.js";
import type { ReviewGuidanceOutput } from "../../src/retrieval/contextBuilder.js";

test("compacts review guidance for MCP by default", () => {
  const output: ReviewGuidanceOutput = {
    summary: "Suvadu found historical review evidence for this diff.",
    confidence: "high",
    likelyReviewerConcerns: ["Validation and edge cases", "Public API behavior"],
    checklist: ["Keep calculate and skip flows explicit.", "Consider whether the behavior needs a flag or fallback."],
    riskyAssumptions: ["Skipped estimation does not mean duration is 0.", "The change is safe to release everywhere at once."],
    testsToAdd: [
      "Update or inspect likely related test: PaymentControllerIT.java",
      "Add tests for flag/fallback behavior where rollout safety depends on it.",
      "Add the missing unit or integration tests requested by similar historical reviews."
    ],
    evidence: [
      {
        type: "pull_request",
        id: "#32",
        repo: "payment-service",
        url: "https://example.test/pull/32",
        title: "feat: Skip impact estimation",
        reason: "PR title/body overlaps with the diff summary"
      },
      {
        type: "review_comment",
        id: "#32 comment 123",
        repo: "payment-service",
        path: "src/payment.ts",
        url: "https://example.test/pull/32#discussion_r123",
        title: "PR #32 review comment",
        reason: "Review comment overlaps with the diff summary"
      }
    ],
    unknowns: ["Jira comments are not indexed yet."]
  };

  const compact = compactReviewGuidanceForMcp(output, "Changed skip estimation validation") as Record<string, unknown>;
  assert.equal("likelyReviewerConcerns" in compact, false);
  assert.equal("checklist" in compact, false);
  assert.equal("riskyAssumptions" in compact, false);
  assert.equal("testsToAdd" in compact, false);
  assert.equal("evidence" in compact, false);

  const briefing = compact.briefing as {
    likelyConcerns: string[];
    riskyAssumptions: string[];
    checklist: string[];
    tests: string[];
    sources: string[];
  };
  assert.deepEqual(briefing.likelyConcerns, [
    "Validation and edge cases are reviewer-sensitive for this change.",
    "Endpoint and request-contract semantics are likely reviewer concerns for this change.",
    "Reviewers previously asked for focused tests around this path."
  ]);
  assert.deepEqual(briefing.riskyAssumptions, [
    "Happy-path requests may not cover omitted, null, zero, or boundary values."
  ]);
  assert.deepEqual(briefing.checklist, [
    "Cover boundary values and edge cases before merging.",
    "Keep endpoint and DTO semantics stable unless the diff intentionally changes the public contract.",
    "Keep calculate and skip flows explicit."
  ]);
  assert.deepEqual(briefing.tests, [
    "Add or verify validation edge-case tests for the changed behavior.",
    "Update or inspect likely related test: PaymentControllerIT.java"
  ]);
  assert.deepEqual(briefing.sources, ["#32 - feat: Skip impact estimation", "PR #32 review comment (src/payment.ts)"]);
});

test("prioritizes compact review sources by PR, Jira, then top review comments", () => {
  const output: ReviewGuidanceOutput = {
    summary: "Suvadu found historical review evidence for this diff.",
    confidence: "high",
    likelyReviewerConcerns: [],
    checklist: [],
    riskyAssumptions: [],
    testsToAdd: [],
    evidence: [
      {
        type: "review_comment",
        id: "#27 comment 1",
        repo: "payment-service",
        path: "src/main/java/example/JiraIssueResponse.java",
        title: "PR #27 review comment"
      },
      {
        type: "review_comment",
        id: "#32 comment 2",
        repo: "payment-service",
        path: "src/main/java/example/PaymentController.java",
        title: "PR #32 review comment"
      },
      {
        type: "review_comment",
        id: "#32 comment 3",
        repo: "payment-service",
        path: "src/main/java/example/PaymentValidator.java",
        title: "PR #32 review comment"
      },
      {
        type: "pull_request",
        id: "#9",
        repo: "payment-service",
        title: "feat(impact): page 2 impact calculation"
      },
      {
        type: "pull_request",
        id: "#32",
        repo: "payment-service",
        title: "feat: Skip impact estimation"
      },
      {
        type: "pull_request",
        id: "#11",
        repo: "payment-service",
        title: "feat(jira): add jira comment post functionality"
      },
      {
        type: "jira",
        id: "FEAT-202",
        repo: "payment-service",
        title: "Incident Impact Estimation to new Jira Cloud"
      },
      {
        type: "jira",
        id: "FEAT-101",
        repo: "payment-service",
        title: "Add skip-impact-estimation flow to the impact estimation tool"
      }
    ],
    unknowns: []
  };

  const compact = compactReviewGuidanceForMcp(
    output,
    "Changed skip estimation validation and Jira comment behavior in PaymentController"
  ) as { briefing: { sources: string[] } };

  assert.deepEqual(compact.briefing.sources, [
    "#11 - feat(jira): add jira comment post functionality",
    "#32 - feat: Skip impact estimation",
    "FEAT-101 - Add skip-impact-estimation flow to the impact estimation tool",
    "FEAT-202 - Incident Impact Estimation to new Jira Cloud",
    "PR #32 review comment (src/main/java/example/PaymentController.java)",
    "PR #32 review comment (src/main/java/example/PaymentValidator.java)"
  ]);
});

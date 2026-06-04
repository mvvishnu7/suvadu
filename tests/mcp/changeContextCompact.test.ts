import test from "node:test";
import assert from "node:assert/strict";
import { compactChangeContextForMcp } from "../../src/mcp/server.js";
import type { ChangeContextOutput } from "../../src/retrieval/contextBuilder.js";

test("compacts change context for MCP by default", () => {
  const output: ChangeContextOutput = {
    summary: "Suvadu found indexed memory for 1 file related to this task.",
    confidence: "medium",
    briefing: {
      why: ["Jira PAY-1: legacy clients still send this parameter."],
      risks: ["PaymentController is high risk in indexed history."],
      guidance: ["Keep request compatibility for legacy invoice clients."],
      tests: ["Update PaymentControllerIT."],
      sources: [
        {
          type: "jira",
          id: "PAY-1",
          repo: "payment-service",
          url: "https://example.atlassian.net/browse/PAY-1",
          title: "Preserve legacy invoice compatibility",
          reason: "Linked Jira ticket content matched the task"
        },
        {
          type: "review_comment",
          id: "#44 comment 456",
          repo: "payment-service",
          path: "src/payment.ts",
          url: "https://example.test/pull/44#discussion_r456",
          title: "PR #44 review comment",
          reason: "Review comment matched the task"
        }
      ]
    },
    relevantFileMemories: [
      {
        repoId: "repo:payment-service",
        repoName: "payment-service",
        filePath: "src/payment.ts",
        summary: "Payment controller.",
        riskLevel: "high",
        whyRisky: ["Touched often"],
        recentCommits: [],
        relatedJiraKeys: ["PAY-1"],
        coChangedFiles: [],
        likelyTests: [],
        guidance: [],
        warnings: [],
        historicalSignals: [],
        sourceReferences: [],
        updatedAt: "2026-04-30T00:00:00.000Z"
      }
    ],
    historicalReasons: [
      {
        claim: "Jira PAY-1 may explain this behavior.",
        confidence: "medium",
        evidence: []
      }
    ],
    beforeEditing: ["Read Jira PAY-1."],
    relatedFiles: ["src/payment.ts"],
    questionsToAsk: ["Should legacy clients stay compatible?"],
    unknowns: ["Jira comments are not indexed yet."]
  };

  const compact = compactChangeContextForMcp(output) as Record<string, unknown>;
  assert.equal("relevantFileMemories" in compact, false);
  assert.equal("historicalReasons" in compact, false);
  assert.equal("beforeEditing" in compact, false);
  assert.equal("questionsToAsk" in compact, false);
  assert.deepEqual(compact.relatedFiles, ["src/payment.ts"]);

  const briefing = compact.briefing as { sources: string[] };
  assert.deepEqual(briefing.sources, [
    "PAY-1 - Preserve legacy invoice compatibility",
    "PR #44 review comment (src/payment.ts)"
  ]);
});

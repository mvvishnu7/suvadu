import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewPatternMemory } from "../../src/indexing/reviewPatternGenerator.js";

test("builds review-pattern memory from high-signal review comments", () => {
  const memory = buildReviewPatternMemory({
    workspaceId: "workspace:test",
    repoId: "repo:payment-service",
    repoName: "payment-service",
    pullRequestNumber: 32,
    comment: {
      id: 123,
      pullRequestNumber: 32,
      body: "I think adding the skipping feature inside the current flow is fine; creating another flow for the same usecase is too much.",
      author: "reviewer",
      path: "src/payment.ts",
      jiraKeys: []
    },
    source: {
      type: "review_comment",
      id: "#32 comment 123",
      repo: "payment-service",
      path: "src/payment.ts"
    }
  });

  assert.ok(memory);
  assert.equal(memory.type, "review-pattern");
  assert.equal(memory.properties.category, "architecture-flow");
  assert.match(memory.summary, /separate flow/);
  assert.ok(memory.guidance.some((item) => item.includes("flow boundary")));
  assert.equal(memory.sourceReferences[0]?.id, "#32 comment 123");
});

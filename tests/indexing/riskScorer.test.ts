import test from "node:test";
import assert from "node:assert/strict";
import { scoreFileRisk } from "../../src/indexing/riskScorer.js";

test("scores high-attention domain paths", () => {
  const result = scoreFileRisk(
    { path: "src/payment/taxCalculator.ts", riskTerms: ["payment", "tax"] },
    {
      filePath: "src/payment/taxCalculator.ts",
      commitCount: 12,
      authors: new Set(["a", "b", "c"]),
      recentCommits: [],
      jiraKeys: new Set(["PAY-813"]),
      coChanged: new Map([
        ["src/payment/taxCalculator.test.ts", 3],
        ["src/payment/routes.ts", 2]
      ])
    }
  );
  assert.equal(result.riskLevel, "high");
  assert.ok(result.whyRisky.some((line) => line.includes("PAY-813")));
});

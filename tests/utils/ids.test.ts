import test from "node:test";
import assert from "node:assert/strict";
import { fileNodeId, relationshipId, repoId } from "../../src/utils/ids.js";

test("generates stable backend-neutral ids", () => {
  assert.equal(repoId("Payment Service"), "repo:payment-service");
  assert.equal(fileNodeId("Payment Service", "src/payment.ts"), "file:payment-service:src/payment.ts");
  assert.equal(relationshipId("TOUCHED", "a", "b"), relationshipId("TOUCHED", "a", "b"));
});

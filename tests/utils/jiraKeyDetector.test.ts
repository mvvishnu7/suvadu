import test from "node:test";
import assert from "node:assert/strict";
import { detectJiraKeys } from "../../src/utils/jiraKeyDetector.js";

test("detects Jira keys", () => {
  assert.deepEqual(detectJiraKeys("PAY-813 fix plus ABC2-99 follow-up"), ["ABC2-99", "PAY-813"]);
});

test("filters Jira keys by project", () => {
  assert.deepEqual(detectJiraKeys("PAY-813 fix plus ABC-99 follow-up", ["PAY"]), ["PAY-813"]);
});

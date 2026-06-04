import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { explainWhyCodeExists } from "../../src/retrieval/contextBuilder.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/SqliteMemoryStore.js";
import { jiraNodeId } from "../../src/utils/ids.js";
import { nowIso } from "../../src/utils/time.js";

test("matches camelCase symbol questions to spaced commit messages", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-camelcase-"));
  const store = new SqliteMemoryStore(path.join(dir, "suvadu.sqlite"));
  const now = nowIso();
  await store.upsertWorkspace({
    id: "workspace:test",
    name: "test",
    rootPath: dir,
    createdAt: now,
    updatedAt: now
  });
  await store.upsertRepository({
    id: "repo:payment-service",
    workspaceId: "workspace:test",
    name: "payment-service",
    path: "./payment-service",
    absolutePath: path.join(dir, "payment-service"),
    createdAt: now,
    updatedAt: now,
    indexStatus: "indexed"
  });
  await store.saveFileMemory({
    repoId: "repo:payment-service",
    repoName: "payment-service",
    filePath: "src/main/java/PaymentController.java",
    summary: "Controller with skipEstimation behavior.",
    riskLevel: "medium",
    whyRisky: ["Commit history references Jira key: FEAT-101"],
    recentCommits: [
      {
        hash: "7908e953",
        shortHash: "7908e953",
        message: "feat: Skip impact estimation, FEAT-101 (#32)",
        author: "Dev",
        date: now,
        changedFiles: ["src/main/java/PaymentController.java"],
        jiraKeys: ["FEAT-101"]
      },
      {
        hash: "ce548626",
        shortHash: "ce548626",
        message: "feat(jira): add Jira Cloud submission support, FEAT-202 (#62)",
        author: "Dev",
        date: now,
        changedFiles: ["src/main/java/PaymentController.java"],
        jiraKeys: ["FEAT-202"]
      }
    ],
    relatedJiraKeys: ["FEAT-101", "FEAT-202"],
    coChangedFiles: [],
    likelyTests: [],
    guidance: [],
    warnings: [],
    historicalSignals: [],
    sourceReferences: [],
    updatedAt: now
  });
  await store.upsertNode({
    id: jiraNodeId("FEAT-101"),
    type: "jira_ticket",
    workspaceId: "workspace:test",
    repoId: "repo:payment-service",
    key: "FEAT-101",
    title: "FEAT-101: Add skip-impact-estimation flow",
    body: "Allow users to skip the impact estimation calculation when it is not applicable.",
    properties: {
      fetchedFromJiraCloud: true
    },
    source: {
      type: "jira",
      id: "FEAT-101",
      repo: "payment-service",
      url: "https://example.atlassian.net/browse/FEAT-101"
    },
    createdAt: now,
    updatedAt: now
  });
  await store.upsertNode({
    id: jiraNodeId("FEAT-202"),
    type: "jira_ticket",
    workspaceId: "workspace:test",
    repoId: "repo:payment-service",
    key: "FEAT-202",
    title: "FEAT-202: Incident Impact Estimation to Jira Cloud",
    body: "Move incident impact estimation comments to Jira Cloud.",
    properties: {
      fetchedFromJiraCloud: true
    },
    source: {
      type: "jira",
      id: "FEAT-202",
      repo: "payment-service",
      url: "https://example.atlassian.net/browse/FEAT-202"
    },
    createdAt: now,
    updatedAt: now
  });

  const why = await explainWhyCodeExists(store, "workspace:test", {
    repo: "payment-service",
    filePath: "src/main/java/PaymentController.java",
    question: "Why does PaymentController have skipEstimation behavior?",
    symbol: "skipEstimation"
  });
  await store.close();

  assert.ok(why.answer.includes("7908e953"));
  assert.ok(why.answer.includes("FEAT-101"));
  assert.equal(why.evidence[0]?.id, "FEAT-101");
  assert.ok(why.evidence[0]?.title?.includes("skip-impact-estimation"));
});

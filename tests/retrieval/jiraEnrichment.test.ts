import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { explainWhyCodeExists, getChangeContext } from "../../src/retrieval/contextBuilder.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/SqliteMemoryStore.js";
import { jiraNodeId } from "../../src/utils/ids.js";
import { nowIso } from "../../src/utils/time.js";

test("uses fetched Jira ticket content as why-evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-jira-retrieval-"));
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
    filePath: "src/routes/payment.ts",
    summary: "Endpoint file for payment creation.",
    riskLevel: "medium",
    whyRisky: ["Commit history references Jira key: PAY-813"],
    recentCommits: [
      {
        hash: "abc123",
        shortHash: "abc123",
        message: "PAY-813 add includeLegacyFees for legacy invoice clients",
        author: "Dev",
        date: now,
        changedFiles: ["src/routes/payment.ts"],
        jiraKeys: ["PAY-813"]
      }
    ],
    relatedJiraKeys: ["PAY-813"],
    coChangedFiles: [],
    likelyTests: ["tests/payment.test.ts"],
    guidance: ["Use Jira key PAY-813 as a historical breadcrumb."],
    warnings: [],
    historicalSignals: ["Recent history links this file to PAY-813 via commit abc123."],
    sourceReferences: [],
    updatedAt: now
  });
  await store.upsertNode({
    id: jiraNodeId("PAY-813"),
    type: "jira_ticket",
    workspaceId: "workspace:test",
    repoId: "repo:payment-service",
    key: "PAY-813",
    title: "PAY-813: Preserve legacy invoice fee compatibility",
    body: "Older invoice clients still send includeLegacyFees during payment creation.",
    properties: {
      fetchedFromJiraCloud: true,
      status: "Done",
      issueType: "Story"
    },
    source: {
      type: "jira",
      id: "PAY-813",
      repo: "payment-service",
      url: "https://example.atlassian.net/browse/PAY-813",
      title: "Preserve legacy invoice fee compatibility"
    },
    createdAt: now,
    updatedAt: now
  });

  const why = await explainWhyCodeExists(store, "workspace:test", {
    repo: "payment-service",
    filePath: "src/routes/payment.ts",
    question: "Why does this endpoint have includeLegacyFees?",
    symbol: "createPayment"
  });
  const context = await getChangeContext(store, "workspace:test", {
    repo: "payment-service",
    task: "Remove includeLegacyFees from payment creation",
    files: ["src/routes/payment.ts"]
  });
  await store.close();

  assert.equal(why.confidence, "high");
  assert.ok(why.answer.includes("PAY-813"));
  assert.ok(why.evidence.some((item) => item.type === "jira" && item.url?.includes("PAY-813")));
  assert.ok(why.reasoning.some((line) => line.includes("Older invoice clients")));
  assert.ok(context.beforeEditing.some((item) => item.includes("PAY-813")));
  assert.ok(context.briefing.why.some((item) => item.includes("PAY-813") && item.includes("Older invoice clients")));
  assert.ok(context.briefing.sources.some((item) => item.type === "jira" && item.id === "PAY-813"));
});

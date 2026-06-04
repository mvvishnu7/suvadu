import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { explainWhyCodeExists, getChangeContext, getReviewGuidance } from "../../src/retrieval/contextBuilder.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/SqliteMemoryStore.js";
import { fileNodeId, jiraNodeId, memoryId, pullRequestNodeId, relationshipId, reviewCommentNodeId } from "../../src/utils/ids.js";
import { nowIso } from "../../src/utils/time.js";

test("uses GitHub PR title and body as explain evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-pr-retrieval-"));
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
    filePath: "src/payment.ts",
    summary: "Payment endpoint.",
    riskLevel: "medium",
    whyRisky: ["Commit history references Jira key: PAY-813"],
    recentCommits: [
      {
        hash: "abc123",
        shortHash: "abc123",
        message: "PAY-813 add includeLegacyFees",
        author: "Dev",
        date: now,
        changedFiles: ["src/payment.ts"],
        jiraKeys: ["PAY-813"]
      }
    ],
    relatedJiraKeys: ["PAY-813"],
    coChangedFiles: [],
    likelyTests: [],
    guidance: [],
    warnings: [],
    historicalSignals: [],
    sourceReferences: [],
    updatedAt: now
  });
  await store.upsertNode({
    id: pullRequestNodeId("payment-service", 32),
    type: "pull_request",
    workspaceId: "workspace:test",
    repoId: "repo:payment-service",
    key: "32",
    title: "#32: Preserve legacy fee parameter",
    body: "Keep includeLegacyFees because invoice clients still send it.",
    properties: {
      number: 32,
      changedFiles: ["src/payment.ts"],
      jiraKeys: ["PAY-813"],
      mergedAt: now
    },
    source: {
      type: "pull_request",
      id: "#32",
      repo: "payment-service",
      url: "https://github.com/acme/payment-service/pull/32",
      title: "Preserve legacy fee parameter"
    },
    createdAt: now,
    updatedAt: now
  });
  await store.upsertRelationship({
    id: relationshipId("TOUCHED", pullRequestNodeId("payment-service", 32), fileNodeId("payment-service", "src/payment.ts")),
    type: "TOUCHED",
    fromNodeId: pullRequestNodeId("payment-service", 32),
    toNodeId: fileNodeId("payment-service", "src/payment.ts"),
    workspaceId: "workspace:test",
    repoId: "repo:payment-service",
    confidence: 1,
    evidence: [],
    properties: {},
    createdAt: now
  });

  const why = await explainWhyCodeExists(store, "workspace:test", {
    repo: "payment-service",
    filePath: "src/payment.ts",
    question: "Why does includeLegacyFees exist?",
    symbol: "includeLegacyFees"
  });
  await store.close();

  assert.ok(why.answer.includes("PR #32"));
  assert.ok(why.evidence.some((item) => item.type === "pull_request" && item.id === "#32"));
  assert.ok(why.reasoning.some((line) => line.includes("invoice clients still send it")));
});

test("uses GitHub review comments as explain evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-review-comment-retrieval-"));
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
    filePath: "src/payment.ts",
    summary: "Payment endpoint.",
    riskLevel: "medium",
    whyRisky: [],
    recentCommits: [],
    relatedJiraKeys: [],
    coChangedFiles: [],
    likelyTests: [],
    guidance: [],
    warnings: [],
    historicalSignals: [],
    sourceReferences: [],
    updatedAt: now
  });
  await saveReviewCommentApplyingToFile(store, now, {
    repo: "payment-service",
    pullRequestNumber: 32,
    id: 123,
    body: "Keep includeLegacyFees because invoice clients still send it.",
    path: "src/payment.ts"
  });

  const why = await explainWhyCodeExists(store, "workspace:test", {
    repo: "payment-service",
    filePath: "src/payment.ts",
    question: "Why does includeLegacyFees exist?",
    symbol: "includeLegacyFees"
  });
  await store.close();

  assert.ok(why.answer.includes("review comment on PR #32"));
  assert.ok(why.evidence.some((item) => item.type === "review_comment" && item.id === "#32 comment 123"));
  assert.ok(why.reasoning.some((line) => line.includes("invoice clients still send it")));
  assert.ok(why.guidance.some((line) => line.includes("Review note from PR #32")));
});

test("uses GitHub review comments in change context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-review-comment-context-"));
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
    filePath: "src/payment.ts",
    summary: "Payment endpoint.",
    riskLevel: "medium",
    whyRisky: [],
    recentCommits: [],
    relatedJiraKeys: [],
    coChangedFiles: [],
    likelyTests: [],
    guidance: [],
    warnings: [],
    historicalSignals: [],
    sourceReferences: [],
    updatedAt: now
  });
  await saveReviewCommentApplyingToFile(store, now, {
    repo: "payment-service",
    pullRequestNumber: 44,
    id: 456,
    body: "Please add VAT rounding edge case tests before changing this calculation.",
    path: "src/payment.ts"
  });

  const context = await getChangeContext(store, "workspace:test", {
    repo: "payment-service",
    task: "Change VAT rounding in payment calculation",
    files: ["src/payment.ts"]
  });
  await store.close();

  assert.ok(context.historicalReasons.some((item) => item.claim.includes("testing coverage")));
  assert.ok(context.beforeEditing.some((item) => item.includes("rounding or tax behavior") && item.includes("PR #44")));
  assert.ok(context.briefing.risks.some((item) => item.includes("PR #44 review note")));
  assert.ok(context.briefing.tests.some((item) => item.includes("rounding/tax edge-case tests")));
  assert.ok(context.briefing.sources.some((item) => item.type === "review_comment" && item.id === "#44 comment 456"));
});

test("builds review guidance from historical review comments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-review-guidance-"));
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
    filePath: "src/payment.ts",
    summary: "Payment calculation.",
    riskLevel: "high",
    whyRisky: ["High-attention path term: payment"],
    recentCommits: [],
    relatedJiraKeys: [],
    coChangedFiles: [],
    likelyTests: ["tests/payment.test.ts"],
    guidance: [],
    warnings: [],
    historicalSignals: [],
    sourceReferences: [],
    updatedAt: now
  });
  await saveReviewCommentApplyingToFile(store, now, {
    repo: "payment-service",
    pullRequestNumber: 44,
    id: 456,
    body: "Please add VAT rounding edge case tests before changing this calculation.",
    path: "src/payment.ts"
  });

  const guidance = await getReviewGuidance(store, "workspace:test", {
    repo: "payment-service",
    diffSummary: "Changed VAT rounding in payment calculation",
    files: ["src/payment.ts"]
  });
  await store.close();

  assert.equal(guidance.confidence, "medium");
  assert.ok(guidance.likelyReviewerConcerns.some((item) => item.includes("Validation and edge cases")));
  assert.ok(guidance.checklist.some((item) => item.includes("rounding or tax behavior")));
  assert.ok(guidance.testsToAdd.some((item) => item.includes("rounding/tax edge-case tests")));
  assert.ok(!guidance.testsToAdd.some((item) => item.includes("Please add VAT")));
  assert.ok(guidance.evidence.some((item) => item.type === "review_comment" && item.id === "#44 comment 456"));
});

test("review guidance prefers review-pattern memories over raw comment chunks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-review-pattern-guidance-"));
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
    filePath: "src/payment.ts",
    summary: "Payment calculation.",
    riskLevel: "medium",
    whyRisky: [],
    recentCommits: [],
    relatedJiraKeys: [],
    coChangedFiles: [],
    likelyTests: [],
    guidance: [],
    warnings: [],
    historicalSignals: [],
    sourceReferences: [],
    updatedAt: now
  });
  await saveReviewCommentApplyingToFile(store, now, {
    repo: "payment-service",
    pullRequestNumber: 32,
    id: 123,
    body: "I think adding the skipping feature inside the current flow is fine; creating another flow for the same usecase is too much.",
    path: "src/payment.ts"
  });
  await store.upsertMemory({
    id: memoryId("review-pattern", "payment-service", "architecture-flow", "32", "123"),
    type: "review-pattern",
    workspaceId: "workspace:test",
    repoIds: ["repo:payment-service"],
    title: "Reviewers debated whether this behavior belongs in a separate flow",
    summary: "Past review discussion asked whether the behavior should be split into a separate flow or kept inside the existing use case.",
    guidance: [
      "Make the flow boundary explicit before changing this behavior.",
      "If you add a separate endpoint or use case, explain why it is worth the extra flow."
    ],
    confidence: 0.72,
    sourceReferences: [
      {
        type: "review_comment",
        id: "#32 comment 123",
        repo: "payment-service",
        path: "src/payment.ts",
        url: "https://github.com/acme/payment-service/pull/32#discussion_r123"
      }
    ],
    properties: {
      category: "architecture-flow",
      filePath: "src/payment.ts",
      excerpt: "raw comment"
    },
    createdAt: now,
    updatedAt: now
  });

  const guidance = await getReviewGuidance(store, "workspace:test", {
    repo: "payment-service",
    diffSummary: "Changed skip estimation flow",
    files: ["src/payment.ts"]
  });
  await store.close();

  assert.ok(guidance.likelyReviewerConcerns.some((item) => item.includes("split into a separate flow")));
  assert.ok(guidance.checklist.some((item) => item.includes("flow boundary")));
  assert.ok(!guidance.likelyReviewerConcerns.some((item) => item.startsWith("PR #32 review pattern")));
  assert.ok(guidance.evidence.some((item) => item.reason?.includes("Supports review pattern")));
});

async function saveReviewCommentApplyingToFile(
  store: SqliteMemoryStore,
  now: string,
  input: { repo: string; pullRequestNumber: number; id: number; body: string; path: string }
): Promise<void> {
  const nodeId = reviewCommentNodeId(input.repo, input.pullRequestNumber, input.id);
  await store.upsertNode({
    id: nodeId,
    type: "review_comment",
    workspaceId: "workspace:test",
    repoId: `repo:${input.repo}`,
    key: `${input.pullRequestNumber}:${input.id}`,
    title: `PR #${input.pullRequestNumber} review comment on ${input.path}`,
    body: input.body,
    properties: {
      id: input.id,
      pullRequestNumber: input.pullRequestNumber,
      author: "reviewer",
      path: input.path,
      jiraKeys: []
    },
    source: {
      type: "review_comment",
      id: `#${input.pullRequestNumber} comment ${input.id}`,
      repo: input.repo,
      path: input.path,
      url: `https://github.com/acme/${input.repo}/pull/${input.pullRequestNumber}#discussion_r${input.id}`,
      title: `PR #${input.pullRequestNumber} review comment`
    },
    createdAt: now,
    updatedAt: now
  });
  await store.upsertRelationship({
    id: relationshipId("APPLIES_TO", nodeId, fileNodeId(input.repo, input.path)),
    type: "APPLIES_TO",
    fromNodeId: nodeId,
    toNodeId: fileNodeId(input.repo, input.path),
    workspaceId: "workspace:test",
    repoId: `repo:${input.repo}`,
    confidence: 0.9,
    evidence: [],
    properties: {},
    createdAt: now
  });
}

test("explain why keeps weak broad PR and Jira matches out of the main answer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-pr-noise-"));
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
    filePath: "src/PaymentController.java",
    summary: "Incident impact controller.",
    riskLevel: "medium",
    whyRisky: ["Commit history references Jira key: FEAT-101"],
    recentCommits: [
      {
        hash: "7908e953666780aa284956e248d0805c61b6cdcf",
        shortHash: "7908e953",
        message: "feat: Skip impact estimation, FEAT-101 (#32)",
        author: "Dev",
        date: now,
        changedFiles: ["src/PaymentController.java"],
        jiraKeys: ["FEAT-101"]
      }
    ],
    relatedJiraKeys: ["FEAT-101"],
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
    body: "Allow users to intentionally skip the calculation step when impact estimation is not applicable.",
    properties: { fetchedFromJiraCloud: true },
    source: { type: "jira", id: "FEAT-101", repo: "payment-service" },
    createdAt: now,
    updatedAt: now
  });
  await store.upsertNode({
    id: jiraNodeId("INFRA-303"),
    type: "jira_ticket",
    workspaceId: "workspace:test",
    repoId: "repo:payment-service",
    key: "INFRA-303",
    title: "INFRA-303: Add database connection pooling",
    body: "Configure connection pool size, timeout, and retry settings for the database layer.",
    properties: { fetchedFromJiraCloud: false },
    source: { type: "jira", id: "INFRA-303", repo: "payment-service" },
    createdAt: now,
    updatedAt: now
  });
  await savePullRequestTouchingFile(store, now, {
    repo: "payment-service",
    number: 32,
    title: "#32: feat: Skip impact estimation, FEAT-101",
    body: "Added a button to skip estimation.\n<img width=\"421\" alt=\"image\" src=\"https://example.test/image.png\" />",
    jiraKeys: ["FEAT-101"]
  });
  await savePullRequestTouchingFile(store, now, {
    repo: "payment-service",
    number: 25,
    title: "#25: feat: add connection pool config, INFRA-303",
    body: "Add connection pool configuration and tune max connections.",
    jiraKeys: ["INFRA-303"]
  });

  const why = await explainWhyCodeExists(store, "workspace:test", {
    repo: "payment-service",
    filePath: "src/PaymentController.java",
    question: "Why does PaymentController have skipEstimation?",
    symbol: "skipEstimation"
  });
  await store.close();

  assert.equal(why.confidence, "high");
  assert.ok(why.answer.includes("FEAT-101"));
  assert.ok(why.answer.includes("PR #32"));
  assert.ok(why.evidence.some((item) => item.type === "jira" && item.id === "FEAT-101"));
  assert.ok(why.evidence.some((item) => item.type === "pull_request" && item.id === "#32"));
  assert.ok(!why.evidence.some((item) => item.id === "INFRA-303"));
  assert.ok(!why.evidence.some((item) => item.id === "#25"));
  assert.ok(!why.reasoning.join("\n").includes("<img"));
});

async function savePullRequestTouchingFile(
  store: SqliteMemoryStore,
  now: string,
  input: { repo: string; number: number; title: string; body: string; jiraKeys: string[] }
): Promise<void> {
  await store.upsertNode({
    id: pullRequestNodeId(input.repo, input.number),
    type: "pull_request",
    workspaceId: "workspace:test",
    repoId: `repo:${input.repo}`,
    key: String(input.number),
    title: input.title,
    body: input.body,
    properties: {
      number: input.number,
      changedFiles: ["src/PaymentController.java"],
      jiraKeys: input.jiraKeys,
      mergedAt: now
    },
    source: {
      type: "pull_request",
      id: `#${input.number}`,
      repo: input.repo,
      title: input.title
    },
    createdAt: now,
    updatedAt: now
  });
  await store.upsertRelationship({
    id: relationshipId("TOUCHED", pullRequestNodeId(input.repo, input.number), fileNodeId(input.repo, "src/PaymentController.java")),
    type: "TOUCHED",
    fromNodeId: pullRequestNodeId(input.repo, input.number),
    toNodeId: fileNodeId(input.repo, "src/PaymentController.java"),
    workspaceId: "workspace:test",
    repoId: `repo:${input.repo}`,
    confidence: 1,
    evidence: [],
    properties: {},
    createdAt: now
  });
}

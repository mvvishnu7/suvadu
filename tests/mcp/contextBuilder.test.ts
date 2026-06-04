import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { getFileMemoryOutput } from "../../src/retrieval/contextBuilder.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/SqliteMemoryStore.js";
import { nowIso } from "../../src/utils/time.js";

test("get_file_memory reports missing indexed file honestly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-context-"));
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
    id: "repo:test",
    workspaceId: "workspace:test",
    name: "test",
    path: "./repo",
    absolutePath: path.join(dir, "repo"),
    createdAt: now,
    updatedAt: now,
    indexStatus: "unindexed"
  });
  const output = await getFileMemoryOutput(store, "workspace:test", {
    repo: "test",
    filePath: "src/missing.ts"
  });
  await store.close();
  assert.equal("indexed" in output ? output.indexed : true, false);
});

test("get_file_memory returns a compact agent-facing view", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-context-compact-"));
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
    id: "repo:test",
    workspaceId: "workspace:test",
    name: "test",
    path: "./repo",
    absolutePath: path.join(dir, "repo"),
    createdAt: now,
    updatedAt: now,
    indexStatus: "indexed"
  });
  await store.saveFileMemory({
    repoId: "repo:test",
    repoName: "test",
    filePath: "src/controller.ts",
    summary: "Controller file.",
    riskLevel: "high",
    whyRisky: ["a", "b", "c", "d", "e"],
    recentCommits: Array.from({ length: 5 }, (_, index) => ({
      hash: `hash-${index}`,
      shortHash: `h${index}`,
      message: `commit ${index}`,
      author: "Dev",
      date: now,
      changedFiles: ["src/controller.ts", "src/other.ts"],
      jiraKeys: [`KEY-${index}`]
    })),
    relatedJiraKeys: Array.from({ length: 10 }, (_, index) => `KEY-${index}`),
    coChangedFiles: Array.from({ length: 7 }, (_, index) => ({
      path: `src/related-${index}.ts`,
      count: index + 1,
      reason: `Changed together ${index}`
    })),
    likelyTests: Array.from({ length: 7 }, (_, index) => `tests/controller-${index}.test.ts`),
    guidance: Array.from({ length: 7 }, (_, index) => `guidance ${index}`),
    warnings: ["warning 1", "warning 2", "warning 3", "warning 4"],
    historicalSignals: ["signal 1", "signal 2", "signal 3", "signal 4"],
    sourceReferences: [
      { type: "file", id: "src/controller.ts", repo: "test", path: "src/controller.ts" },
      { type: "file", id: "src/controller.ts", repo: "test", path: "src/controller.ts" },
      { type: "commit", id: "hash-1", repo: "test", title: "commit 1" }
    ],
    updatedAt: now
  });

  const output = await getFileMemoryOutput(store, "workspace:test", {
    repo: "test",
    filePath: "src/controller.ts"
  });
  await store.close();

  assert.equal("indexed" in output ? output.indexed : true, true);
  if ("indexed" in output) {
    assert.fail("expected indexed file memory");
  }
  assert.equal(output.whyRisky.length, 4);
  assert.equal(output.recentCommits.length, 3);
  assert.equal(output.recentCommits[0]?.changedFiles, undefined);
  assert.equal(output.coChangedFiles.length, 5);
  assert.equal(output.likelyTests.length, 5);
  assert.equal(output.warnings.length, 3);
  assert.equal(output.sourceReferences.length, 2);
});

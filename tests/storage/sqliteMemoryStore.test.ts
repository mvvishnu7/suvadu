import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { SqliteMemoryStore } from "../../src/storage/sqlite/SqliteMemoryStore.js";
import { nowIso } from "../../src/utils/time.js";

test("stores and reads file memory through MemoryStore", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suvadu-store-"));
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
  await store.saveFileMemory({
    repoId: "repo:test",
    repoName: "test",
    filePath: "src/index.ts",
    summary: "TypeScript file at src/index.ts.",
    riskLevel: "low",
    whyRisky: ["No strong risk signals found in indexed local history yet"],
    recentCommits: [],
    relatedJiraKeys: [],
    coChangedFiles: [],
    likelyTests: [],
    guidance: ["No strong historical guidance yet."],
    warnings: [],
    historicalSignals: [],
    sourceReferences: [],
    updatedAt: now
  });
  const memory = await store.getFileMemory("repo:test", "src/index.ts");
  await store.close();
  assert.equal(memory?.summary, "TypeScript file at src/index.ts.");
});

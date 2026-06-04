import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { indexRepository } from "../../src/indexing/repoIndexer.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/SqliteMemoryStore.js";
import type { Repository, Workspace } from "../../src/domain/types.js";
import { nowIso } from "../../src/utils/time.js";

const execFileAsync = promisify(execFile);

test("full re-index rebuilds repo memory without duplicating graph data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suvadu-reindex-"));
  const repoPath = path.join(root, "payment-service");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "suvadu@example.com"]);
  await git(repoPath, ["config", "user.name", "Suvadu Test"]);
  await writeFile(
    path.join(repoPath, "src/payment.ts"),
    `export function createPayment(amount: number) {
  return { amount };
}
`,
    "utf8"
  );
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "PAY-813 add payment endpoint"]);

  const now = nowIso();
  const workspace: Workspace = {
    id: "workspace:test",
    name: "test",
    rootPath: root,
    createdAt: now,
    updatedAt: now
  };
  const repository: Repository = {
    id: "repo:payment-service",
    workspaceId: workspace.id,
    name: "payment-service",
    path: "./payment-service",
    absolutePath: repoPath,
    createdAt: now,
    updatedAt: now,
    indexStatus: "unindexed"
  };
  const store = new SqliteMemoryStore(path.join(root, ".suvadu", "suvadu.sqlite"));
  await store.upsertWorkspace(workspace);
  await store.upsertRepository(repository);

  await indexRepository(store, repository, { maxCommits: 20 });
  const first = await counts(store, workspace.id, repository.id);

  await indexRepository(store, repository, { maxCommits: 20 });
  const second = await counts(store, workspace.id, repository.id);
  await store.close();

  assert.deepEqual(second, first);
});

async function counts(store: SqliteMemoryStore, workspaceId: string, repoId: string): Promise<Record<string, number>> {
  return {
    files: (await store.findNodes({ workspaceId, repoId, type: "file", limit: 1000 })).length,
    commits: (await store.findNodes({ workspaceId, repoId, type: "commit", limit: 1000 })).length,
    jiraTickets: (await store.findNodes({ workspaceId, repoId, type: "jira_ticket", limit: 1000 })).length,
    touched: (await store.findRelationships({ workspaceId, repoId, type: "TOUCHED", limit: 1000 })).length,
    mentions: (await store.findRelationships({ workspaceId, repoId, type: "MENTIONS", limit: 1000 })).length,
    fileMemories: (await store.listFileMemories(repoId)).length
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

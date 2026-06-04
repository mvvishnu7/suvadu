import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { indexRepository } from "../../src/indexing/repoIndexer.js";
import { explainWhyCodeExists, getChangeContext } from "../../src/retrieval/contextBuilder.js";
import { SqliteMemoryStore } from "../../src/storage/sqlite/SqliteMemoryStore.js";
import type { Repository, Workspace } from "../../src/domain/types.js";
import { nowIso } from "../../src/utils/time.js";

const execFileAsync = promisify(execFile);

test("explains a parameter from local git history evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suvadu-why-"));
  const repoPath = path.join(root, "payment-service");
  await mkdir(path.join(repoPath, "src/routes"), { recursive: true });
  await mkdir(path.join(repoPath, "tests"), { recursive: true });

  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "suvadu@example.com"]);
  await git(repoPath, ["config", "user.name", "Suvadu Test"]);

  await writeFile(
    path.join(repoPath, "src/routes/payment.ts"),
    `export function createPayment(amount: number) {
  return { amount };
}
`,
    "utf8"
  );
  await writeFile(
    path.join(repoPath, "tests/payment.test.ts"),
    `import { createPayment } from "../src/routes/payment";

createPayment(10);
`,
    "utf8"
  );
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "Initial payment endpoint"]);

  await writeFile(
    path.join(repoPath, "src/routes/payment.ts"),
    `export function createPayment(amount: number, includeLegacyFees = false) {
  return { amount, includeLegacyFees };
}
`,
    "utf8"
  );
  await writeFile(
    path.join(repoPath, "tests/payment.test.ts"),
    `import { createPayment } from "../src/routes/payment";

createPayment(10, true);
`,
    "utf8"
  );
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "PAY-813 add includeLegacyFees for legacy invoice clients"]);

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

  const why = await explainWhyCodeExists(store, workspace.id, {
    repo: "payment-service",
    filePath: "src/routes/payment.ts",
    question: "Why does this endpoint have includeLegacyFees for invoice compatibility?",
    symbol: "createPayment"
  });

  assert.equal(why.confidence, "medium");
  assert.ok(why.answer.includes("PAY-813") || why.reasoning.some((line) => line.includes("PAY-813")));
  assert.ok(why.evidence.some((item) => item.type === "commit" && item.title?.includes("includeLegacyFees")));
  assert.deepEqual(why.relatedContext.jiraKeys, ["PAY-813"]);

  const changeContext = await getChangeContext(store, workspace.id, {
    repo: "payment-service",
    task: "Remove includeLegacyFees from the payment endpoint",
    files: ["src/routes/payment.ts"]
  });
  await store.close();

  assert.ok(changeContext.historicalReasons.some((reason) => reason.claim.includes("PAY-813")));
  assert.ok(changeContext.beforeEditing.some((item) => item.includes("PAY-813")));
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

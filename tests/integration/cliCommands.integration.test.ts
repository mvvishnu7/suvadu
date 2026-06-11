import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

test("CLI inspection commands show indexed memory without MCP", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suvadu-cli-"));
  const workspace = path.join(root, "workspace");
  const repo = path.join(workspace, "payment-service");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });

  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "suvadu@example.com"]);
  await git(repo, ["config", "user.name", "Suvadu Test"]);
  await writeFile(
    path.join(repo, "src/payment.ts"),
    `export function createPayment(amount: number, includeLegacyFees = false) {
  return { amount, includeLegacyFees };
}
`,
    "utf8"
  );
  await writeFile(path.join(repo, "tests/payment.test.ts"), "createPayment(10, true);\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "PAY-813 add includeLegacyFees for legacy invoice clients"]);

  await cli(workspace, ["init"]);
  await cli(repo, ["repo", "add", "."]);
  await cli(workspace, ["repo", "index", "payment-service"]);

  const memory = await cli(workspace, ["memory", "file", "payment-service", "src/payment.ts"]);
  assert.match(memory.stdout, /File: src\/payment\.ts/);
  assert.match(memory.stdout, /PAY-813/);

  const why = await cli(workspace, [
    "explain",
    "payment-service",
    "src/payment.ts",
    "--question",
    "Why does createPayment have includeLegacyFees?",
    "--symbol",
    "includeLegacyFees"
  ]);
  assert.match(why.stdout, /PAY-813/);
  assert.match(why.stdout, /includeLegacyFees/);

  const context = await cli(workspace, [
    "context",
    "payment-service",
    "--task",
    "Remove includeLegacyFees from the payment endpoint",
    "--file",
    "src/payment.ts",
    "--compact",
    "--json"
  ]);
  const contextJson = JSON.parse(context.stdout);
  assert.equal(typeof contextJson.briefing, "object");
  assert.equal("relevantFileMemories" in contextJson, false);
  assert.equal("historicalReasons" in contextJson, false);
  assert.equal("questionsToAsk" in contextJson, false);

  const review = await cli(workspace, [
    "review",
    "payment-service",
    "--diff-summary",
    "Removed includeLegacyFees from the payment endpoint",
    "--file",
    "src/payment.ts",
    "--compact",
    "--json"
  ]);
  const reviewJson = JSON.parse(review.stdout);
  assert.equal(typeof reviewJson.briefing, "object");
  assert.equal("evidence" in reviewJson, false);
  assert.equal("likelyReviewerConcerns" in reviewJson, false);
  assert.equal("testsToAdd" in reviewJson, false);

  const status = await cli(workspace, ["repo", "status", "payment-service"]);
  assert.match(status.stdout, /Detected Jira keys: 1/);
});

test("repo add auto-configures GitHub from origin remote", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suvadu-cli-github-add-"));
  const workspace = path.join(root, "workspace");
  const repo = path.join(workspace, "payment-service");
  await mkdir(repo, { recursive: true });

  await git(repo, ["init"]);
  await git(repo, ["remote", "add", "origin", "git@github.com:acme/payment-service.git"]);

  await cli(workspace, ["init"]);
  const add = await cli(repo, ["repo", "add", "."]);
  assert.match(add.stdout, /Detected GitHub remote: acme\/payment-service/);

  const config = JSON.parse(await readFile(path.join(workspace, ".suvadu.json"), "utf8"));
  assert.deepEqual(config.repositories[0].github, {
    host: "github.com",
    owner: "acme",
    repo: "payment-service"
  });
});

test("quickstart initializes workspace and registers a detected repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suvadu-cli-quickstart-"));
  const workspace = path.join(root, "workspace");
  const repo = path.join(workspace, "payment-service");
  await mkdir(repo, { recursive: true });
  const env = await noGitHubAuthEnv(root);

  await git(repo, ["init"]);
  await git(repo, ["remote", "add", "origin", "https://github.com/acme/payment-service.git"]);

  const quickstart = await cli(workspace, ["quickstart"], { env });
  assert.match(quickstart.stdout, /Suvadu quickstart/);
  assert.match(quickstart.stdout, /Registered repo: payment-service/);
  assert.match(quickstart.stdout, /GitHub enrichment: remote detected, auth missing/);
  assert.match(quickstart.stdout, /suvadu repo index payment-service/);

  const config = JSON.parse(await readFile(path.join(workspace, ".suvadu.json"), "utf8"));
  assert.equal(config.repositories[0].name, "payment-service");
  assert.deepEqual(config.repositories[0].github, {
    host: "github.com",
    owner: "acme",
    repo: "payment-service"
  });
});

test("quickstart can index immediately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suvadu-cli-quickstart-index-"));
  const workspace = path.join(root, "workspace");
  const repo = path.join(workspace, "payment-service");
  await mkdir(path.join(repo, "src"), { recursive: true });
  const env = await noGitHubAuthEnv(root);

  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "suvadu@example.com"]);
  await git(repo, ["config", "user.name", "Suvadu Test"]);
  await writeFile(path.join(repo, "src/payment.ts"), "export const payment = true;\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "PAY-813 add payment service"]);

  const quickstart = await cli(workspace, ["quickstart", "--index"], { env });
  assert.match(quickstart.stdout, /Registered repo: payment-service/);
  assert.match(quickstart.stdout, /Indexing "payment-service"/);
  assert.match(quickstart.stdout, /Indexed 1 files and 1 commits/);

  const status = await cli(workspace, ["status"], { env });
  assert.match(status.stdout, /Known repos: 1/);
  assert.match(status.stdout, /Indexed repos: 1/);
});

test("repo index backfills GitHub config for already-added repos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suvadu-cli-github-backfill-"));
  const workspace = path.join(root, "workspace");
  const repo = path.join(workspace, "payment-service");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(repo, "src"), { recursive: true });
  const env = await noGitHubAuthEnv(root);

  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "suvadu@example.com"]);
  await git(repo, ["config", "user.name", "Suvadu Test"]);
  await writeFile(path.join(repo, "src/payment.ts"), "export const payment = true;\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "PAY-813 add payment service"]);

  await cli(workspace, ["init"]);
  await cli(repo, ["repo", "add", "."]);
  await git(repo, ["remote", "add", "origin", "https://github.com/acme/payment-service.git"]);

  const index = await cli(workspace, ["repo", "index", "payment-service"], { env });
  assert.match(index.stdout, /Detected GitHub remote: acme\/payment-service/);
  assert.match(index.stdout, /GitHub PR enrichment skipped/);

  const config = JSON.parse(await readFile(path.join(workspace, ".suvadu.json"), "utf8"));
  assert.deepEqual(config.repositories[0].github, {
    host: "github.com",
    owner: "acme",
    repo: "payment-service"
  });
});

async function cli(cwd: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [path.resolve("dist/src/cli/index.js"), ...args], {
    cwd,
    env: {
      ...process.env,
      ...(options?.env ?? {})
    }
  });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function noGitHubAuthEnv(root: string): Promise<NodeJS.ProcessEnv> {
  const fakeBin = path.join(root, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  await writeFile(fakeGh, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(fakeGh, 0o755);
  return {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    GITHUB_TOKEN: "",
    GH_TOKEN: ""
  };
}

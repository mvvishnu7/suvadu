#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { initWorkspace, loadConfig, makeRepositoryConfig, repositoryFromConfig, saveConfig } from "../config/configLoader.js";
import { loadJiraCloudEnv, missingJiraCloudEnvVars } from "../config/env.js";
import { loadGitHubAuth } from "../config/githubAuth.js";
import { indexRepository } from "../indexing/repoIndexer.js";
import { compactChangeContextForMcp, compactReviewGuidanceForMcp, serveMcp } from "../mcp/server.js";
import { serveHttp } from "../api/httpServer.js";
import { explainWhyCodeExists, getChangeContext, getFileMemoryOutput, getReviewGuidance } from "../retrieval/contextBuilder.js";
import { SqliteMemoryStore } from "../storage/sqlite/SqliteMemoryStore.js";
import { detectGitHubRemote, getGitHead, isGitInstalled, isGitRepository, type GitHubRemoteInfo } from "../utils/git.js";
import { nowIso } from "../utils/time.js";
import { printChangeContext, printCompactOutput, printExplainWhy, printFileMemory, printJson, printReviewGuidance } from "./format.js";

async function main(argv: string[], cwd: string): Promise<void> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === "--help" || command === "-h") {
      printHelp();
      return;
    }
    if (command === "init") {
      await initCommand(rest, cwd);
      return;
    }
    if (command === "quickstart") {
      await quickstartCommand(rest, cwd);
      return;
    }
    if (command === "repo") {
      await repoCommand(rest, cwd);
      return;
    }
    if (command === "status") {
      await statusCommand(cwd);
      return;
    }
    if (command === "doctor") {
      await doctorCommand(cwd);
      return;
    }
    if (command === "memory") {
      await memoryCommand(rest, cwd);
      return;
    }
    if (command === "explain") {
      await explainCommand(rest, cwd);
      return;
    }
    if (command === "context") {
      await contextCommand(rest, cwd);
      return;
    }
    if (command === "review") {
      await reviewCommand(rest, cwd);
      return;
    }
    if (command === "serve") {
      await serveCommand(cwd);
      return;
    }
    if (command === "ui") {
      await uiCommand(rest, cwd);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function initCommand(args: string[], cwd: string): Promise<void> {
  const workspaceName = optionValue(args, "--name") ?? "default";
  const loaded = await initWorkspace(cwd, workspaceName);
  const store = new SqliteMemoryStore(loaded.dbPath);
  await store.upsertWorkspace(loaded.workspace);
  await store.close();
  console.log(`Initialized Suvadu workspace "${loaded.config.workspaceName}"`);
  console.log(`Config: ${loaded.configPath}`);
  console.log(`Local database: ${loaded.dbPath}`);
}

async function quickstartCommand(args: string[], cwd: string): Promise<void> {
  const workspaceName = optionValue(args, "--name") ?? "default";
  const requestedRepoPath = optionValue(args, "--repo") ?? positionalArgs(args)[0];
  const shouldIndex = hasFlag(args, "--index");
  const loaded = await initWorkspace(cwd, workspaceName);
  const store = new SqliteMemoryStore(loaded.dbPath);
  await store.upsertWorkspace(loaded.workspace);

  console.log("Suvadu quickstart");
  console.log(`Workspace: ${loaded.workspaceRoot}`);
  console.log(`Config: ${loaded.configPath}`);

  const repoPath = requestedRepoPath
    ? path.resolve(cwd, requestedRepoPath)
    : await detectQuickstartRepository(cwd);

  if (!repoPath) {
    await store.close();
    console.log("No git repository found here or in immediate subdirectories.");
    console.log("Next:");
    console.log("  suvadu repo add <path-to-git-repo>");
    console.log("  suvadu repo index <repo-name>");
    console.log("  suvadu ui");
    return;
  }

  if (!(await isGitRepository(repoPath))) {
    await store.close();
    throw new Error(`Quickstart repo path is not a git repository: ${displayPathForQuickstart(loaded.workspaceRoot, repoPath)}`);
  }

  const name = optionValue(args, "--repo-name") ?? optionValue(args, "--repoName") ?? path.basename(repoPath);
  const existingConfig = loaded.config.repositories.find((repo) => repo.name === name);
  let activeRepositoryConfig = existingConfig;
  if (!activeRepositoryConfig) {
    const detectedGitHub = await detectGitHubRemote(repoPath);
    activeRepositoryConfig = {
      ...makeRepositoryConfig(loaded.workspaceRoot, name, repoPath),
      ...(detectedGitHub ? { github: githubConfigFromRemote(detectedGitHub) } : {})
    };
    await saveConfig(loaded, {
      ...loaded.config,
      repositories: [...loaded.config.repositories, activeRepositoryConfig]
    });
    console.log(`Registered repo: ${name} (${activeRepositoryConfig.path})`);
    if (detectedGitHub) {
      console.log(`Detected GitHub remote: ${detectedGitHub.owner}/${detectedGitHub.repo}`);
    }
  } else {
    console.log(`Repo already registered: ${name} (${activeRepositoryConfig.path})`);
  }

  const refreshed = await loadConfig(loaded.workspaceRoot);
  const repositoryConfig = refreshed.config.repositories.find((repo) => repo.name === name);
  if (!repositoryConfig) {
    await store.close();
    throw new Error(`Could not load registered repository "${name}".`);
  }
  const repository = repositoryFromConfig(refreshed, repositoryConfig);
  await store.upsertRepository(repository);

  const gitHubAuth = repositoryConfig.github ? await loadGitHubAuth() : null;
  const missingJira = missingJiraCloudEnvVars(refreshed.config.jira?.baseUrl);
  console.log(`GitHub enrichment: ${repositoryConfig.github ? gitHubAuth ? `ready via ${gitHubAuth.source}` : "remote detected, auth missing" : "no GitHub remote detected"}`);
  console.log(`Jira enrichment: ${missingJira.length === 0 ? "ready" : "not configured"}`);

  if (shouldIndex) {
    await store.close();
    await runRepoIndex(name, refreshed.workspaceRoot, { incremental: false });
  } else {
    await store.close();
    console.log("Next:");
    console.log(`  suvadu repo index ${name}`);
    console.log("  suvadu ui");
  }
}

async function repoCommand(args: string[], cwd: string): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    await repoAddCommand(rest, cwd);
    return;
  }
  if (subcommand === "list") {
    await repoListCommand(cwd);
    return;
  }
  if (subcommand === "index") {
    await repoIndexCommand(rest, cwd);
    return;
  }
  if (subcommand === "update") {
    await repoUpdateCommand(rest, cwd);
    return;
  }
  if (subcommand === "status") {
    await repoStatusCommand(rest, cwd);
    return;
  }
  throw new Error("Usage: suvadu repo <add|list|index|update|status>");
}

async function repoAddCommand(args: string[], cwd: string): Promise<void> {
  const repoPath = positionalArgs(args)[0];
  if (!repoPath) {
    throw new Error("Usage: suvadu repo add <path> [--name <name>]");
  }
  const loaded = await loadConfig(cwd);
  const absolutePath = path.resolve(cwd, repoPath);
  const name = optionValue(args, "--name") ?? path.basename(absolutePath);
  if (!name || name === "." || name === path.sep) {
    throw new Error("Could not infer repository name. Use: suvadu repo add <path> --name <name>");
  }
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Repository path does not exist or is not a directory: ${repoPath}`);
  }
  if (!(await isGitRepository(absolutePath))) {
    throw new Error(`Path is not a git repository: ${repoPath}`);
  }
  if (loaded.config.repositories.some((repo) => repo.name === name)) {
    throw new Error(`Repository "${name}" is already registered.`);
  }

  const detectedGitHub = await detectGitHubRemote(absolutePath);
  const repositoryConfig = {
    ...makeRepositoryConfig(loaded.workspaceRoot, name, absolutePath),
    ...(detectedGitHub ? { github: githubConfigFromRemote(detectedGitHub) } : {})
  };
  const nextConfig = {
    ...loaded.config,
    repositories: [...loaded.config.repositories, repositoryConfig]
  };
  await saveConfig(loaded, nextConfig);

  const updatedLoaded = await loadConfig(cwd);
  const store = new SqliteMemoryStore(updatedLoaded.dbPath);
  await store.upsertWorkspace(updatedLoaded.workspace);
  await store.upsertRepository(repositoryFromConfig(updatedLoaded, repositoryConfig));
  await store.close();

  console.log(`Registered repo "${name}" at ${repositoryConfig.path}`);
  if (detectedGitHub) {
    console.log(`Detected GitHub remote: ${detectedGitHub.owner}/${detectedGitHub.repo} (${detectedGitHub.host}, ${detectedGitHub.remote})`);
  }
  console.log("Not indexed yet. Run:");
  console.log(`  suvadu repo index ${name}`);
}

async function repoListCommand(cwd: string): Promise<void> {
  const loaded = await loadConfig(cwd);
  const store = new SqliteMemoryStore(loaded.dbPath);
  const storedRepositories = await store.listRepositories(loaded.workspace.id);
  await store.close();
  if (loaded.config.repositories.length === 0 && storedRepositories.length === 0) {
    console.log("No repositories registered.");
    return;
  }
  const byName = new Map(storedRepositories.map((repo) => [repo.name, repo]));
  const repositories = loaded.config.repositories.map((repoConfig) => byName.get(repoConfig.name) ?? repositoryFromConfig(loaded, repoConfig));
  for (const repo of repositories) {
    console.log(`${repo.name}\t${repo.indexStatus ?? "unindexed"}\t${repo.path}${repo.lastIndexedAt ? `\tlast indexed ${repo.lastIndexedAt}` : ""}`);
  }
}

async function repoIndexCommand(args: string[], cwd: string): Promise<void> {
  const name = args[0];
  if (!name) {
    throw new Error("Usage: suvadu repo index <repo-name>");
  }
  await runRepoIndex(name, cwd, { incremental: false });
}

async function repoUpdateCommand(args: string[], cwd: string): Promise<void> {
  const name = args[0];
  if (!name) {
    throw new Error("Usage: suvadu repo update <repo-name>");
  }
  await runRepoIndex(name, cwd, { incremental: true });
}

async function runRepoIndex(name: string, cwd: string, options: { incremental: boolean }): Promise<void> {
  const loaded = await loadConfig(cwd);
  const repositoryConfig = loaded.config.repositories.find((repo) => repo.name === name);
  if (!repositoryConfig) {
    throw new Error(`Repository "${name}" is not registered. Suvadu only indexes explicitly added repositories.`);
  }
  let activeRepositoryConfig = repositoryConfig;
  const repository = repositoryFromConfig(loaded, repositoryConfig);
  if (!(await isGitRepository(repository.absolutePath))) {
    throw new Error(`Registered path is no longer a git repository: ${repository.path}`);
  }
  if (!activeRepositoryConfig.github) {
    const detectedGitHub = await detectGitHubRemote(repository.absolutePath);
    if (detectedGitHub) {
      activeRepositoryConfig = {
        ...activeRepositoryConfig,
        github: githubConfigFromRemote(detectedGitHub)
      };
      await saveConfig(loaded, {
        ...loaded.config,
        repositories: loaded.config.repositories.map((repo) => (repo.name === name ? activeRepositoryConfig : repo))
      });
      console.log(`Detected GitHub remote: ${detectedGitHub.owner}/${detectedGitHub.repo} (${detectedGitHub.host}, ${detectedGitHub.remote}). Saved to .suvadu.json.`);
    }
  }

  const store = new SqliteMemoryStore(loaded.dbPath);
  await store.upsertWorkspace(loaded.workspace);

  let since: string | undefined;
  if (options.incremental) {
    const storedRepo = await store.getRepositoryById(repository.id);
    since = storedRepo?.lastIndexedAt;
    if (since) {
      console.log(`Updating "${repository.name}" since ${since} ...`);
    } else {
      console.log(`No previous index found for "${repository.name}"; running full index ...`);
    }
  } else {
    console.log(`Indexing "${repository.name}" from ${repository.path} ...`);
  }

  await store.upsertRepository(repository);

  const jiraCloud = loadJiraCloudEnv(loaded.config.jira?.baseUrl);
  const githubAuth = activeRepositoryConfig.github ? await loadGitHubAuth() : null;
  const jiraConfigured = Boolean(
    loaded.config.jira?.baseUrl ||
      process.env.JIRA_BASE_URL ||
      process.env.JIRA_EMAIL ||
      process.env.JIRA_API_TOKEN
  );
  const result = await indexRepository(store, repository, {
    maxCommits: loaded.config.indexing.maxCommits,
    maxPullRequests: loaded.config.indexing.maxPullRequests,
    jiraProjectKeys: loaded.config.jira?.projectKeys,
    jiraCloud,
    jiraConfigured,
    missingJiraEnvVars: missingJiraCloudEnvVars(loaded.config.jira?.baseUrl),
    github: activeRepositoryConfig.github,
    githubAuth,
    includeReviewComments: loaded.config.indexing.includeReviewComments,
    since
  });
  await store.close();
  console.log(`Indexed ${result.indexedFiles} files and ${result.indexedCommits} commits.`);
  if (result.indexedJiraIssues > 0) {
    console.log(`Fetched ${result.indexedJiraIssues} Jira Cloud issues.`);
  }
  if (result.indexedJiraComments > 0) {
    console.log(`Fetched ${result.indexedJiraComments} Jira comments.`);
  }
  if (result.indexedPullRequests > 0) {
    console.log(`Fetched ${result.indexedPullRequests} GitHub pull requests.`);
  }
  if (result.indexedReviewComments > 0) {
    console.log(`Fetched ${result.indexedReviewComments} GitHub review comments.`);
  }
  if (result.indexedIssueComments > 0) {
    console.log(`Fetched ${result.indexedIssueComments} GitHub PR conversation comments.`);
  }
  if (result.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

async function repoStatusCommand(args: string[], cwd: string): Promise<void> {
  const name = args[0];
  if (!name) {
    throw new Error("Usage: suvadu repo status <repo-name>");
  }
  const loaded = await loadConfig(cwd);
  const store = new SqliteMemoryStore(loaded.dbPath);
  const configuredRepo = loaded.config.repositories.find((item) => item.name === name);
  const repo = (await store.getRepositoryByName(loaded.workspace.id, name)) ?? (configuredRepo ? repositoryFromConfig(loaded, configuredRepo) : null);
  if (!repo) {
    throw new Error(`Repository "${name}" is not registered.`);
  }
  const run = await store.getLatestIndexRun(repo.id);
  const repoMemory = await store.getRepoMemory(repo.id);
  const fileMemories = await store.listFileMemories(repo.id);
  const jiraNodes = await store.findNodes({
    workspaceId: loaded.workspace.id,
    repoId: repo.id,
    type: "jira_ticket",
    limit: 1000
  });
  const pullRequestNodes = await store.findNodes({
    workspaceId: loaded.workspace.id,
    repoId: repo.id,
    type: "pull_request",
    limit: 1000
  });
  const reviewCommentNodes = await store.findNodes({
    workspaceId: loaded.workspace.id,
    repoId: repo.id,
    type: "review_comment",
    limit: 1000
  });
  const currentHead = await getGitHead(repo.absolutePath);
  await store.close();
  const detectedJiraKeys = new Set(fileMemories.flatMap((memory) => memory.relatedJiraKeys));
  const fetchedJiraIssues = jiraNodes.filter((node) => node.properties.fetchedFromJiraCloud === true);
  console.log(`Repo: ${repo.name}`);
  console.log(`Path: ${repo.path}`);
  console.log(`Status: ${repo.indexStatus ?? "unindexed"}`);
  console.log(`Current HEAD: ${currentHead ?? "unknown"}`);
  if (repo.lastIndexedAt) {
    console.log(`Last indexed: ${repo.lastIndexedAt}`);
  }
  if (run) {
    console.log(`Last run: ${run.status} at ${run.completedAt ?? run.startedAt}`);
    console.log(`Indexed files: ${run.indexedFiles}`);
    console.log(`Indexed commits: ${run.indexedCommits}`);
  }
  console.log(`File memories: ${fileMemories.length}`);
  console.log(`Detected Jira keys: ${detectedJiraKeys.size}`);
  console.log(`Fetched Jira issues: ${fetchedJiraIssues.length}`);
  console.log(`Fetched GitHub PRs: ${pullRequestNodes.length}`);
  console.log(`Fetched GitHub review comments: ${reviewCommentNodes.length}`);
  console.log(`Jira enrichment: ${jiraEnrichmentStatus(loaded, fetchedJiraIssues.length)}`);
  if (repoMemory) {
    console.log(`Memory summary: ${repoMemory.summary}`);
    if (repoMemory.highRiskFiles.length > 0) {
      console.log("High-attention files:");
      for (const file of repoMemory.highRiskFiles.slice(0, 10)) {
        console.log(`- ${file}`);
      }
    }
  }
  const warnings = [...(repo.warnings ?? []), ...(run?.warnings ?? [])];
  if (warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

async function doctorCommand(cwd: string): Promise<void> {
  console.log("Suvadu doctor");
  const nodeMajor = parseInt(process.version.slice(1), 10);
  const nodeOk = nodeMajor >= 22;
  console.log(`Node.js: ${process.version}${nodeOk ? "" : " ⚠ requires v22+"}`);
  console.log(`Git CLI: ${(await isGitInstalled()) ? "ok" : "missing"}`);
  let loaded;
  try {
    loaded = await loadConfig(cwd);
  } catch (error) {
    console.log(`Workspace config: missing (${error instanceof Error ? error.message : String(error)})`);
    console.log("SQLite: not checked");
    console.log("Jira Cloud auth: not checked");
    return;
  }
  console.log(`Workspace config: ok (${loaded.configPath})`);
  console.log(`Workspace: ${loaded.config.workspaceName}`);
  console.log(`Database: ${loaded.dbPath}`);
  const store = new SqliteMemoryStore(loaded.dbPath);
  const storedRepositories = await store.listRepositories(loaded.workspace.id);
  const stats = await store.getStats(loaded.workspace.id);
  await store.close();
  console.log("SQLite: ok");
  console.log(`Registered repos: ${Math.max(loaded.config.repositories.length, storedRepositories.length)}`);
  console.log(`Indexed repos: ${stats.indexedRepositories}`);
  const missingJira = missingJiraCloudEnvVars(loaded.config.jira?.baseUrl);
  console.log(`Jira Cloud auth: ${missingJira.length === 0 ? "configured" : `missing ${missingJira.join(", ")}`}`);
  const hasGitHubRepos = loaded.config.repositories.some((repo) => Boolean(repo.github));
  if (hasGitHubRepos) {
    const githubAuth = await loadGitHubAuth();
    console.log(`GitHub auth: ${githubAuth ? `configured via ${githubAuth.source}` : "missing gh auth token, GITHUB_TOKEN, or GH_TOKEN"}`);
  } else {
    const detectableRepos = await detectConfigurableGitHubRepos(loaded);
    console.log(
      detectableRepos.length > 0
        ? `GitHub auth: not checked (${detectableRepos.join(", ")} can be auto-configured from git remote)`
        : "GitHub auth: not checked (no repos have GitHub config)"
    );
  }
  console.log(`MCP server: run "suvadu serve" from ${loaded.workspaceRoot}`);
}

async function memoryCommand(args: string[], cwd: string): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "file") {
    throw new Error("Usage: suvadu memory file <repo> <file-path> [--json]");
  }
  const repo = rest[0];
  const filePath = rest[1];
  if (!repo || !filePath) {
    throw new Error("Usage: suvadu memory file <repo> <file-path> [--json]");
  }
  const loaded = await loadConfig(cwd);
  const store = new SqliteMemoryStore(loaded.dbPath);
  const output = await getFileMemoryOutput(store, loaded.workspace.id, { repo, filePath });
  await store.close();
  hasFlag(rest, "--json") ? printJson(output) : printFileMemory(output);
}

async function explainCommand(args: string[], cwd: string): Promise<void> {
  const repo = args[0];
  const filePath = args[1];
  const question = optionValue(args, "--question") ?? optionValue(args, "-q");
  if (!repo || !filePath || !question) {
    throw new Error('Usage: suvadu explain <repo> <file-path> --question "Why does this exist?" [--symbol <symbol>] [--line <line>] [--json]');
  }
  const loaded = await loadConfig(cwd);
  const store = new SqliteMemoryStore(loaded.dbPath);
  const output = await explainWhyCodeExists(store, loaded.workspace.id, {
    repo,
    filePath,
    question,
    symbol: optionValue(args, "--symbol"),
    line: numberOptionValue(args, "--line")
  });
  await store.close();
  hasFlag(args, "--json") ? printJson(output) : printExplainWhy(output);
}

async function contextCommand(args: string[], cwd: string): Promise<void> {
  const repo = args[0];
  const task = optionValue(args, "--task") ?? optionValue(args, "-t");
  const files = optionValues(args, "--file");
  if (!repo || !task || files.length === 0) {
    throw new Error('Usage: suvadu context <repo> --task "Change summary" --file <file-path> [--file <file-path>] [--compact] [--json]');
  }
  const loaded = await loadConfig(cwd);
  const store = new SqliteMemoryStore(loaded.dbPath);
  const output = await getChangeContext(store, loaded.workspace.id, { repo, task, files });
  await store.close();
  const compact = hasFlag(args, "--compact") ? compactChangeContextForMcp(output) : null;
  hasFlag(args, "--json") ? printJson(compact ?? output) : compact ? printCompactOutput(compact) : printChangeContext(output);
}

async function reviewCommand(args: string[], cwd: string): Promise<void> {
  const repo = args[0];
  const diffSummary = optionValue(args, "--diff-summary") ?? optionValue(args, "--summary") ?? optionValue(args, "-s");
  const files = optionValues(args, "--file");
  if (!repo || !diffSummary) {
    throw new Error('Usage: suvadu review <repo> --diff-summary "Changed payment validation" [--file <file-path>] [--compact] [--json]');
  }
  const loaded = await loadConfig(cwd);
  const store = new SqliteMemoryStore(loaded.dbPath);
  const output = await getReviewGuidance(store, loaded.workspace.id, { repo, diffSummary, files });
  await store.close();
  const compact = hasFlag(args, "--compact") ? compactReviewGuidanceForMcp(output, diffSummary) : null;
  hasFlag(args, "--json") ? printJson(compact ?? output) : compact ? printCompactOutput(compact) : printReviewGuidance(output);
}

async function statusCommand(cwd: string): Promise<void> {
  const loaded = await loadConfig(cwd);
  const store = new SqliteMemoryStore(loaded.dbPath);
  const storedRepositories = await store.listRepositories(loaded.workspace.id);
  const stats = await store.getStats(loaded.workspace.id);
  await store.close();
  const repositoryCount = Math.max(loaded.config.repositories.length, storedRepositories.length);
  console.log(`Workspace: ${loaded.config.workspaceName}`);
  console.log(`Config: ${loaded.configPath}`);
  console.log(`Known repos: ${repositoryCount}`);
  console.log(`Indexed repos: ${stats.indexedRepositories}`);
  console.log(`Unindexed repos: ${repositoryCount - stats.indexedRepositories}`);
  console.log(`Nodes: ${stats.nodes}`);
  console.log(`Relationships: ${stats.relationships}`);
  console.log(`File memories: ${stats.fileMemories}`);
  if (stats.lastIndexedRepo) {
    console.log(`Last indexed repo: ${stats.lastIndexedRepo}`);
  }
  if (stats.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of stats.warnings.slice(0, 20)) {
      console.log(`- ${warning}`);
    }
  }
}

async function serveCommand(cwd: string): Promise<void> {
  const startedAt = performance.now();
  const configStartedAt = performance.now();
  const loaded = await loadConfig(cwd);
  const configLoadMs = performance.now() - configStartedAt;
  const storeStartedAt = performance.now();
  const store = new SqliteMemoryStore(loaded.dbPath);
  const storeOpenMs = performance.now() - storeStartedAt;
  await serveMcp(store, loaded, {
    startupTiming: {
      configLoadMs,
      storeOpenMs,
      totalMs: performance.now() - startedAt
    }
  });
}

async function uiCommand(args: string[], cwd: string): Promise<void> {
  const port = Number(optionValue(args, "--port") ?? "7337");
  const staticDir = new URL("../../../ui/dist", import.meta.url).pathname;
  const cliPath = new URL("../../../dist/src/cli/index.js", import.meta.url).pathname;

  let loaded: Awaited<ReturnType<typeof loadConfig>> | null = null;
  let store: SqliteMemoryStore | null = null;

  try {
    loaded = await loadConfig(cwd);
    store = new SqliteMemoryStore(loaded.dbPath);
    await syncConfiguredRepositories(store, loaded);
  } catch {
    // No workspace configured yet — start in setup mode
  }

  await serveHttp(store, loaded, { port, staticDir, cliPath, initialCwd: cwd });
  console.log(`Suvadu UI running at http://localhost:${port}`);
  const { exec } = await import("node:child_process");
  const url = `http://localhost:${port}`;
  const openCmd = process.platform === "win32" ? `start ${url}` : process.platform === "darwin" ? `open ${url}` : `xdg-open ${url}`;
  exec(openCmd);
}

async function syncConfiguredRepositories(store: SqliteMemoryStore, loaded: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  await store.upsertWorkspace(loaded.workspace);
  for (const repositoryConfig of loaded.config.repositories) {
    const existing = await store.getRepositoryByName(loaded.workspace.id, repositoryConfig.name);
    const repository = repositoryFromConfig(loaded, repositoryConfig);
    await store.upsertRepository({
      ...repository,
      indexStatus: existing?.indexStatus ?? "unindexed",
      lastIndexedAt: existing?.lastIndexedAt,
      warnings: existing?.warnings ?? [],
      createdAt: existing?.createdAt ?? repository.createdAt,
      updatedAt: nowIso()
    });
  }
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function optionValues(args: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option && args[index + 1]) {
      values.push(args[index + 1]);
    }
  }
  return values;
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("-")) {
      if (index + 1 < args.length && !args[index + 1].startsWith("-")) {
        index += 1;
      }
      continue;
    }
    values.push(arg);
  }
  return values;
}

function numberOptionValue(args: string[], option: string): number | undefined {
  const value = optionValue(args, option);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasFlag(args: string[], option: string): boolean {
  return args.includes(option);
}

function jiraEnrichmentStatus(loaded: Awaited<ReturnType<typeof loadConfig>>, fetchedIssueCount: number): string {
  if (fetchedIssueCount > 0) {
    return "enabled";
  }
  const missing = missingJiraCloudEnvVars(loaded.config.jira?.baseUrl);
  if (loaded.config.jira?.baseUrl || process.env.JIRA_BASE_URL || process.env.JIRA_EMAIL || process.env.JIRA_API_TOKEN) {
    return missing.length === 0 ? "configured, no fetched issues" : `configured, missing ${missing.join(", ")}`;
  }
  return "not configured";
}

function githubConfigFromRemote(remote: GitHubRemoteInfo): { host: string; owner: string; repo: string } {
  return {
    host: remote.host,
    owner: remote.owner,
    repo: remote.repo
  };
}

async function detectConfigurableGitHubRepos(loaded: Awaited<ReturnType<typeof loadConfig>>): Promise<string[]> {
  const names: string[] = [];
  for (const repositoryConfig of loaded.config.repositories) {
    if (repositoryConfig.github) {
      continue;
    }
    const repository = repositoryFromConfig(loaded, repositoryConfig);
    const detected = await detectGitHubRemote(repository.absolutePath);
    if (detected) {
      names.push(repositoryConfig.name);
    }
  }
  return names;
}

async function detectQuickstartRepository(cwd: string): Promise<string | null> {
  if (await isGitRepository(cwd)) {
    return cwd;
  }
  let entries;
  try {
    entries = await fs.readdir(cwd, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(cwd, entry.name))
    .sort();
  for (const directory of directories) {
    if (await isGitRepository(directory)) {
      return directory;
    }
  }
  return null;
}

function displayPathForQuickstart(workspaceRoot: string, repoPath: string): string {
  const relative = path.relative(workspaceRoot, repoPath);
  return relative && !relative.startsWith("..") ? relative : repoPath;
}

function printHelp(): void {
  console.log(`Suvadu - Long-term memory for AI coding agents

Usage:
  suvadu quickstart [repo-path] [--index]
  suvadu init [--name <workspace-name>]
  suvadu repo add <path> [--name <name>]
  suvadu repo list
  suvadu repo index <repo-name>
  suvadu repo status <repo-name>
  suvadu status
  suvadu doctor
  suvadu memory file <repo> <file-path> [--json]
  suvadu explain <repo> <file-path> --question "Why does this exist?" [--symbol <symbol>] [--line <line>] [--json]
  suvadu context <repo> --task "Change summary" --file <file-path> [--compact] [--json]
  suvadu review <repo> --diff-summary "Change summary" [--file <file-path>] [--compact] [--json]
  suvadu serve
`);
}

await main(process.argv.slice(2), process.cwd());

import http from "node:http";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { LoadedConfig } from "../config/configLoader.js";
import { initWorkspace, loadConfig, repositoryFromConfig, saveConfig } from "../config/configLoader.js";
import { loadJiraCloudEnv, missingJiraCloudEnvVars } from "../config/env.js";
import { loadGitHubAuth } from "../config/githubAuth.js";

import { indexRepository } from "../indexing/repoIndexer.js";
import { SqliteMemoryStore } from "../storage/sqlite/SqliteMemoryStore.js";
import type { MemoryStore } from "../storage/MemoryStore.js";
import { detectGitHubRemote, isGitRepository } from "../utils/git.js";
import { nowIso } from "../utils/time.js";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

export interface HttpServerOptions {
  port: number;
  staticDir: string;
  cliPath: string;
  initialCwd: string;
}

const CREDENTIALS_FILE = "credentials.json";

interface StoredCredentials {
  jiraBaseUrl?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  githubToken?: string;
}

async function loadCredentials(dataDir: string): Promise<StoredCredentials> {
  try {
    const raw = await fsPromises.readFile(path.join(dataDir, CREDENTIALS_FILE), "utf8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return {};
  }
}

async function saveCredentials(dataDir: string, creds: StoredCredentials): Promise<void> {
  await fsPromises.mkdir(dataDir, { recursive: true });
  await fsPromises.writeFile(path.join(dataDir, CREDENTIALS_FILE), JSON.stringify(creds, null, 2));
}

function injectCredentials(creds: StoredCredentials): void {
  if (creds.jiraBaseUrl && !process.env.JIRA_BASE_URL) process.env.JIRA_BASE_URL = creds.jiraBaseUrl;
  if (creds.jiraEmail && !process.env.JIRA_EMAIL) process.env.JIRA_EMAIL = creds.jiraEmail;
  if (creds.jiraApiToken && !process.env.JIRA_API_TOKEN) process.env.JIRA_API_TOKEN = creds.jiraApiToken;
  if (creds.githubToken && !process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = creds.githubToken;
}

export async function serveHttp(
  initialStore: MemoryStore | null,
  initialLoaded: LoadedConfig | null,
  options: HttpServerOptions
): Promise<http.Server> {
  // Mutable state — replaced after setup init
  let store = initialStore;
  let loaded = initialLoaded;

  if (loaded) {
    const creds = await loadCredentials(loaded.dataDir);
    injectCredentials(creds);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${options.port}`);

    if (url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      try {
        let body: unknown = undefined;
        if (req.method === "POST") {
          body = await readJson(req);
        }

        // Setup endpoints — always available
        if (req.method === "GET" && url.pathname === "/api/setup/status") {
          res.writeHead(200);
          res.end(JSON.stringify({ configured: loaded !== null }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/setup/init") {
          const { workspaceDir } = body as { workspaceDir: string };
          if (!workspaceDir) throw new Error("workspaceDir is required");
          const newLoaded = await initWorkspace(workspaceDir);
          const newStore = new SqliteMemoryStore(newLoaded.dbPath);
          await newStore.upsertWorkspace(newLoaded.workspace);
          const creds = await loadCredentials(newLoaded.dataDir);
          injectCredentials(creds);
          loaded = newLoaded;
          store = newStore;
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, workspaceRoot: newLoaded.workspaceRoot }));
          return;
        }

        if (!store || !loaded) {
          res.writeHead(200);
          res.end(JSON.stringify({ error: "Workspace not configured", code: "NOT_CONFIGURED" }));
          return;
        }

        const result = await handleApi(store, loaded, options, req.method ?? "GET", url.pathname, url.searchParams, body);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    serveStatic(res, url.pathname, options.staticDir);
  });

  return new Promise((resolve) => {
    server.listen(options.port, () => resolve(server));
  });
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += String(chunk); });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

async function handleApi(
  store: MemoryStore,
  loaded: LoadedConfig,
  options: HttpServerOptions,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: unknown
): Promise<unknown> {
  // GET /api/status
  if (method === "GET" && pathname === "/api/status") {
    return getWorkspaceStatus(store, loaded);
  }

  // GET /api/doctor
  if (method === "GET" && pathname === "/api/doctor") {
    return getDoctorStatus(loaded);
  }

  // GET /api/settings
  if (method === "GET" && pathname === "/api/settings") {
    const creds = await loadCredentials(loaded.dataDir);
    const githubAuth = await loadGitHubAuth();
    return {
      jira: {
        baseUrl: process.env.JIRA_BASE_URL ?? creds.jiraBaseUrl ?? "",
        email: process.env.JIRA_EMAIL ?? creds.jiraEmail ?? "",
        configured: Boolean(
          (process.env.JIRA_BASE_URL ?? creds.jiraBaseUrl) &&
          (process.env.JIRA_EMAIL ?? creds.jiraEmail) &&
          (process.env.JIRA_API_TOKEN ?? creds.jiraApiToken)
        )
      },
      github: {
        configured: Boolean(githubAuth),
        source: githubAuth?.source ?? null,
        hasStoredToken: Boolean(creds.githubToken)
      }
    };
  }

  // POST /api/settings/jira  { baseUrl, email, apiToken }
  if (method === "POST" && pathname === "/api/settings/jira") {
    const { baseUrl, email, apiToken } = body as { baseUrl: string; email: string; apiToken: string };
    if (!baseUrl || !email || !apiToken) throw new Error("baseUrl, email, and apiToken are required");
    const existing = await loadCredentials(loaded.dataDir);
    const creds: StoredCredentials = { ...existing, jiraBaseUrl: baseUrl.replace(/\/+$/, ""), jiraEmail: email, jiraApiToken: apiToken };
    await saveCredentials(loaded.dataDir, creds);
    process.env.JIRA_BASE_URL = creds.jiraBaseUrl;
    process.env.JIRA_EMAIL = creds.jiraEmail;
    process.env.JIRA_API_TOKEN = creds.jiraApiToken;
    return { ok: true };
  }

  // POST /api/settings/github  { token }
  if (method === "POST" && pathname === "/api/settings/github") {
    const { token } = body as { token: string };
    if (!token) throw new Error("token is required");
    const existing = await loadCredentials(loaded.dataDir);
    const creds: StoredCredentials = { ...existing, githubToken: token };
    await saveCredentials(loaded.dataDir, creds);
    process.env.GITHUB_TOKEN = token;
    return { ok: true };
  }

  // GET /api/browse?path=<dir>
  if (method === "GET" && pathname === "/api/browse") {
    const dir = searchParams.get("path") ?? os.homedir();
    return browsedir(dir);
  }

  // POST /api/repos/add  { path, name? }
  if (method === "POST" && pathname === "/api/repos/add") {
    const creds = await loadCredentials(loaded.dataDir);
    const jiraConfigured = Boolean(
      (process.env.JIRA_BASE_URL ?? creds.jiraBaseUrl) &&
      (process.env.JIRA_EMAIL ?? creds.jiraEmail) &&
      (process.env.JIRA_API_TOKEN ?? creds.jiraApiToken)
    );
    const githubAuth = await loadGitHubAuth();
    if (!jiraConfigured && !githubAuth) {
      return { error: "No sources configured. Set up Jira or GitHub credentials before adding a repository.", code: "CREDENTIALS_MISSING" };
    }
    return addRepo(store, loaded, options, body as { path: string; name?: string });
  }

  // GET /api/repos/:name
  const repoMatch = pathname.match(/^\/api\/repos\/([^/]+)$/);
  if (repoMatch) {
    const name = decodeURIComponent(repoMatch[1]);
    if (method === "GET") return getRepoDetail(store, loaded, name);
  }

  // POST /api/repos/:name/index  or  /api/repos/:name/update
  const repoActionMatch = pathname.match(/^\/api\/repos\/([^/]+)\/(index|update)$/);
  if (repoActionMatch && method === "POST") {
    const name = decodeURIComponent(repoActionMatch[1]);
    const incremental = repoActionMatch[2] === "update";
    return runIndex(store, loaded, name, incremental);
  }

  // GET /api/install/claude-code/status — detect config file path
  if (method === "GET" && pathname === "/api/install/claude-code/status") {
    const candidates = [
      path.join(os.homedir(), ".claude.json"),
      path.join(os.homedir(), ".claude", "settings.json")
    ];
    let detectedPath = candidates[1];
    for (const c of candidates) {
      try { await fsPromises.access(c); detectedPath = c; break; } catch { /* continue */ }
    }
    return { configFilePath: detectedPath };
  }

  // POST /api/install/claude-code
  if (method === "POST" && pathname === "/api/install/claude-code") {
    return installClaudeCode(store, loaded, options);
  }

  throw new Error(`Unknown API endpoint: ${method} ${pathname}`);
}

// ── Browse ────────────────────────────────────────────────────────────────────

async function browsedir(dirPath: string) {
  const expanded = dirPath === "~" || dirPath.startsWith("~/")
    ? dirPath.replace("~", os.homedir())
    : dirPath;
  const resolved = path.resolve(expanded);
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(resolved, { withFileTypes: true });
  } catch {
    throw new Error(`Cannot read directory: ${resolved}`);
  }
  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith("."))
    .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(resolved);
  return {
    current: resolved,
    parent: parent !== resolved ? parent : null,
    dirs,
  };
}

// ── Add repo ──────────────────────────────────────────────────────────────────

async function addRepo(
  store: MemoryStore,
  loaded: LoadedConfig,
  options: HttpServerOptions,
  body: { path: string; name?: string }
) {
  const absolutePath = path.resolve(loaded.workspaceRoot, body.path);
  const name = body.name ?? path.basename(absolutePath);

  if (!(await isGitRepository(absolutePath))) {
    throw new Error(`Not a git repository: ${absolutePath}`);
  }
  if (loaded.config.repositories.some(r => r.name === name)) {
    throw new Error(`Repository "${name}" is already registered.`);
  }

  const detectedGitHub = await detectGitHubRemote(absolutePath);
  const { makeRepositoryConfig } = await import("../config/configLoader.js");
  const repositoryConfig = {
    ...makeRepositoryConfig(loaded.workspaceRoot, name, absolutePath),
    ...(detectedGitHub ? {
      github: {
        host: detectedGitHub.host,
        owner: detectedGitHub.owner,
        repo: detectedGitHub.repo
      }
    } : {})
  };

  const nextConfig = {
    ...loaded.config,
    repositories: [...loaded.config.repositories, repositoryConfig]
  };
  await saveConfig(loaded, nextConfig);

  const updatedLoaded = await loadConfig(loaded.workspaceRoot);
  await store.upsertRepository(repositoryFromConfig(updatedLoaded, repositoryConfig));

  // Mutate loaded in place so subsequent calls see the new repo
  loaded.config.repositories = updatedLoaded.config.repositories;

  // Index immediately after adding
  const indexResult = await runIndex(store, updatedLoaded, name, false);

  return { ok: true, name, github: detectedGitHub ?? null, indexResult };
}

// ── Index / Update ────────────────────────────────────────────────────────────

async function runIndex(
  store: MemoryStore,
  loaded: LoadedConfig,
  name: string,
  incremental: boolean
) {
  const repositoryConfig = loaded.config.repositories.find(r => r.name === name);
  if (!repositoryConfig) throw new Error(`Repository "${name}" is not registered.`);

  const repository = repositoryFromConfig(loaded, repositoryConfig);

  let since: string | undefined;
  if (incremental) {
    const storedRepo = await store.getRepositoryById(repository.id);
    since = storedRepo?.lastIndexedAt;
  }

  const jiraCloud = loadJiraCloudEnv(loaded.config.jira?.baseUrl);
  const githubAuth = repositoryConfig.github ? await loadGitHubAuth() : null;
  const jiraConfigured = Boolean(
    loaded.config.jira?.baseUrl ?? process.env.JIRA_BASE_URL ?? process.env.JIRA_EMAIL
  );

  await store.upsertRepository(repository);
  const result = await indexRepository(store, repository, {
    maxCommits: loaded.config.indexing.maxCommits,
    maxPullRequests: loaded.config.indexing.maxPullRequests,
    jiraProjectKeys: loaded.config.jira?.projectKeys,
    jiraCloud,
    jiraConfigured,
    missingJiraEnvVars: missingJiraCloudEnvVars(loaded.config.jira?.baseUrl),
    github: repositoryConfig.github,
    githubAuth,
    includeReviewComments: loaded.config.indexing.includeReviewComments,
    since
  });

  return {
    ok: true,
    indexedFiles: result.indexedFiles,
    indexedCommits: result.indexedCommits,
    indexedPullRequests: result.indexedPullRequests,
    indexedReviewComments: result.indexedReviewComments,
    indexedJiraIssues: result.indexedJiraIssues,
    warnings: result.warnings
  };
}

// ── Install Claude Code ───────────────────────────────────────────────────────

async function installClaudeCode(
  store: MemoryStore,
  loaded: LoadedConfig,
  options: HttpServerOptions
) {
  const results: string[] = [];

  // 1. Detect which Claude Code config file exists
  const candidates = [
    path.join(os.homedir(), ".claude.json"),           // newer Claude Code location
    path.join(os.homedir(), ".claude", "settings.json") // older / documented location
  ];
  let settingsPath = candidates[1]; // default fallback
  for (const candidate of candidates) {
    try {
      await fsPromises.access(candidate);
      settingsPath = candidate;
      break;
    } catch { /* not found, try next */ }
  }

  // 2. Write MCP server entry
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fsPromises.readFile(settingsPath, "utf8");
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // file doesn't exist yet — start fresh
  }
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  mcpServers.suvadu = {
    command: "node",
    args: [options.cliPath, "serve"],
    cwd: loaded.workspaceRoot
  };
  settings.mcpServers = mcpServers;
  await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  results.push(`Wrote MCP server config to ${settingsPath}`);
  const configFilePath = settingsPath;

  // 2. Write CLAUDE.md snippet to each indexed repo
  const repos = await store.listRepositories(loaded.workspace.id);
  const indexedRepos = repos.filter(r => r.indexStatus === "indexed");
  for (const repo of indexedRepos) {
    const claudeMdPath = path.join(repo.absolutePath, "CLAUDE.md");
    const snippet = buildClaudeMdSnippet(loaded, indexedRepos.map(r => r.name));
    let existing = "";
    try { existing = await fsPromises.readFile(claudeMdPath, "utf8"); } catch { /* new file */ }
    const marker = "<!-- suvadu-memory -->";
    const endMarker = "<!-- /suvadu-memory -->";
    const block = `${marker}\n${snippet}\n${endMarker}`;
    let updated: string;
    if (existing.includes(marker)) {
      updated = existing.replace(new RegExp(`${marker}[\\s\\S]*?${endMarker}`), block);
    } else {
      updated = existing ? `${existing}\n\n${block}` : block;
    }
    await fsPromises.writeFile(claudeMdPath, updated);
    results.push(`Updated CLAUDE.md in ${repo.name}`);
  }

  return { ok: true, results, configFilePath };
}

function buildClaudeMdSnippet(loaded: LoadedConfig, repoNames: string[]): string {
  const repoList = repoNames.map(n => `- \`${n}\``).join("\n");
  return `## Suvadu Memory

This workspace has Suvadu memory indexed. Use these tools to get historical context before editing or reviewing code.

**Before editing any file:**
Call \`suvadu.get_change_context\` with the repo name, your task description, and the files you plan to edit.

**Before finalizing a change or opening a PR:**
Call \`suvadu.review_change\` with the repo name, a summary of what changed, and the changed files.

**When something looks surprising:**
Call \`suvadu.explain_why_code_exists\` with the file path and a specific question.

**Indexed repos in this workspace:**
${repoList}

**Workspace root:** \`${loaded.workspaceRoot}\``;
}

// ── Doctor ───────────────────────────────────────────────────────────────────

async function getDoctorStatus(loaded: LoadedConfig) {
  const { isGitInstalled } = await import("../utils/git.js");
  const nodeMajor = parseInt(process.version.slice(1), 10);
  const gitOk = await isGitInstalled();
  const creds = await loadCredentials(loaded.dataDir);
  const githubAuth = await loadGitHubAuth(creds.githubToken);
  const jiraConfigured = Boolean(
    (process.env.JIRA_BASE_URL ?? creds.jiraBaseUrl) &&
    (process.env.JIRA_EMAIL ?? creds.jiraEmail) &&
    (process.env.JIRA_API_TOKEN ?? creds.jiraApiToken)
  );

  return {
    node: {
      version: process.version,
      ok: nodeMajor >= 22,
      required: "v22+",
      note: nodeMajor < 22 ? "node:sqlite requires Node.js v22 or later" : null
    },
    git: {
      ok: gitOk,
      note: gitOk ? null : "Git is required for indexing — install from https://git-scm.com"
    },
    jira: {
      ok: jiraConfigured,
      note: jiraConfigured ? null : "Optional — set credentials in Settings to enrich issues and comments"
    },
    github: {
      ok: Boolean(githubAuth),
      source: githubAuth?.source ?? null,
      note: githubAuth ? null : "Optional — set a token in Settings to index PRs and review comments"
    },
    mcp: {
      configPath: (await (async () => {
        for (const c of [path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", "settings.json")]) {
          try { await fsPromises.access(c); return c; } catch { /* continue */ }
        }
        return path.join(os.homedir(), ".claude", "settings.json");
      })()),
      note: "Run 'Connect Claude Code' in the UI or check Settings to configure MCP"
    }
  };
}

// ── Workspace status ──────────────────────────────────────────────────────────

async function getWorkspaceStatus(store: MemoryStore, loaded: LoadedConfig) {
  const repos = await store.listRepositories(loaded.workspace.id);
  const creds = await loadCredentials(loaded.dataDir);
  const githubAuth = await loadGitHubAuth();
  const jiraConfigured = Boolean(
    (process.env.JIRA_BASE_URL ?? creds.jiraBaseUrl) &&
    (process.env.JIRA_EMAIL ?? creds.jiraEmail) &&
    (process.env.JIRA_API_TOKEN ?? creds.jiraApiToken)
  );
  const githubConfigured = Boolean(githubAuth);
  return {
    workspaceName: loaded.config.workspaceName ?? loaded.workspace.name,
    jiraConfigured,
    githubConfigured,
    repos: await Promise.all(repos.map(async (repo) => {
      const [repoMemory, prNodes, jiraNodes] = await Promise.all([
        store.getRepoMemory(repo.id),
        store.findNodes({ repoId: repo.id, type: "pull_request", limit: 9999 }),
        store.findNodes({ repoId: repo.id, type: "jira_ticket", limit: 9999 })
      ]);
      return {
        name: repo.name,
        path: repo.path,
        indexStatus: repo.indexStatus ?? "unindexed",
        lastIndexedAt: repo.lastIndexedAt,
        indexedFiles: repoMemory?.indexedFiles ?? 0,
        indexedCommits: repoMemory?.indexedCommits ?? 0,
        indexedJiraIssues: jiraNodes.filter(n => n.properties.fetchedFromJiraCloud === true).length,
        indexedPullRequests: prNodes.length,
        indexedReviewComments: 0,
        warnings: repo.warnings ?? []
      };
    }))
  };
}

// ── Repo detail ───────────────────────────────────────────────────────────────

async function getRepoDetail(store: MemoryStore, loaded: LoadedConfig, name: string) {
  const repo = await store.getRepositoryByName(loaded.workspace.id, name);
  if (!repo) throw new Error(`Repository "${name}" not found`);

  const [fileMemories, repoMemory, run, prNodes, jiraNodes, patternMemories] = await Promise.all([
    store.listFileMemories(repo.id),
    store.getRepoMemory(repo.id),
    store.getLatestIndexRun(repo.id),
    store.findNodes({ repoId: repo.id, type: "pull_request", limit: 9999 }),
    store.findNodes({ repoId: repo.id, type: "jira_ticket", limit: 9999 }),
    store.findMemories({ repoId: repo.id, type: "review-pattern", limit: 200 })
  ]);

  const jiraKeyCounts = new Map<string, number>();
  for (const f of fileMemories) {
    for (const key of f.relatedJiraKeys) {
      jiraKeyCounts.set(key, (jiraKeyCounts.get(key) ?? 0) + 1);
    }
  }
  const topJiraKeys = [...jiraKeyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key]) => key);

  const fetchedJiraNodes = jiraNodes.filter(n => n.properties.fetchedFromJiraCloud === true);
  const summaryBlocks = buildSummaryBlocks({ repoName: repo.name, fileMemories, prNodes, fetchedJiraNodes, patternMemories, indexedCommits: repoMemory?.indexedCommits ?? run?.indexedCommits ?? 0 });

  return {
    name: repo.name,
    path: repo.path,
    indexStatus: repo.indexStatus ?? "unindexed",
    lastIndexedAt: repo.lastIndexedAt,
    summaryBlocks,
    indexedFiles: repoMemory?.indexedFiles ?? fileMemories.length,
    indexedCommits: repoMemory?.indexedCommits ?? run?.indexedCommits ?? 0,
    indexedPullRequests: prNodes.length,
    indexedJiraIssues: fetchedJiraNodes.length,
    highRiskFiles: repoMemory?.highRiskFiles ?? [],
    topJiraKeys,
    warnings: repoMemory?.warnings ?? repo.warnings ?? [],
    fileMemories: fileMemories.map(f => ({
      filePath: f.filePath,
      riskLevel: f.riskLevel,
      summary: f.summary,
      relatedJiraKeys: f.relatedJiraKeys,
      likelyTests: f.likelyTests,
      commitCount: f.recentCommits.length
    }))
  };
}

// ── Summary blocks ────────────────────────────────────────────────────────────

interface MemoryNode { id: string; title?: string; body?: string; properties: Record<string, unknown> }

export interface SummaryBlock { label: string; items: string[] }

function buildSummaryBlocks(input: {
  repoName: string;
  fileMemories: import("../domain/types.js").FileMemory[];
  prNodes: MemoryNode[];
  fetchedJiraNodes: MemoryNode[];
  patternMemories: import("../domain/types.js").Memory[];
  indexedCommits: number;
}): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];

  const hotFiles = input.fileMemories
    .filter(f => (f.riskLevel === "high" || f.riskLevel === "critical") && /\.(java|ts|tsx|js|jsx|py|go|kt|rb|cs|scala)$/.test(f.filePath) && !/\/(config|configuration)\//i.test(f.filePath))
    .sort((a, b) => b.recentCommits.length - a.recentCommits.length)
    .slice(0, 6)
    .map(f => f.filePath.replace(/^.*\/src\/main\/java\//, "").replace(/^.*\/src\//, ""));
  if (hotFiles.length > 0) blocks.push({ label: "Hot files", items: hotFiles });

  const seen = new Set<string>();
  const prTitles = input.prNodes
    .filter(n => n.properties.mergedAt)
    .map(n => (n.title ?? "").replace(/^#\d+:\s*/, "").replace(/,?\s*[A-Z][A-Z0-9]+-\d+/g, "").replace(/\s+/g, " ").trim())
    .filter(t => { if (!t || t.length < 4 || seen.has(t)) return false; seen.add(t); return true; })
    .slice(0, 6);
  if (prTitles.length > 0) blocks.push({ label: "Recent PRs", items: prTitles });

  const jiraItems = input.fetchedJiraNodes
    .map(n => { const key = String(n.properties.key ?? n.id); const title = (n.title ?? "").replace(/^[A-Z]+-\d+:\s*/, "").trim(); return title ? `${key}: ${title}` : key; })
    .filter(t => t.length > 0).slice(0, 6);
  if (jiraItems.length > 0) blocks.push({ label: "Jira tickets", items: jiraItems });

  const patternSeen = new Set<string>();
  const patterns = input.patternMemories
    .map(m => m.summary)
    .filter(s => { if (!s || patternSeen.has(s)) return false; patternSeen.add(s); return true; })
    .slice(0, 4);
  if (patterns.length > 0) blocks.push({ label: "Recurring review themes", items: patterns });

  return blocks;
}

// ── Static file server ────────────────────────────────────────────────────────

function serveStatic(res: http.ServerResponse, pathname: string, staticDir: string): void {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(staticDir, safePath.replace(/\.\./g, ""));
  const ext = path.extname(filePath);
  const mime = MIME[ext] ?? "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(staticDir, "index.html"), (err2, html) => {
        if (err2) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

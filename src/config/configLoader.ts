import fs from "node:fs/promises";
import path from "node:path";
import type { Repository, Workspace } from "../domain/types.js";
import { repoId, workspaceId } from "../utils/ids.js";
import { displayPath, resolveFrom } from "../utils/paths.js";
import { nowIso } from "../utils/time.js";

export interface SuvaduRepositoryConfig {
  name: string;
  path: string;
  github?: {
    host?: string;
    owner: string;
    repo: string;
  };
}

export interface SuvaduConfig {
  workspaceName: string;
  repositories: SuvaduRepositoryConfig[];
  jira?: {
    baseUrl?: string;
    projectKeys?: string[];
  };
  indexing: {
    maxCommits: number;
    maxPullRequests: number;
    includeReviewComments: boolean;
    includeAdrs: boolean;
    adrPaths: string[];
  };
  embeddings: {
    enabled: boolean;
    provider: string;
    model?: string;
  };
}

export interface LoadedConfig {
  config: SuvaduConfig;
  workspaceRoot: string;
  configPath: string;
  dataDir: string;
  dbPath: string;
  workspace: Workspace;
}

export const CONFIG_FILE = ".suvadu.json";
export const DATA_DIR = ".suvadu";
export const DB_FILE = "suvadu.sqlite";

export function defaultConfig(workspaceName = "default"): SuvaduConfig {
  return {
    workspaceName,
    repositories: [],
    indexing: {
      maxCommits: 1000,
      maxPullRequests: 200,
      includeReviewComments: true,
      includeAdrs: false,
      adrPaths: ["docs/adr", "docs/adrs", "architecture/decisions"]
    },
    embeddings: {
      enabled: false,
      provider: "local"
    }
  };
}

export async function initWorkspace(cwd: string, workspaceName = "default"): Promise<LoadedConfig> {
  const configPath = path.join(cwd, CONFIG_FILE);
  const dataDir = path.join(cwd, DATA_DIR);
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(`${configPath}`, `${JSON.stringify(defaultConfig(workspaceName), null, 2)}\n`, "utf8");
  }

  await ensureGitignore(cwd);
  return loadConfig(cwd);
}

export async function loadConfig(startDir: string): Promise<LoadedConfig> {
  const workspaceRoot = await findWorkspaceRoot(startDir);
  if (!workspaceRoot) {
    throw new Error(`No ${CONFIG_FILE} found. Run "suvadu init" first.`);
  }
  const configPath = path.join(workspaceRoot, CONFIG_FILE);
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<SuvaduConfig>;
  const config = normalizeConfig(parsed);
  const dataDir = path.join(workspaceRoot, DATA_DIR);
  const now = nowIso();
  return {
    config,
    workspaceRoot,
    configPath,
    dataDir,
    dbPath: path.join(dataDir, DB_FILE),
    workspace: {
      id: workspaceId(config.workspaceName),
      name: config.workspaceName,
      rootPath: workspaceRoot,
      createdAt: now,
      updatedAt: now
    }
  };
}

export async function saveConfig(loaded: LoadedConfig, config: SuvaduConfig): Promise<void> {
  await fs.writeFile(loaded.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function repositoryFromConfig(loaded: LoadedConfig, repository: SuvaduRepositoryConfig): Repository {
  const absolutePath = resolveFrom(loaded.workspaceRoot, repository.path);
  const now = nowIso();
  return {
    id: repoId(repository.name),
    workspaceId: loaded.workspace.id,
    name: repository.name,
    path: repository.path,
    absolutePath,
    createdAt: now,
    updatedAt: now,
    indexStatus: "unindexed",
    warnings: []
  };
}

export function makeRepositoryConfig(workspaceRoot: string, name: string, repoPath: string): SuvaduRepositoryConfig {
  const absolutePath = path.resolve(repoPath);
  return {
    name,
    path: displayPath(workspaceRoot, absolutePath)
  };
}

async function findWorkspaceRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    try {
      await fs.access(path.join(current, CONFIG_FILE));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

function normalizeConfig(input: Partial<SuvaduConfig>): SuvaduConfig {
  const base = defaultConfig(input.workspaceName ?? "default");
  return {
    workspaceName: input.workspaceName ?? base.workspaceName,
    repositories: Array.isArray(input.repositories)
      ? input.repositories.filter((repo): repo is SuvaduRepositoryConfig => Boolean(repo?.name && repo?.path))
      : [],
    jira: input.jira,
    indexing: {
      ...base.indexing,
      ...(input.indexing ?? {})
    },
    embeddings: {
      ...base.embeddings,
      ...(input.embeddings ?? {})
    }
  };
}

async function ensureGitignore(workspaceRoot: string): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  const required = [".suvadu/", ".suvadu/*.sqlite", ".suvadu/*.sqlite-*"];
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch {
    // Create one below.
  }
  const lines = new Set(existing.split(/\r?\n/).filter(Boolean));
  let changed = false;
  for (const entry of required) {
    if (!lines.has(entry)) {
      lines.add(entry);
      changed = true;
    }
  }
  if (changed || existing.length === 0) {
    await fs.writeFile(gitignorePath, `${[...lines].join("\n")}\n`, "utf8");
  }
}

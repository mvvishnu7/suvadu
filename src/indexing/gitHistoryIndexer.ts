import type { CommitSummary, MemoryNode, MemoryRelationship, Repository } from "../domain/types.js";
import type { MemoryStore } from "../storage/MemoryStore.js";
import { runGit } from "../utils/git.js";
import { commitNodeId, fileNodeId, jiraNodeId, relationshipId } from "../utils/ids.js";
import { detectJiraKeys } from "../utils/jiraKeyDetector.js";
import { normalizeRepoFilePath } from "../utils/paths.js";
import { redactSecrets } from "../utils/secretRedactor.js";
import { nowIso } from "../utils/time.js";

export interface FileHistoryStats {
  filePath: string;
  commitCount: number;
  authors: Set<string>;
  recentCommits: CommitSummary[];
  jiraKeys: Set<string>;
  coChanged: Map<string, number>;
}

export interface GitHistoryResult {
  indexedCommits: number;
  fileStats: Map<string, FileHistoryStats>;
}

interface ParsedCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
  changedFiles: string[];
  jiraKeys: string[];
}

export async function indexGitHistory(
  store: MemoryStore,
  repository: Repository,
  indexedFiles: string[],
  options: { maxCommits: number; jiraProjectKeys?: string[] }
): Promise<GitHistoryResult> {
  const indexedFileSet = new Set(indexedFiles);
  const stats = new Map<string, FileHistoryStats>();
  for (const filePath of indexedFiles) {
    stats.set(filePath, {
      filePath,
      commitCount: 0,
      authors: new Set(),
      recentCommits: [],
      jiraKeys: new Set(),
      coChanged: new Map()
    });
  }

  const commits = await readCommits(repository.absolutePath, options.maxCommits, options.jiraProjectKeys);
  const now = nowIso();

  for (const commit of commits) {
    const relevantFiles = commit.changedFiles.filter((filePath) => indexedFileSet.has(filePath));
    if (relevantFiles.length === 0) {
      continue;
    }

    const commitNode: MemoryNode = {
      id: commitNodeId(repository.name, commit.hash),
      type: "commit",
      workspaceId: repository.workspaceId,
      repoId: repository.id,
      key: commit.hash,
      title: commit.message,
      body: commit.message,
      properties: {
        hash: commit.hash,
        author: commit.author,
        date: commit.date,
        changedFiles: relevantFiles,
        jiraKeys: commit.jiraKeys
      },
      source: {
        type: "commit",
        id: commit.hash,
        repo: repository.name,
        title: commit.message,
        reason: "Indexed from local git history"
      },
      createdAt: now,
      updatedAt: now
    };
    await store.upsertNode(commitNode);

    for (const filePath of relevantFiles) {
      const fileStats = stats.get(filePath);
      if (!fileStats) {
        continue;
      }
      fileStats.commitCount += 1;
      fileStats.authors.add(commit.author);
      for (const key of commit.jiraKeys) {
        fileStats.jiraKeys.add(key);
      }
      if (fileStats.recentCommits.length < 12) {
        fileStats.recentCommits.push({
          hash: commit.hash,
          shortHash: commit.hash.slice(0, 8),
          message: commit.message,
          author: commit.author,
          date: commit.date,
          changedFiles: relevantFiles,
          jiraKeys: commit.jiraKeys
        });
      }

      const relationship: MemoryRelationship = {
        id: relationshipId("TOUCHED", commitNode.id, fileNodeId(repository.name, filePath)),
        type: "TOUCHED",
        fromNodeId: commitNode.id,
        toNodeId: fileNodeId(repository.name, filePath),
        workspaceId: repository.workspaceId,
        repoId: repository.id,
        confidence: 1,
        evidence: [
          {
            type: "commit",
            id: commit.hash,
            summary: commit.message,
            source: {
              type: "commit",
              id: commit.hash,
              repo: repository.name,
              title: commit.message
            }
          }
        ],
        properties: {
          date: commit.date,
          author: commit.author
        },
        createdAt: now
      };
      await store.upsertRelationship(relationship);
    }

    for (const jiraKey of commit.jiraKeys) {
      const jiraNode: MemoryNode = {
        id: jiraNodeId(jiraKey),
        type: "jira_ticket",
        workspaceId: repository.workspaceId,
        repoId: repository.id,
        key: jiraKey,
        title: jiraKey,
        body: `Jira key ${jiraKey} mentioned in local git history. Ticket body is not indexed in Phase 1.`,
        properties: {
          key: jiraKey
        },
        source: {
          type: "jira",
          id: jiraKey,
          repo: repository.name,
          reason: "Detected in commit message"
        },
        createdAt: now,
        updatedAt: now
      };
      await store.upsertNode(jiraNode);
      await store.upsertRelationship({
        id: relationshipId("MENTIONS", commitNode.id, jiraNode.id),
        type: "MENTIONS",
        fromNodeId: commitNode.id,
        toNodeId: jiraNode.id,
        workspaceId: repository.workspaceId,
        repoId: repository.id,
        confidence: 0.8,
        evidence: [
          {
            type: "commit",
            id: commit.hash,
            summary: `Commit message mentions ${jiraKey}`,
            source: {
              type: "commit",
              id: commit.hash,
              repo: repository.name,
              title: commit.message
            }
          }
        ],
        properties: {},
        createdAt: now
      });
    }

    addCoChangedPairs(stats, relevantFiles);
  }

  await saveCoChangedRelationships(store, repository, stats);
  return {
    indexedCommits: commits.filter((commit) => commit.changedFiles.some((file) => indexedFileSet.has(file))).length,
    fileStats: stats
  };
}

async function readCommits(repoPath: string, maxCommits: number, jiraProjectKeys?: string[]): Promise<ParsedCommit[]> {
  let output = "";
  try {
    output = await runGit(repoPath, ["log", `--max-count=${maxCommits}`, "--name-only", "--pretty=format:%x1e%H%x1f%an%x1f%aI%x1f%s"], {
      maxBuffer: 50 * 1024 * 1024
    });
  } catch {
    return [];
  }
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => parseCommitRecord(record, jiraProjectKeys))
    .filter((commit): commit is ParsedCommit => commit !== null);
}

function parseCommitRecord(record: string, jiraProjectKeys?: string[]): ParsedCommit | null {
  const lines = record.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = lines.shift();
  if (!header) {
    return null;
  }
  const [hash, author, date, rawMessage] = header.split("\x1f");
  if (!hash || !date) {
    return null;
  }
  const message = redactSecrets(rawMessage ?? "");
  return {
    hash,
    author: redactSecrets(author ?? "unknown"),
    date,
    message,
    changedFiles: lines.map(normalizeRepoFilePath).filter(Boolean),
    jiraKeys: detectJiraKeys(message, jiraProjectKeys)
  };
}

function addCoChangedPairs(stats: Map<string, FileHistoryStats>, files: string[]): void {
  const capped = files.slice(0, 80);
  for (let i = 0; i < capped.length; i += 1) {
    for (let j = i + 1; j < capped.length; j += 1) {
      const a = stats.get(capped[i]);
      const b = stats.get(capped[j]);
      if (!a || !b) {
        continue;
      }
      a.coChanged.set(capped[j], (a.coChanged.get(capped[j]) ?? 0) + 1);
      b.coChanged.set(capped[i], (b.coChanged.get(capped[i]) ?? 0) + 1);
    }
  }
}

async function saveCoChangedRelationships(
  store: MemoryStore,
  repository: Repository,
  stats: Map<string, FileHistoryStats>
): Promise<void> {
  const now = nowIso();
  for (const fileStats of stats.values()) {
    for (const [otherPath, count] of fileStats.coChanged.entries()) {
      if (count < 2) {
        continue;
      }
      const fromNodeId = fileNodeId(repository.name, fileStats.filePath);
      const toNodeId = fileNodeId(repository.name, otherPath);
      await store.upsertRelationship({
        id: relationshipId("CHANGED_WITH", fromNodeId, toNodeId),
        type: "CHANGED_WITH",
        fromNodeId,
        toNodeId,
        workspaceId: repository.workspaceId,
        repoId: repository.id,
        confidence: Math.min(1, 0.3 + count / 10),
        evidence: [
          {
            type: "relationship",
            id: `${fileStats.filePath}<->${otherPath}`,
            summary: `Changed together in ${count} indexed commits`
          }
        ],
        properties: {
          count
        },
        createdAt: now
      });
    }
  }
}

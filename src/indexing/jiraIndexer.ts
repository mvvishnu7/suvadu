import type { MemoryNode, MemoryRelationship, Repository } from "../domain/types.js";
import type { MemoryStore } from "../storage/MemoryStore.js";
import { commitNodeId, jiraCommentNodeId, jiraNodeId, relationshipId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import type { GitHistoryResult } from "./gitHistoryIndexer.js";
import type { JiraCloudClient, JiraCloudComment, JiraCloudIssue } from "./jiraCloudClient.js";

export interface JiraIndexResult {
  fetchedIssues: number;
  fetchedComments: number;
  missingIssues: string[];
  warnings: string[];
}

export async function indexJiraIssues(
  store: MemoryStore,
  repository: Repository,
  history: GitHistoryResult,
  client: JiraCloudClient,
  options: { maxIssues?: number; extraKeys?: string[]; skipExistingKeys?: boolean } = {}
): Promise<JiraIndexResult> {
  const keys = [...new Set([...collectJiraKeys(history), ...(options.extraKeys ?? [])])].sort().slice(0, options.maxIssues ?? 200);
  const warnings: string[] = [];
  const missingIssues: string[] = [];
  let fetchedIssues = 0;
  let fetchedComments = 0;

  for (const key of keys) {
    try {
      if (options.skipExistingKeys) {
        const existing = await store.getNode(jiraNodeId(key));
        if (existing?.properties.fetchedFromJiraCloud === true) {
          fetchedIssues += 1;
          continue;
        }
      }
      const issue = await client.getIssue(key);
      if (!issue) {
        missingIssues.push(key);
        continue;
      }
      await saveJiraIssue(store, repository, issue, history);
      fetchedIssues += 1;
      const comments = await client.getIssueComments(key);
      for (const comment of comments) {
        await saveJiraComment(store, repository, issue, comment);
      }
      fetchedComments += comments.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not fetch Jira issue ${key}: ${message}`);
    }
  }

  return {
    fetchedIssues,
    fetchedComments,
    missingIssues,
    warnings
  };
}

function collectJiraKeys(history: GitHistoryResult): string[] {
  const keys = new Set<string>();
  for (const stats of history.fileStats.values()) {
    for (const key of stats.jiraKeys) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

async function saveJiraComment(
  store: MemoryStore,
  repository: Repository,
  issue: JiraCloudIssue,
  comment: JiraCloudComment
): Promise<void> {
  const now = nowIso();
  const nodeId = jiraCommentNodeId(issue.key, comment.id);
  const node: MemoryNode = {
    id: nodeId,
    type: "jira_comment",
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    key: `${issue.key}:${comment.id}`,
    title: `${issue.key} comment by ${comment.author}`,
    body: comment.body,
    properties: {
      id: comment.id,
      issueKey: issue.key,
      author: comment.author,
      created: comment.created,
      updated: comment.updated
    },
    source: {
      type: "jira",
      id: `${issue.key}#${comment.id}`,
      repo: repository.name,
      url: issue.url,
      title: `${issue.key} comment`,
      reason: "Fetched from Jira Cloud issue comments"
    },
    createdAt: now,
    updatedAt: now
  };
  await store.upsertNode(node);
  await store.upsertRelationship({
    id: relationshipId("HAS_COMMENT", jiraNodeId(issue.key), nodeId),
    type: "HAS_COMMENT",
    fromNodeId: jiraNodeId(issue.key),
    toNodeId: nodeId,
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    confidence: 1,
    evidence: [
      {
        type: "jira",
        id: `${issue.key}#${comment.id}`,
        summary: `Comment on ${issue.key} by ${comment.author}`,
        source: node.source
      }
    ],
    properties: { issueKey: issue.key },
    createdAt: now
  });
}

async function saveJiraIssue(
  store: MemoryStore,
  repository: Repository,
  issue: JiraCloudIssue,
  history: GitHistoryResult
): Promise<void> {
  const now = nowIso();
  const jiraNode: MemoryNode = {
    id: jiraNodeId(issue.key),
    type: "jira_ticket",
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    key: issue.key,
    title: `${issue.key}: ${issue.title}`,
    body: issue.description || issue.title,
    properties: {
      key: issue.key,
      status: issue.status,
      issueType: issue.issueType,
      updated: issue.updated,
      fetchedFromJiraCloud: true
    },
    source: {
      type: "jira",
      id: issue.key,
      repo: repository.name,
      url: issue.url,
      title: issue.title,
      reason: "Fetched from Jira Cloud because local git history referenced this key"
    },
    createdAt: now,
    updatedAt: now
  };
  await store.upsertNode(jiraNode);

  for (const stats of history.fileStats.values()) {
    if (!stats.jiraKeys.has(issue.key)) {
      continue;
    }
    for (const commit of stats.recentCommits.filter((item) => item.jiraKeys?.includes(issue.key))) {
      const fromNodeId = commitNodeId(repository.name, commit.hash);
      const relationship: MemoryRelationship = {
        id: relationshipId("EXPLAINS", jiraNode.id, fromNodeId),
        type: "EXPLAINS",
        fromNodeId: jiraNode.id,
        toNodeId: fromNodeId,
        workspaceId: repository.workspaceId,
        repoId: repository.id,
        confidence: 0.85,
        evidence: [
          {
            type: "jira",
            id: issue.key,
            summary: `Jira issue ${issue.key} was fetched after commit ${commit.shortHash} mentioned it.`,
            source: {
              type: "jira",
              id: issue.key,
              repo: repository.name,
              url: issue.url,
              title: issue.title
            }
          }
        ],
        properties: {
          jiraKey: issue.key,
          commit: commit.hash
        },
        createdAt: now
      };
      await store.upsertRelationship(relationship);
    }
  }
}

import type { MemoryNode, MemoryRelationship, Repository } from "../domain/types.js";
import type { MemoryStore } from "../storage/MemoryStore.js";
import { commitNodeId, fileNodeId, issueCommentNodeId, jiraNodeId, pullRequestNodeId, relationshipId, reviewCommentNodeId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import type { GitHistoryResult } from "./gitHistoryIndexer.js";
import type { GitHubClient, GitHubIssueComment, GitHubPullRequest, GitHubRepositoryConfig, GitHubReviewComment } from "./githubClient.js";
import { buildReviewPatternMemory } from "./reviewPatternGenerator.js";

export interface GitHubIndexResult {
  indexedPullRequests: number;
  indexedReviewComments: number;
  indexedIssueComments: number;
  jiraKeys: string[];
  warnings: string[];
}

export async function indexGitHubPullRequests(
  store: MemoryStore,
  repository: Repository,
  githubRepository: GitHubRepositoryConfig,
  client: GitHubClient,
  history: GitHistoryResult,
  options: { maxPullRequests: number; jiraProjectKeys?: string[]; includeReviewComments?: boolean; since?: string }
): Promise<GitHubIndexResult> {
  const warnings: string[] = [];
  try {
    const pulls = await client.listClosedPullRequests(githubRepository, { ...options, since: options.since });
    const jiraKeys = new Set<string>();
    let indexedReviewComments = 0;
    let indexedIssueComments = 0;
    for (const pull of pulls) {
      for (const key of pull.jiraKeys) {
        jiraKeys.add(key);
      }
      for (const comment of pull.reviewComments) {
        for (const key of comment.jiraKeys) {
          jiraKeys.add(key);
        }
      }
      for (const comment of pull.issueComments) {
        for (const key of comment.jiraKeys) {
          jiraKeys.add(key);
        }
      }
      await savePullRequest(store, repository, pull, history);
      indexedReviewComments += pull.reviewComments.length;
      indexedIssueComments += pull.issueComments.length;
    }
    return {
      indexedPullRequests: pulls.length,
      indexedReviewComments,
      indexedIssueComments,
      jiraKeys: [...jiraKeys].sort(),
      warnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`GitHub PR enrichment skipped: ${message}`);
    return {
      indexedPullRequests: 0,
      indexedReviewComments: 0,
      indexedIssueComments: 0,
      jiraKeys: [],
      warnings
    };
  }
}

async function savePullRequest(
  store: MemoryStore,
  repository: Repository,
  pull: GitHubPullRequest,
  history: GitHistoryResult
): Promise<void> {
  const now = nowIso();
  const prNodeId = pullRequestNodeId(repository.name, pull.number);
  const node: MemoryNode = {
    id: prNodeId,
    type: "pull_request",
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    key: String(pull.number),
    title: `#${pull.number}: ${pull.title}`,
    body: pull.body,
    properties: {
      number: pull.number,
      author: pull.author,
      state: pull.state,
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
      mergedAt: pull.mergedAt,
      mergeCommitSha: pull.mergeCommitSha,
      changedFiles: pull.changedFiles,
      jiraKeys: pull.jiraKeys,
      reviewCommentCount: pull.reviewComments.length
    },
    source: {
      type: "pull_request",
      id: `#${pull.number}`,
      repo: repository.name,
      url: pull.url,
      title: pull.title,
      reason: "Fetched from configured GitHub repository"
    },
    createdAt: now,
    updatedAt: now
  };
  await store.upsertNode(node);

  for (const filePath of pull.changedFiles) {
    await store.upsertRelationship({
      id: relationshipId("TOUCHED", prNodeId, fileNodeId(repository.name, filePath)),
      type: "TOUCHED",
      fromNodeId: prNodeId,
      toNodeId: fileNodeId(repository.name, filePath),
      workspaceId: repository.workspaceId,
      repoId: repository.id,
      confidence: 1,
      evidence: [
        {
          type: "pull_request",
          id: `#${pull.number}`,
          summary: `PR #${pull.number} changed ${filePath}`,
          source: node.source
        }
      ],
      properties: {
        number: pull.number
      },
      createdAt: now
    });
  }

  for (const key of pull.jiraKeys) {
    await ensureJiraPlaceholder(store, repository, key, pull, now);
    await store.upsertRelationship({
      id: relationshipId("MENTIONS", prNodeId, jiraNodeId(key)),
      type: "MENTIONS",
      fromNodeId: prNodeId,
      toNodeId: jiraNodeId(key),
      workspaceId: repository.workspaceId,
      repoId: repository.id,
      confidence: 0.85,
      evidence: [
        {
          type: "pull_request",
          id: `#${pull.number}`,
          summary: `PR #${pull.number} mentions ${key}`,
          source: node.source
        }
      ],
      properties: {
        jiraKey: key
      },
      createdAt: now
    });
  }

  if (pull.mergeCommitSha && commitExistsInIndexedHistory(history, pull.mergeCommitSha)) {
    await store.upsertRelationship({
      id: relationshipId("LINKS_TO", prNodeId, commitNodeId(repository.name, pull.mergeCommitSha)),
      type: "LINKS_TO",
      fromNodeId: prNodeId,
      toNodeId: commitNodeId(repository.name, pull.mergeCommitSha),
      workspaceId: repository.workspaceId,
      repoId: repository.id,
      confidence: 0.9,
      evidence: [
        {
          type: "pull_request",
          id: `#${pull.number}`,
          summary: `PR #${pull.number} merge commit is ${pull.mergeCommitSha}`,
          source: node.source
        }
      ],
      properties: {},
      createdAt: now
    });
  }

  for (const comment of pull.reviewComments) {
    await saveReviewComment(store, repository, pull, comment, now);
  }
  for (const comment of pull.issueComments) {
    await saveIssueComment(store, repository, pull, comment, now);
  }
}

async function saveReviewComment(
  store: MemoryStore,
  repository: Repository,
  pull: GitHubPullRequest,
  comment: GitHubReviewComment,
  now: string
): Promise<void> {
  const commentNodeId = reviewCommentNodeId(repository.name, pull.number, comment.id);
  const source = {
    type: "review_comment" as const,
    id: `#${pull.number} comment ${comment.id}`,
    repo: repository.name,
    path: comment.path,
    url: comment.url,
    title: `PR #${pull.number} review comment`,
    reason: "Fetched from configured GitHub repository"
  };
  const node: MemoryNode = {
    id: commentNodeId,
    type: "review_comment",
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    key: `${pull.number}:${comment.id}`,
    title: `PR #${pull.number} review comment${comment.path ? ` on ${comment.path}` : ""}`,
    body: comment.body,
    properties: {
      id: comment.id,
      pullRequestNumber: pull.number,
      author: comment.author,
      path: comment.path,
      line: comment.line,
      originalLine: comment.originalLine,
      position: comment.position,
      diffHunk: comment.diffHunk,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      jiraKeys: comment.jiraKeys
    },
    source,
    createdAt: now,
    updatedAt: now
  };
  await store.upsertNode(node);
  const patternMemory = buildReviewPatternMemory({
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    repoName: repository.name,
    pullRequestNumber: pull.number,
    comment,
    source
  });
  if (patternMemory) {
    await store.upsertMemory(patternMemory);
    await store.linkMemoryToEvidence(patternMemory.id, [
      {
        type: "review_comment",
        id: source.id,
        summary: patternMemory.summary,
        source
      }
    ]);
  }

  await store.upsertRelationship({
    id: relationshipId("LINKS_TO", commentNodeId, pullRequestNodeId(repository.name, pull.number)),
    type: "LINKS_TO",
    fromNodeId: commentNodeId,
    toNodeId: pullRequestNodeId(repository.name, pull.number),
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    confidence: 1,
    evidence: [
      {
        type: "review_comment",
        id: source.id,
        summary: `Review comment ${comment.id} belongs to PR #${pull.number}`,
        source
      }
    ],
    properties: {
      pullRequestNumber: pull.number
    },
    createdAt: now
  });

  if (comment.path) {
    await store.upsertRelationship({
      id: relationshipId("APPLIES_TO", commentNodeId, fileNodeId(repository.name, comment.path)),
      type: "APPLIES_TO",
      fromNodeId: commentNodeId,
      toNodeId: fileNodeId(repository.name, comment.path),
      workspaceId: repository.workspaceId,
      repoId: repository.id,
      confidence: 0.9,
      evidence: [
        {
          type: "review_comment",
          id: source.id,
          summary: `Review comment ${comment.id} applies to ${comment.path}`,
          source
        }
      ],
      properties: {
        pullRequestNumber: pull.number,
        line: comment.line,
        originalLine: comment.originalLine
      },
      createdAt: now
    });
  }

  for (const key of comment.jiraKeys) {
    await ensureJiraPlaceholderFromReviewComment(store, repository, key, pull, comment, now);
    await store.upsertRelationship({
      id: relationshipId("MENTIONS", commentNodeId, jiraNodeId(key)),
      type: "MENTIONS",
      fromNodeId: commentNodeId,
      toNodeId: jiraNodeId(key),
      workspaceId: repository.workspaceId,
      repoId: repository.id,
      confidence: 0.8,
      evidence: [
        {
          type: "review_comment",
          id: source.id,
          summary: `PR #${pull.number} review comment mentions ${key}`,
          source
        }
      ],
      properties: {
        jiraKey: key,
        pullRequestNumber: pull.number
      },
      createdAt: now
    });
  }
}

async function saveIssueComment(
  store: MemoryStore,
  repository: Repository,
  pull: GitHubPullRequest,
  comment: GitHubIssueComment,
  now: string
): Promise<void> {
  const commentNodeId = issueCommentNodeId(repository.name, pull.number, comment.id);
  const source = {
    type: "review_comment" as const,
    id: `#${pull.number} comment ${comment.id}`,
    repo: repository.name,
    url: comment.url,
    title: `PR #${pull.number} conversation comment`,
    reason: "Fetched from configured GitHub repository"
  };
  const node: MemoryNode = {
    id: commentNodeId,
    type: "review_comment",
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    key: `${pull.number}:issue:${comment.id}`,
    title: `PR #${pull.number} conversation comment`,
    body: comment.body,
    properties: {
      id: comment.id,
      pullRequestNumber: pull.number,
      author: comment.author,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      jiraKeys: comment.jiraKeys,
      isIssueComment: true
    },
    source,
    createdAt: now,
    updatedAt: now
  };
  await store.upsertNode(node);

  await store.upsertRelationship({
    id: relationshipId("LINKS_TO", commentNodeId, pullRequestNodeId(repository.name, pull.number)),
    type: "LINKS_TO",
    fromNodeId: commentNodeId,
    toNodeId: pullRequestNodeId(repository.name, pull.number),
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    confidence: 1,
    evidence: [
      {
        type: "review_comment",
        id: source.id,
        summary: `Conversation comment ${comment.id} belongs to PR #${pull.number}`,
        source
      }
    ],
    properties: {
      pullRequestNumber: pull.number
    },
    createdAt: now
  });

  for (const key of comment.jiraKeys) {
    await ensureJiraPlaceholder(store, repository, key, pull, now);
    await store.upsertRelationship({
      id: relationshipId("MENTIONS", commentNodeId, jiraNodeId(key)),
      type: "MENTIONS",
      fromNodeId: commentNodeId,
      toNodeId: jiraNodeId(key),
      workspaceId: repository.workspaceId,
      repoId: repository.id,
      confidence: 0.8,
      evidence: [
        {
          type: "review_comment",
          id: source.id,
          summary: `PR #${pull.number} conversation comment mentions ${key}`,
          source
        }
      ],
      properties: {
        jiraKey: key,
        pullRequestNumber: pull.number
      },
      createdAt: now
    });
  }
}

async function ensureJiraPlaceholder(
  store: MemoryStore,
  repository: Repository,
  key: string,
  pull: GitHubPullRequest,
  now: string
): Promise<void> {
  const existing = await store.getNode(jiraNodeId(key));
  if (existing?.properties.fetchedFromJiraCloud === true) {
    return;
  }
  await store.upsertNode({
    id: jiraNodeId(key),
    type: "jira_ticket",
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    key,
    title: key,
    body: `Jira key ${key} mentioned by PR #${pull.number}. Ticket body is available only when Jira Cloud enrichment is configured.`,
    properties: {
      key,
      detectedFromGitHubPullRequest: pull.number
    },
    source: {
      type: "jira",
      id: key,
      repo: repository.name,
      reason: `Detected in GitHub PR #${pull.number}`
    },
    createdAt: now,
    updatedAt: now
  });
}

async function ensureJiraPlaceholderFromReviewComment(
  store: MemoryStore,
  repository: Repository,
  key: string,
  pull: GitHubPullRequest,
  comment: GitHubReviewComment,
  now: string
): Promise<void> {
  const existing = await store.getNode(jiraNodeId(key));
  if (existing?.properties.fetchedFromJiraCloud === true) {
    return;
  }
  await store.upsertNode({
    id: jiraNodeId(key),
    type: "jira_ticket",
    workspaceId: repository.workspaceId,
    repoId: repository.id,
    key,
    title: key,
    body: `Jira key ${key} mentioned by a review comment on PR #${pull.number}. Ticket body is available only when Jira Cloud enrichment is configured.`,
    properties: {
      key,
      detectedFromGitHubPullRequest: pull.number,
      detectedFromGitHubReviewComment: comment.id
    },
    source: {
      type: "jira",
      id: key,
      repo: repository.name,
      reason: `Detected in GitHub PR #${pull.number} review comment ${comment.id}`
    },
    createdAt: now,
    updatedAt: now
  });
}

function commitExistsInIndexedHistory(history: GitHistoryResult, sha: string): boolean {
  for (const stats of history.fileStats.values()) {
    if (stats.recentCommits.some((commit) => commit.hash === sha)) {
      return true;
    }
  }
  return false;
}

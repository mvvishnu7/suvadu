import type { Repository } from "../domain/types.js";
import type { MemoryStore } from "../storage/MemoryStore.js";
import { indexRepositoryFiles } from "./fileScanner.js";
import { indexGitHistory } from "./gitHistoryIndexer.js";
import { GitHubClient, type GitHubRepositoryConfig } from "./githubClient.js";
import { indexGitHubPullRequests } from "./githubIndexer.js";
import { indexJiraIssues } from "./jiraIndexer.js";
import { JiraCloudClient } from "./jiraCloudClient.js";
import { buildFileMemories, buildRepoMemory } from "./riskScorer.js";
import { nowIso } from "../utils/time.js";
import type { JiraCloudEnv } from "../config/env.js";
import type { GitHubAuth } from "../config/githubAuth.js";

export interface RepoIndexOptions {
  maxCommits: number;
  maxPullRequests?: number;
  jiraProjectKeys?: string[];
  jiraCloud?: JiraCloudEnv | null;
  jiraConfigured?: boolean;
  missingJiraEnvVars?: string[];
  github?: GitHubRepositoryConfig;
  githubAuth?: GitHubAuth | null;
  includeReviewComments?: boolean;
  since?: string;
}

export interface RepoIndexResult {
  indexedFiles: number;
  indexedCommits: number;
  indexedJiraIssues: number;
  indexedJiraComments: number;
  indexedPullRequests: number;
  indexedReviewComments: number;
  indexedIssueComments: number;
  warnings: string[];
}

export async function indexRepository(
  store: MemoryStore,
  repository: Repository,
  options: RepoIndexOptions
): Promise<RepoIndexResult> {
  const run = await store.beginIndexRun(repository);
  try {
    if (!options.since) {
      await store.clearRepoIndexData(repository.id);
    }
    await store.upsertRepository({
      ...repository,
      indexStatus: "indexing",
      updatedAt: nowIso()
    });

    const fileScan = await indexRepositoryFiles(store, repository);
    const history = await indexGitHistory(
      store,
      repository,
      fileScan.files.map((file) => file.path),
      {
        maxCommits: options.maxCommits,
        jiraProjectKeys: options.jiraProjectKeys
      }
    );
    const warnings = [...fileScan.warnings];
    let indexedPullRequests = 0;
    let indexedReviewComments = 0;
    let indexedIssueComments = 0;
    let githubJiraKeys: string[] = [];
    if (options.github && options.githubAuth) {
      const githubResult = await indexGitHubPullRequests(
        store,
        repository,
        options.github,
        new GitHubClient({ host: options.github.host, token: options.githubAuth.token }),
        history,
        {
          maxPullRequests: options.maxPullRequests ?? 200,
          jiraProjectKeys: options.jiraProjectKeys,
          includeReviewComments: options.includeReviewComments ?? true,
          since: options.since
        }
      );
      indexedPullRequests = githubResult.indexedPullRequests;
      indexedReviewComments = githubResult.indexedReviewComments;
      indexedIssueComments = githubResult.indexedIssueComments;
      githubJiraKeys = githubResult.jiraKeys;
      warnings.push(...githubResult.warnings);
    } else if (options.github && !options.githubAuth) {
      warnings.push("GitHub PR enrichment skipped; missing gh auth token, GITHUB_TOKEN, or GH_TOKEN.");
    }

    let indexedJiraIssues = 0;
    let indexedJiraComments = 0;
    if (options.jiraCloud) {
      const jiraResult = await indexJiraIssues(
        store,
        repository,
        history,
        new JiraCloudClient(options.jiraCloud),
        { extraKeys: githubJiraKeys, skipExistingKeys: Boolean(options.since) }
      );
      indexedJiraIssues = jiraResult.fetchedIssues;
      indexedJiraComments = jiraResult.fetchedComments;
      warnings.push(...jiraResult.warnings);
      if (jiraResult.missingIssues.length > 0) {
        warnings.push(`Jira Cloud did not return issue${jiraResult.missingIssues.length === 1 ? "" : "s"}: ${jiraResult.missingIssues.join(", ")}`);
      }
    } else if (options.jiraConfigured && options.missingJiraEnvVars && options.missingJiraEnvVars.length > 0) {
      warnings.push(`Jira Cloud enrichment skipped; missing ${options.missingJiraEnvVars.join(", ")}.`);
    }

    const fileMemories = buildFileMemories(repository, fileScan.files, history);
    for (const fileMemory of fileMemories) {
      await store.saveFileMemory(fileMemory);
    }
    const repoMemory = buildRepoMemory(repository, fileMemories, history.indexedCommits, warnings);
    await store.saveRepoMemory(repoMemory);

    await store.completeIndexRun(run.id, {
      status: "completed",
      completedAt: nowIso(),
      indexedFiles: fileScan.files.length,
      indexedCommits: history.indexedCommits,
      warnings
    });
    return {
      indexedFiles: fileScan.files.length,
      indexedCommits: history.indexedCommits,
      indexedJiraIssues,
      indexedJiraComments,
      indexedPullRequests,
      indexedReviewComments,
      indexedIssueComments,
      warnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.completeIndexRun(run.id, {
      status: "failed",
      completedAt: nowIso(),
      warnings: [message],
      error: message
    });
    throw error;
  }
}

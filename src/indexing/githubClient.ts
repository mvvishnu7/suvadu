import { detectJiraKeys } from "../utils/jiraKeyDetector.js";
import { redactSecrets } from "../utils/secretRedactor.js";

export interface GitHubRepositoryConfig {
  host?: string;
  owner: string;
  repo: string;
}

export interface GitHubClientOptions {
  host?: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
  url: string;
  mergeCommitSha?: string;
  changedFiles: string[];
  jiraKeys: string[];
  reviewComments: GitHubReviewComment[];
  issueComments: GitHubIssueComment[];
}

export interface GitHubIssueComment {
  id: number;
  pullRequestNumber: number;
  body: string;
  author: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  jiraKeys: string[];
}

export interface GitHubReviewComment {
  id: number;
  pullRequestNumber: number;
  body: string;
  author: string;
  path?: string;
  line?: number;
  originalLine?: number;
  position?: number;
  diffHunk?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  jiraKeys: string[];
}

interface PullRequestResponse {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  user?: {
    login?: string;
  } | null;
}

interface PullRequestFileResponse {
  filename?: string;
}

interface IssueCommentResponse {
  id: number;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: {
    login?: string;
  } | null;
}

interface ReviewCommentResponse {
  id: number;
  body?: string | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  position?: number | null;
  diff_hunk?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: {
    login?: string;
  } | null;
}

export class GitHubClient {
  private readonly host: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubClientOptions) {
    this.host = options.host ?? "github.com";
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listClosedPullRequests(
    repository: GitHubRepositoryConfig,
    options: { maxPullRequests: number; jiraProjectKeys?: string[]; includeReviewComments?: boolean; since?: string }
  ): Promise<GitHubPullRequest[]> {
    const pulls: GitHubPullRequest[] = [];
    const perPage = Math.min(100, Math.max(1, options.maxPullRequests));
    let page = 1;
    let reachedSince = false;
    while (pulls.length < options.maxPullRequests && !reachedSince) {
      const url =
        `${this.apiBase()}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}` +
        `/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${page}`;
      const batch = (await this.request(url)) as PullRequestResponse[];
      if (batch.length === 0) {
        break;
      }
      for (const raw of batch) {
        if (pulls.length >= options.maxPullRequests) {
          break;
        }
        if (options.since && raw.updated_at && raw.updated_at <= options.since) {
          reachedSince = true;
          break;
        }
        const changedFiles = await this.listPullRequestFiles(repository, raw.number);
        const reviewComments = options.includeReviewComments === false
          ? []
          : await this.listPullRequestReviewComments(repository, raw.number, options.jiraProjectKeys);
        const issueComments = options.includeReviewComments === false
          ? []
          : await this.listPullRequestIssueComments(repository, raw.number, options.jiraProjectKeys);
        const title = redactSecrets(raw.title ?? `PR #${raw.number}`);
        const body = redactSecrets(raw.body ?? "");
        pulls.push({
          number: raw.number,
          title,
          body,
          author: redactSecrets(raw.user?.login ?? "unknown"),
          state: raw.state ?? "unknown",
          createdAt: raw.created_at,
          updatedAt: raw.updated_at,
          mergedAt: raw.merged_at ?? undefined,
          url: raw.html_url ?? `${this.webBase()}/${repository.owner}/${repository.repo}/pull/${raw.number}`,
          mergeCommitSha: raw.merge_commit_sha ?? undefined,
          changedFiles,
          jiraKeys: detectJiraKeys(`${title}\n${body}`, options.jiraProjectKeys),
          reviewComments,
          issueComments
        });
      }
      if (batch.length < perPage) {
        break;
      }
      page += 1;
    }
    return pulls;
  }

  private async listPullRequestFiles(repository: GitHubRepositoryConfig, number: number): Promise<string[]> {
    const files: string[] = [];
    let page = 1;
    while (true) {
      const url =
        `${this.apiBase()}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}` +
        `/pulls/${number}/files?per_page=100&page=${page}`;
      const batch = (await this.request(url)) as PullRequestFileResponse[];
      for (const item of batch) {
        if (item.filename) {
          files.push(item.filename);
        }
      }
      if (batch.length < 100) {
        break;
      }
      page += 1;
    }
    return files;
  }

  private async listPullRequestReviewComments(
    repository: GitHubRepositoryConfig,
    number: number,
    jiraProjectKeys?: string[]
  ): Promise<GitHubReviewComment[]> {
    const comments: GitHubReviewComment[] = [];
    let page = 1;
    while (true) {
      const url =
        `${this.apiBase()}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}` +
        `/pulls/${number}/comments?per_page=100&page=${page}`;
      const batch = (await this.request(url)) as ReviewCommentResponse[];
      for (const item of batch) {
        const body = redactSecrets(item.body ?? "");
        comments.push({
          id: item.id,
          pullRequestNumber: number,
          body,
          author: redactSecrets(item.user?.login ?? "unknown"),
          path: item.path ?? undefined,
          line: item.line ?? undefined,
          originalLine: item.original_line ?? undefined,
          position: item.position ?? undefined,
          diffHunk: item.diff_hunk ? redactSecrets(item.diff_hunk) : undefined,
          url: item.html_url,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          jiraKeys: detectJiraKeys(body, jiraProjectKeys)
        });
      }
      if (batch.length < 100) {
        break;
      }
      page += 1;
    }
    return comments;
  }

  private async listPullRequestIssueComments(
    repository: GitHubRepositoryConfig,
    number: number,
    jiraProjectKeys?: string[]
  ): Promise<GitHubIssueComment[]> {
    const comments: GitHubIssueComment[] = [];
    let page = 1;
    while (true) {
      const url =
        `${this.apiBase()}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}` +
        `/issues/${number}/comments?per_page=100&page=${page}`;
      const batch = (await this.request(url)) as IssueCommentResponse[];
      for (const item of batch) {
        const body = redactSecrets(item.body ?? "");
        if (!body.trim()) {
          continue;
        }
        comments.push({
          id: item.id,
          pullRequestNumber: number,
          body,
          author: redactSecrets(item.user?.login ?? "unknown"),
          url: item.html_url,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          jiraKeys: detectJiraKeys(body, jiraProjectKeys)
        });
      }
      if (batch.length < 100) {
        break;
      }
      page += 1;
    }
    return comments;
  }

  private async request(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "suvadu"
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}`);
    }
    return response.json();
  }

  private apiBase(): string {
    return this.host === "github.com" ? "https://api.github.com" : `https://${this.host}/api/v3`;
  }

  private webBase(): string {
    return `https://${this.host}`;
  }
}

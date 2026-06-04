import { redactSecrets } from "../utils/secretRedactor.js";

export interface JiraCloudClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

export interface JiraCloudIssue {
  key: string;
  title: string;
  description?: string;
  status?: string;
  issueType?: string;
  url: string;
  updated?: string;
}

export interface JiraCloudComment {
  id: string;
  body: string;
  author: string;
  created?: string;
  updated?: string;
}

interface JiraCommentResponse {
  id?: string;
  body?: unknown;
  created?: string;
  updated?: string;
  author?: {
    displayName?: string;
    emailAddress?: string;
  };
}

interface JiraCommentsPageResponse {
  comments?: JiraCommentResponse[];
  total?: number;
  maxResults?: number;
  startAt?: number;
}

interface JiraIssueResponse {
  key: string;
  self?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: {
      name?: string;
    };
    issuetype?: {
      name?: string;
    };
    updated?: string;
  };
}

export class JiraCloudClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JiraCloudClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getIssueComments(key: string, maxComments = 50, since?: string): Promise<JiraCloudComment[]> {
    const comments: JiraCloudComment[] = [];
    let startAt = 0;
    const maxResults = Math.min(50, maxComments);
    while (comments.length < maxComments) {
      const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=${maxResults}&orderBy=created`;
      const response = await this.fetchImpl(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json"
        }
      });
      if (!response.ok) {
        break;
      }
      const page = (await response.json()) as JiraCommentsPageResponse;
      const batch = page.comments ?? [];
      let reachedSince = false;
      for (const raw of batch) {
        if (!raw.id) {
          continue;
        }
        // Comments are ordered oldest-first; once we hit one older than `since` we can stop
        if (since && raw.created && raw.created <= since) {
          continue;
        }
        const body = redactSecrets(extractAdfText(raw.body).slice(0, 2000));
        if (!body.trim()) {
          continue;
        }
        comments.push({
          id: raw.id,
          body,
          author: redactSecrets(raw.author?.displayName ?? raw.author?.emailAddress ?? "unknown"),
          created: raw.created,
          updated: raw.updated
        });
        if (comments.length >= maxComments) {
          reachedSince = true;
          break;
        }
      }
      if (reachedSince || batch.length < maxResults || comments.length >= maxComments) {
        break;
      }
      startAt += batch.length;
    }
    return comments;
  }

  async getIssue(key: string): Promise<JiraCloudIssue | null> {
    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,updated`;
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json"
      }
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Jira Cloud returned ${response.status} for ${key}`);
    }
    const issue = (await response.json()) as JiraIssueResponse;
    return {
      key: issue.key,
      title: redactSecrets(issue.fields?.summary ?? issue.key),
      description: redactSecrets(extractAdfText(issue.fields?.description).slice(0, 4000)),
      status: issue.fields?.status?.name,
      issueType: issue.fields?.issuetype?.name,
      updated: issue.fields?.updated,
      url: `${this.baseUrl}/browse/${encodeURIComponent(issue.key)}`
    };
  }
}

export function extractAdfText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  const parts: string[] = [];
  walkAdf(value, parts);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function walkAdf(value: unknown, parts: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkAdf(item, parts);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    parts.push(record.text);
  }
  if (Array.isArray(record.content)) {
    walkAdf(record.content, parts);
  }
}

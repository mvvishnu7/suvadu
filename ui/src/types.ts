export interface RepoSummary {
  name: string;
  path: string;
  indexStatus: string;
  lastIndexedAt?: string;
  indexedFiles: number;
  indexedCommits: number;
  indexedJiraIssues: number;
  indexedPullRequests: number;
  indexedReviewComments: number;
  warnings: string[];
}

export interface WorkspaceStatus {
  workspaceName: string;
  jiraConfigured: boolean;
  githubConfigured: boolean;
  repos: RepoSummary[];
}

export interface AppSettings {
  jira: { baseUrl: string; email: string; configured: boolean };
  github: { configured: boolean; source: string | null; hasStoredToken: boolean };
}

export interface DoctorStatus {
  node: { version: string; ok: boolean; required: string; note: string | null };
  git: { ok: boolean; note: string | null };
  jira: { ok: boolean; note: string | null };
  github: { ok: boolean; source: string | null; note: string | null };
  mcp: { configPath: string; note: string };
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

export interface FileMemorySummary {
  filePath: string;
  riskLevel: string;
  summary: string;
  relatedJiraKeys: string[];
  likelyTests: string[];
  commitCount: number;
}

export interface SummaryBlock {
  label: string;
  items: string[];
}

export interface RepoDetail {
  name: string;
  path: string;
  indexStatus: string;
  lastIndexedAt?: string;
  summaryBlocks: SummaryBlock[];
  indexedFiles: number;
  indexedCommits: number;
  indexedPullRequests: number;
  indexedJiraIssues: number;
  highRiskFiles: string[];
  topJiraKeys: string[];
  warnings: string[];
  fileMemories: FileMemorySummary[];
}

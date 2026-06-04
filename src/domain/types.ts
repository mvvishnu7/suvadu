export type NodeType =
  | "workspace"
  | "repository"
  | "file"
  | "symbol"
  | "commit"
  | "pull_request"
  | "review_comment"
  | "jira_ticket"
  | "jira_comment"
  | "adr"
  | "document"
  | "memory"
  | "owner"
  | "library"
  | "domain_area";

export type RelationshipType =
  | "CONTAINS"
  | "TOUCHED"
  | "CHANGED_WITH"
  | "MENTIONS"
  | "LINKS_TO"
  | "EXPLAINS"
  | "REVIEWED_BY"
  | "OWNED_BY"
  | "DEPENDS_ON"
  | "USES_LIBRARY"
  | "SIMILAR_TO"
  | "CAUSED"
  | "REVERTED_BY"
  | "SUPPORTED_BY"
  | "APPLIES_TO"
  | "HAS_COMMENT"
  | "GENERALIZES";

export type MemoryType =
  | "repo-memory"
  | "decision-memory"
  | "review-pattern"
  | "risk-memory"
  | "ownership-memory"
  | "testing-memory"
  | "migration-memory"
  | "cross-repo-pattern"
  | "shared-library-memory"
  | "dependency-memory"
  | "architecture-memory"
  | "domain-memory"
  | "incident-memory"
  | "convention-memory"
  | "rejected-approach"
  | "compatibility-risk";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ConfidenceLabel = "low" | "medium" | "high";

export interface SourceReference {
  type: "file" | "commit" | "pull_request" | "review_comment" | "jira" | "repository" | "memory" | "relationship";
  id: string;
  repo?: string;
  path?: string;
  url?: string;
  title?: string;
  reason?: string;
}

export interface Evidence {
  type: SourceReference["type"];
  id: string;
  summary: string;
  source?: SourceReference;
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  workspaceId: string;
  name: string;
  path: string;
  absolutePath: string;
  createdAt: string;
  updatedAt: string;
  lastIndexedAt?: string;
  indexStatus?: "unindexed" | "indexing" | "indexed" | "failed";
  warnings?: string[];
}

export interface MemoryNode {
  id: string;
  type: NodeType;
  workspaceId: string;
  repoId?: string;
  key: string;
  title?: string;
  body?: string;
  properties: Record<string, unknown>;
  source?: SourceReference;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRelationship {
  id: string;
  type: RelationshipType;
  fromNodeId: string;
  toNodeId: string;
  workspaceId: string;
  repoId?: string;
  confidence: number;
  evidence: Evidence[];
  properties: Record<string, unknown>;
  createdAt: string;
}

export interface Memory {
  id: string;
  type: MemoryType;
  workspaceId: string;
  repoIds: string[];
  title: string;
  summary: string;
  guidance: string[];
  confidence: number;
  sourceReferences: SourceReference[];
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommitSummary {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  changedFiles?: string[];
  jiraKeys?: string[];
  reason?: string;
}

export interface CoChangedFile {
  path: string;
  count: number;
  reason: string;
}

export interface FileMemory {
  repoId: string;
  repoName: string;
  filePath: string;
  summary: string;
  riskLevel: RiskLevel;
  whyRisky: string[];
  recentCommits: CommitSummary[];
  relatedJiraKeys: string[];
  coChangedFiles: CoChangedFile[];
  likelyTests: string[];
  guidance: string[];
  warnings: string[];
  historicalSignals: string[];
  sourceReferences: SourceReference[];
  updatedAt: string;
}

export interface RepoMemory {
  repoId: string;
  repoName: string;
  summary: string;
  indexedFiles: number;
  indexedCommits: number;
  highRiskFiles: string[];
  warnings: string[];
  updatedAt: string;
}

export interface NodeQuery {
  workspaceId?: string;
  repoId?: string;
  type?: NodeType;
  keyContains?: string;
  limit?: number;
}

export interface RelationshipQuery {
  workspaceId?: string;
  repoId?: string;
  type?: RelationshipType;
  fromNodeId?: string;
  toNodeId?: string;
  limit?: number;
}

export interface MemoryQuery {
  workspaceId?: string;
  repoId?: string;
  type?: MemoryType;
  text?: string;
  limit?: number;
}

export interface SearchQuery {
  workspaceId?: string;
  repoId?: string;
  query: string;
  limit?: number;
}

export interface SearchResult {
  entityType: string;
  entityId: string;
  repoId?: string;
  title: string;
  body: string;
  score: number;
}

export interface TraversalOptions {
  relationshipTypes?: RelationshipType[];
  direction?: "out" | "in" | "both";
  limit?: number;
}

export interface RelatedNode {
  node: MemoryNode;
  relationship: MemoryRelationship;
}

export interface SubgraphOptions extends TraversalOptions {
  depth?: number;
}

export interface MemorySubgraph {
  nodes: MemoryNode[];
  relationships: MemoryRelationship[];
}

export interface IndexRun {
  id: string;
  repoId: string;
  repoName: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  indexedFiles: number;
  indexedCommits: number;
  warnings: string[];
  error?: string;
}

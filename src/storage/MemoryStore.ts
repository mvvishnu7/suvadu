import type {
  Evidence,
  FileMemory,
  IndexRun,
  Memory,
  MemoryNode,
  MemoryQuery,
  MemoryRelationship,
  MemorySubgraph,
  NodeQuery,
  RelatedNode,
  RelationshipQuery,
  RepoMemory,
  Repository,
  SearchQuery,
  SearchResult,
  SourceReference,
  TraversalOptions,
  Workspace
} from "../domain/types.js";

export interface StoreStats {
  repositories: number;
  indexedRepositories: number;
  nodes: number;
  relationships: number;
  memories: number;
  fileMemories: number;
  lastIndexedRepo?: string;
  warnings: string[];
}

export interface CommitHistoryFilter {
  repoId: string;
  filePath: string;
  limit?: number;
}

export interface MemoryStore {
  upsertWorkspace(workspace: Workspace): Promise<void>;
  getWorkspace(id: string): Promise<Workspace | null>;

  upsertRepository(repository: Repository): Promise<void>;
  getRepositoryByName(workspaceId: string, name: string): Promise<Repository | null>;
  getRepositoryById(id: string): Promise<Repository | null>;
  listRepositories(workspaceId: string): Promise<Repository[]>;

  beginIndexRun(repo: Repository): Promise<IndexRun>;
  completeIndexRun(runId: string, update: Partial<IndexRun>): Promise<void>;
  getLatestIndexRun(repoId: string): Promise<IndexRun | null>;
  clearRepoIndexData(repoId: string): Promise<void>;

  upsertNode(node: MemoryNode): Promise<void>;
  getNode(id: string): Promise<MemoryNode | null>;
  findNodes(query: NodeQuery): Promise<MemoryNode[]>;

  upsertRelationship(relationship: MemoryRelationship): Promise<void>;
  findRelationships(query: RelationshipQuery): Promise<MemoryRelationship[]>;

  upsertMemory(memory: Memory): Promise<void>;
  getMemory(id: string): Promise<Memory | null>;
  findMemories(query: MemoryQuery): Promise<Memory[]>;

  linkMemoryToEvidence(memoryId: string, evidence: Evidence[]): Promise<void>;

  searchText(query: SearchQuery): Promise<SearchResult[]>;

  getFileMemory(repoId: string, filePath: string): Promise<FileMemory | null>;
  saveFileMemory(fileMemory: FileMemory): Promise<void>;
  listFileMemories(repoId: string): Promise<FileMemory[]>;

  getRepoMemory(repoId: string): Promise<RepoMemory | null>;
  saveRepoMemory(repoMemory: RepoMemory): Promise<void>;

  getRelatedNodes(nodeId: string, options: TraversalOptions): Promise<RelatedNode[]>;
  getSubgraph(seedNodeIds: string[], options: TraversalOptions): Promise<MemorySubgraph>;

  getCommitsForFile(filter: CommitHistoryFilter): Promise<SourceReference[]>;
  getStats(workspaceId: string): Promise<StoreStats>;
  close(): Promise<void>;
}

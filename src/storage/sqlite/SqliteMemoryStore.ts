import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
} from "../../domain/types.js";
import type { CommitHistoryFilter, MemoryStore, StoreStats } from "../MemoryStore.js";
import { SQLITE_SCHEMA } from "./schema.js";
import { nowIso } from "../../utils/time.js";

type Row = Record<string, unknown>;

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SQLITE_SCHEMA);
  }

  async upsertWorkspace(workspace: Workspace): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           updated_at = excluded.updated_at`
      )
      .run(workspace.id, workspace.name, workspace.rootPath, workspace.createdAt, workspace.updatedAt);
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Row | undefined;
    return row ? workspaceFromRow(row) : null;
  }

  async upsertRepository(repository: Repository): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO repositories (
           id, workspace_id, name, path, absolute_path, index_status, last_indexed_at,
           warnings_json, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           absolute_path = excluded.absolute_path,
           index_status = excluded.index_status,
           last_indexed_at = excluded.last_indexed_at,
           warnings_json = excluded.warnings_json,
           updated_at = excluded.updated_at`
      )
      .run(
        repository.id,
        repository.workspaceId,
        repository.name,
        repository.path,
        repository.absolutePath,
        repository.indexStatus ?? "unindexed",
        repository.lastIndexedAt ?? null,
        JSON.stringify(repository.warnings ?? []),
        repository.createdAt,
        repository.updatedAt
      );
  }

  async getRepositoryByName(workspaceId: string, name: string): Promise<Repository | null> {
    const row = this.db
      .prepare("SELECT * FROM repositories WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, name) as Row | undefined;
    return row ? repositoryFromRow(row) : null;
  }

  async getRepositoryById(id: string): Promise<Repository | null> {
    const row = this.db.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as Row | undefined;
    return row ? repositoryFromRow(row) : null;
  }

  async listRepositories(workspaceId: string): Promise<Repository[]> {
    const rows = this.db
      .prepare("SELECT * FROM repositories WHERE workspace_id = ? ORDER BY name")
      .all(workspaceId) as Row[];
    return rows.map(repositoryFromRow);
  }

  async beginIndexRun(repo: Repository): Promise<IndexRun> {
    const startedAt = nowIso();
    const run: IndexRun = {
      id: `index-run:${repo.id}:${Date.now()}`,
      repoId: repo.id,
      repoName: repo.name,
      status: "running",
      startedAt,
      indexedFiles: 0,
      indexedCommits: 0,
      warnings: []
    };
    this.db
      .prepare(
        `INSERT INTO index_runs (
           id, repo_id, repo_name, status, started_at, indexed_files, indexed_commits, warnings_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(run.id, run.repoId, run.repoName, run.status, run.startedAt, 0, 0, "[]");
    this.db
      .prepare("UPDATE repositories SET index_status = 'indexing', updated_at = ? WHERE id = ?")
      .run(startedAt, repo.id);
    return run;
  }

  async completeIndexRun(runId: string, update: Partial<IndexRun>): Promise<void> {
    const completedAt = update.completedAt ?? nowIso();
    const warnings = update.warnings ?? [];
    this.db
      .prepare(
        `UPDATE index_runs
         SET status = ?, completed_at = ?, indexed_files = ?, indexed_commits = ?,
             warnings_json = ?, error = ?
         WHERE id = ?`
      )
      .run(
        update.status ?? "completed",
        completedAt,
        update.indexedFiles ?? 0,
        update.indexedCommits ?? 0,
        JSON.stringify(warnings),
        update.error ?? null,
        runId
      );

    const run = this.db.prepare("SELECT repo_id FROM index_runs WHERE id = ?").get(runId) as Row | undefined;
    if (run?.repo_id) {
      this.db
        .prepare(
          `UPDATE repositories
           SET index_status = ?, last_indexed_at = ?, warnings_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(update.status === "failed" ? "failed" : "indexed", completedAt, JSON.stringify(warnings), completedAt, run.repo_id);
    }
  }

  async getLatestIndexRun(repoId: string): Promise<IndexRun | null> {
    const row = this.db
      .prepare("SELECT * FROM index_runs WHERE repo_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(repoId) as Row | undefined;
    return row ? indexRunFromRow(row) : null;
  }

  async clearRepoIndexData(repoId: string): Promise<void> {
    this.db.prepare("DELETE FROM relationships WHERE repo_id = ?").run(repoId);
    this.db.prepare("DELETE FROM nodes WHERE repo_id = ? AND type != 'repository'").run(repoId);
    this.db.prepare("DELETE FROM file_memory_cache WHERE repo_id = ?").run(repoId);
    this.db.prepare("DELETE FROM repo_memory_cache WHERE repo_id = ?").run(repoId);
    this.db.prepare("DELETE FROM search_index WHERE repo_id = ?").run(repoId);
  }

  async upsertNode(node: MemoryNode): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO nodes (
           id, type, workspace_id, repo_id, key, title, body, properties_json,
           source_json, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           workspace_id = excluded.workspace_id,
           repo_id = excluded.repo_id,
           key = excluded.key,
           title = excluded.title,
           body = excluded.body,
           properties_json = excluded.properties_json,
           source_json = excluded.source_json,
           updated_at = excluded.updated_at`
      )
      .run(
        node.id,
        node.type,
        node.workspaceId,
        node.repoId ?? null,
        node.key,
        node.title ?? null,
        node.body ?? null,
        JSON.stringify(node.properties ?? {}),
        node.source ? JSON.stringify(node.source) : null,
        node.createdAt,
        node.updatedAt
      );
    this.upsertSearchIndex(node.title ?? node.key, node.body ?? "", node.type, node.id, node.repoId);
  }

  async getNode(id: string): Promise<MemoryNode | null> {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Row | undefined;
    return row ? nodeFromRow(row) : null;
  }

  async findNodes(query: NodeQuery): Promise<MemoryNode[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(query.workspaceId);
    }
    if (query.repoId) {
      conditions.push("repo_id = ?");
      params.push(query.repoId);
    }
    if (query.type) {
      conditions.push("type = ?");
      params.push(query.type);
    }
    if (query.keyContains) {
      conditions.push("key LIKE ?");
      params.push(`%${query.keyContains}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM nodes ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, query.limit ?? 50) as Row[];
    return rows.map(nodeFromRow);
  }

  async upsertRelationship(relationship: MemoryRelationship): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO relationships (
           id, type, from_node_id, to_node_id, workspace_id, repo_id, confidence,
           evidence_json, properties_json, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           confidence = excluded.confidence,
           evidence_json = excluded.evidence_json,
           properties_json = excluded.properties_json`
      )
      .run(
        relationship.id,
        relationship.type,
        relationship.fromNodeId,
        relationship.toNodeId,
        relationship.workspaceId,
        relationship.repoId ?? null,
        relationship.confidence,
        JSON.stringify(relationship.evidence ?? []),
        JSON.stringify(relationship.properties ?? {}),
        relationship.createdAt
      );
  }

  async findRelationships(query: RelationshipQuery): Promise<MemoryRelationship[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(query.workspaceId);
    }
    if (query.repoId) {
      conditions.push("repo_id = ?");
      params.push(query.repoId);
    }
    if (query.type) {
      conditions.push("type = ?");
      params.push(query.type);
    }
    if (query.fromNodeId) {
      conditions.push("from_node_id = ?");
      params.push(query.fromNodeId);
    }
    if (query.toNodeId) {
      conditions.push("to_node_id = ?");
      params.push(query.toNodeId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM relationships ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, query.limit ?? 100) as Row[];
    return rows.map(relationshipFromRow);
  }

  async upsertMemory(memory: Memory): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO memories (
           id, type, workspace_id, repo_ids_json, title, summary, guidance_json,
           confidence, source_references_json, properties_json, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           repo_ids_json = excluded.repo_ids_json,
           title = excluded.title,
           summary = excluded.summary,
           guidance_json = excluded.guidance_json,
           confidence = excluded.confidence,
           source_references_json = excluded.source_references_json,
           properties_json = excluded.properties_json,
           updated_at = excluded.updated_at`
      )
      .run(
        memory.id,
        memory.type,
        memory.workspaceId,
        JSON.stringify(memory.repoIds),
        memory.title,
        memory.summary,
        JSON.stringify(memory.guidance),
        memory.confidence,
        JSON.stringify(memory.sourceReferences),
        JSON.stringify(memory.properties),
        memory.createdAt,
        memory.updatedAt
      );
    this.upsertSearchIndex(memory.title, memory.summary, "memory", memory.id, memory.repoIds[0]);
  }

  async getMemory(id: string): Promise<Memory | null> {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row ? memoryFromRow(row) : null;
  }

  async findMemories(query: MemoryQuery): Promise<Memory[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(query.workspaceId);
    }
    if (query.type) {
      conditions.push("type = ?");
      params.push(query.type);
    }
    if (query.repoId) {
      conditions.push("repo_ids_json LIKE ?");
      params.push(`%${query.repoId}%`);
    }
    if (query.text) {
      conditions.push("(title LIKE ? OR summary LIKE ?)");
      params.push(`%${query.text}%`, `%${query.text}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, query.limit ?? 50) as Row[];
    return rows.map(memoryFromRow);
  }

  async linkMemoryToEvidence(memoryId: string, evidence: Evidence[]): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO memory_evidence (memory_id, evidence_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           evidence_json = excluded.evidence_json,
           updated_at = excluded.updated_at`
      )
      .run(memoryId, JSON.stringify(evidence), nowIso());
  }

  async searchText(query: SearchQuery): Promise<SearchResult[]> {
    const terms = query.query
      .split(/\s+/)
      .map((term) => term.replace(/[^a-zA-Z0-9_-]/g, ""))
      .filter(Boolean);
    if (terms.length === 0) {
      return [];
    }
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    const repoFilter = query.repoId ? "AND repo_id = ?" : "";
    const params: unknown[] = query.repoId ? [match, query.repoId, query.limit ?? 20] : [match, query.limit ?? 20];
    try {
      const rows = this.db
        .prepare(
          `SELECT entity_type, entity_id, repo_id, title, body, bm25(search_index) AS rank
           FROM search_index
           WHERE search_index MATCH ? ${repoFilter}
           ORDER BY rank
           LIMIT ?`
        )
        .all(...params) as Row[];
      return rows.map((row) => ({
        entityType: String(row.entity_type),
        entityId: String(row.entity_id),
        repoId: row.repo_id ? String(row.repo_id) : undefined,
        title: String(row.title ?? ""),
        body: String(row.body ?? ""),
        score: Number(row.rank ?? 0)
      }));
    } catch {
      return [];
    }
  }

  async getFileMemory(repoId: string, filePath: string): Promise<FileMemory | null> {
    const row = this.db
      .prepare("SELECT memory_json FROM file_memory_cache WHERE repo_id = ? AND file_path = ?")
      .get(repoId, filePath) as Row | undefined;
    return row ? parseJson<FileMemory | null>(row.memory_json, null) : null;
  }

  async saveFileMemory(fileMemory: FileMemory): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO file_memory_cache (repo_id, file_path, memory_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_id, file_path) DO UPDATE SET
           memory_json = excluded.memory_json,
           updated_at = excluded.updated_at`
      )
      .run(fileMemory.repoId, fileMemory.filePath, JSON.stringify(fileMemory), fileMemory.updatedAt);
    this.upsertSearchIndex(fileMemory.filePath, `${fileMemory.summary}\n${fileMemory.guidance.join("\n")}`, "file_memory", fileMemory.filePath, fileMemory.repoId);
  }

  async listFileMemories(repoId: string): Promise<FileMemory[]> {
    const rows = this.db
      .prepare("SELECT memory_json FROM file_memory_cache WHERE repo_id = ? ORDER BY file_path")
      .all(repoId) as Row[];
    return rows.map((row) => parseJson<FileMemory | null>(row.memory_json, null)).filter((value): value is FileMemory => value !== null);
  }

  async getRepoMemory(repoId: string): Promise<RepoMemory | null> {
    const row = this.db
      .prepare("SELECT memory_json FROM repo_memory_cache WHERE repo_id = ?")
      .get(repoId) as Row | undefined;
    return row ? parseJson<RepoMemory | null>(row.memory_json, null) : null;
  }

  async saveRepoMemory(repoMemory: RepoMemory): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO repo_memory_cache (repo_id, memory_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           memory_json = excluded.memory_json,
           updated_at = excluded.updated_at`
      )
      .run(repoMemory.repoId, JSON.stringify(repoMemory), repoMemory.updatedAt);
  }

  async getRelatedNodes(nodeId: string, options: TraversalOptions): Promise<RelatedNode[]> {
    const directions = options.direction ?? "out";
    const relationshipTypes = options.relationshipTypes ?? [];
    const typeClause = relationshipTypes.length
      ? `AND r.type IN (${relationshipTypes.map(() => "?").join(", ")})`
      : "";
    const params = relationshipTypes;
    const rows: Row[] = [];
    if (directions === "out" || directions === "both") {
      rows.push(
        ...(this.db
          .prepare(
            `SELECT n.*, r.id AS rel_id, r.type AS rel_type, r.from_node_id, r.to_node_id,
                    r.workspace_id AS rel_workspace_id, r.repo_id AS rel_repo_id, r.confidence,
                    r.evidence_json, r.properties_json AS rel_properties_json, r.created_at AS rel_created_at
             FROM relationships r
             JOIN nodes n ON n.id = r.to_node_id
             WHERE r.from_node_id = ? ${typeClause}
             LIMIT ?`
          )
          .all(nodeId, ...params, options.limit ?? 50) as Row[])
      );
    }
    if (directions === "in" || directions === "both") {
      rows.push(
        ...(this.db
          .prepare(
            `SELECT n.*, r.id AS rel_id, r.type AS rel_type, r.from_node_id, r.to_node_id,
                    r.workspace_id AS rel_workspace_id, r.repo_id AS rel_repo_id, r.confidence,
                    r.evidence_json, r.properties_json AS rel_properties_json, r.created_at AS rel_created_at
             FROM relationships r
             JOIN nodes n ON n.id = r.from_node_id
             WHERE r.to_node_id = ? ${typeClause}
             LIMIT ?`
          )
          .all(nodeId, ...params, options.limit ?? 50) as Row[])
      );
    }
    return rows.slice(0, options.limit ?? 50).map((row) => ({
      node: nodeFromRow(row),
      relationship: relationshipFromJoinedRow(row)
    }));
  }

  async getSubgraph(seedNodeIds: string[], options: TraversalOptions): Promise<MemorySubgraph> {
    const nodes = new Map<string, MemoryNode>();
    const relationships = new Map<string, MemoryRelationship>();
    for (const seed of seedNodeIds) {
      const node = await this.getNode(seed);
      if (node) {
        nodes.set(node.id, node);
      }
      const related = await this.getRelatedNodes(seed, { ...options, direction: options.direction ?? "both" });
      for (const item of related) {
        nodes.set(item.node.id, item.node);
        relationships.set(item.relationship.id, item.relationship);
      }
    }
    return { nodes: [...nodes.values()], relationships: [...relationships.values()] };
  }

  async getCommitsForFile(filter: CommitHistoryFilter): Promise<SourceReference[]> {
    const rows = this.db
      .prepare(
        `SELECT n.*
         FROM relationships r
         JOIN nodes n ON n.id = r.from_node_id
         WHERE r.repo_id = ? AND r.type = 'TOUCHED' AND r.to_node_id LIKE ?
         ORDER BY json_extract(n.properties_json, '$.date') DESC
         LIMIT ?`
      )
      .all(filter.repoId, `%:${filter.filePath}`, filter.limit ?? 20) as Row[];
    return rows.map((row) => {
      const node = nodeFromRow(row);
      return {
        type: "commit",
        id: String(node.properties.hash ?? node.key),
        title: node.title,
        reason: node.body,
        repo: filter.repoId
      };
    });
  }

  async getStats(workspaceId: string): Promise<StoreStats> {
    const repositoryRows = this.db
      .prepare("SELECT * FROM repositories WHERE workspace_id = ?")
      .all(workspaceId) as Row[];
    const indexedRepositories = repositoryRows.filter((row) => row.index_status === "indexed").length;
    const nodes = scalarCount(this.db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE workspace_id = ?").get(workspaceId));
    const relationships = scalarCount(
      this.db.prepare("SELECT COUNT(*) AS count FROM relationships WHERE workspace_id = ?").get(workspaceId)
    );
    const memories = scalarCount(this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE workspace_id = ?").get(workspaceId));
    const fileMemories = scalarCount(this.db.prepare("SELECT COUNT(*) AS count FROM file_memory_cache").get());
    const lastRun = this.db
      .prepare(
        `SELECT repo_name FROM index_runs
         WHERE status = 'completed'
         ORDER BY completed_at DESC
         LIMIT 1`
      )
      .get() as Row | undefined;
    const warnings = repositoryRows.flatMap((row) => parseJson<string[]>(row.warnings_json, []));
    return {
      repositories: repositoryRows.length,
      indexedRepositories,
      nodes,
      relationships,
      memories,
      fileMemories,
      lastIndexedRepo: lastRun?.repo_name ? String(lastRun.repo_name) : undefined,
      warnings
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private upsertSearchIndex(title: string, body: string, entityType: string, entityId: string, repoId?: string): void {
    try {
      this.db.prepare("DELETE FROM search_index WHERE entity_id = ?").run(entityId);
      this.db
        .prepare("INSERT INTO search_index (title, body, entity_type, entity_id, repo_id) VALUES (?, ?, ?, ?, ?)")
        .run(title, body, entityType, entityId, repoId ?? null);
    } catch {
      // Search is a projection. If FTS is unavailable, core memory storage still works.
    }
  }
}

function workspaceFromRow(row: Row): Workspace {
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: String(row.root_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function repositoryFromRow(row: Row): Repository {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    path: String(row.path),
    absolutePath: String(row.absolute_path),
    indexStatus: row.index_status as Repository["indexStatus"],
    lastIndexedAt: row.last_indexed_at ? String(row.last_indexed_at) : undefined,
    warnings: parseJson<string[]>(row.warnings_json, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function indexRunFromRow(row: Row): IndexRun {
  return {
    id: String(row.id),
    repoId: String(row.repo_id),
    repoName: String(row.repo_name),
    status: row.status as IndexRun["status"],
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    indexedFiles: Number(row.indexed_files ?? 0),
    indexedCommits: Number(row.indexed_commits ?? 0),
    warnings: parseJson<string[]>(row.warnings_json, []),
    error: row.error ? String(row.error) : undefined
  };
}

function nodeFromRow(row: Row): MemoryNode {
  return {
    id: String(row.id),
    type: row.type as MemoryNode["type"],
    workspaceId: String(row.workspace_id),
    repoId: row.repo_id ? String(row.repo_id) : undefined,
    key: String(row.key),
    title: row.title ? String(row.title) : undefined,
    body: row.body ? String(row.body) : undefined,
    properties: parseJson<Record<string, unknown>>(row.properties_json, {}),
    source: row.source_json ? parseJson<SourceReference | undefined>(row.source_json, undefined) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function relationshipFromRow(row: Row): MemoryRelationship {
  return {
    id: String(row.id),
    type: row.type as MemoryRelationship["type"],
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    workspaceId: String(row.workspace_id),
    repoId: row.repo_id ? String(row.repo_id) : undefined,
    confidence: Number(row.confidence),
    evidence: parseJson<Evidence[]>(row.evidence_json, []),
    properties: parseJson<Record<string, unknown>>(row.properties_json, {}),
    createdAt: String(row.created_at)
  };
}

function relationshipFromJoinedRow(row: Row): MemoryRelationship {
  return {
    id: String(row.rel_id),
    type: row.rel_type as MemoryRelationship["type"],
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    workspaceId: String(row.rel_workspace_id),
    repoId: row.rel_repo_id ? String(row.rel_repo_id) : undefined,
    confidence: Number(row.confidence),
    evidence: parseJson<Evidence[]>(row.evidence_json, []),
    properties: parseJson<Record<string, unknown>>(row.rel_properties_json, {}),
    createdAt: String(row.rel_created_at)
  };
}

function memoryFromRow(row: Row): Memory {
  return {
    id: String(row.id),
    type: row.type as Memory["type"],
    workspaceId: String(row.workspace_id),
    repoIds: parseJson<string[]>(row.repo_ids_json, []),
    title: String(row.title),
    summary: String(row.summary),
    guidance: parseJson<string[]>(row.guidance_json, []),
    confidence: Number(row.confidence),
    sourceReferences: parseJson<SourceReference[]>(row.source_references_json, []),
    properties: parseJson<Record<string, unknown>>(row.properties_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function scalarCount(row: unknown): number {
  if (!row || typeof row !== "object" || !("count" in row)) {
    return 0;
  }
  return Number((row as { count: unknown }).count ?? 0);
}

export const SQLITE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  index_status TEXT NOT NULL DEFAULT 'unindexed',
  last_indexed_at TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS index_runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  indexed_files INTEGER NOT NULL DEFAULT 0,
  indexed_commits INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repo_id TEXT,
  key TEXT NOT NULL,
  title TEXT,
  body TEXT,
  properties_json TEXT NOT NULL,
  source_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repo_id TEXT,
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repo_ids_json TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  guidance_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_references_json TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(memory_id)
);

CREATE TABLE IF NOT EXISTS file_memory_cache (
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  memory_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(repo_id, file_path)
);

CREATE TABLE IF NOT EXISTS repo_memory_cache (
  repo_id TEXT PRIMARY KEY,
  memory_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  title,
  body,
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  repo_id UNINDEXED
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_workspace_type ON nodes(workspace_id, type);
CREATE INDEX IF NOT EXISTS idx_nodes_repo_type ON nodes(repo_id, type);
CREATE INDEX IF NOT EXISTS idx_nodes_key ON nodes(key);

CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_node_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_node_id);
CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(type);
CREATE INDEX IF NOT EXISTS idx_relationships_from_type ON relationships(from_node_id, type);
CREATE INDEX IF NOT EXISTS idx_relationships_to_type ON relationships(to_node_id, type);

CREATE INDEX IF NOT EXISTS idx_memories_workspace_type ON memories(workspace_id, type);
CREATE INDEX IF NOT EXISTS idx_index_runs_repo_started ON index_runs(repo_id, started_at);
`;

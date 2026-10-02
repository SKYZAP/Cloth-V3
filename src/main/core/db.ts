import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

const MIGRATIONS: string[] = [
  /* 1 — initial schema */ `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key BLOB,
    headers TEXT NOT NULL DEFAULT '{}',
    models TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    embedding TEXT,
    embedding_dim INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    hash TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    embedded INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX documents_collection ON documents(collection_id);
  CREATE UNIQUE INDEX documents_source ON documents(collection_id, source);

  CREATE TABLE chunks (
    rid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    heading_path TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    embedding BLOB
  );
  CREATE INDEX chunks_doc ON chunks(doc_id);
  CREATE INDEX chunks_collection ON chunks(collection_id);

  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    title, heading_path, text,
    tokenize = 'porter unicode61 remove_diacritics 2'
  );

  CREATE TABLE skill_runs (
    id TEXT PRIMARY KEY,
    skill_name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX skill_runs_skill ON skill_runs(skill_name, created_at);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    config TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    graph TEXT NOT NULL,
    cron TEXT,
    cron_enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    started_at INTEGER NOT NULL
  );
  CREATE INDEX workflow_runs_wf ON workflow_runs(workflow_id, started_at);
  `,
  /* 2 — user-defined tools */ `
  CREATE TABLE tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    kind TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '[]',
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /* 3 — usage log for the dashboard */ `
  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    ref TEXT,
    provider_id TEXT,
    model_id TEXT,
    name TEXT,
    detail TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    ok INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX usage_at ON usage_events(at);
  CREATE INDEX usage_kind_at ON usage_events(kind, at);
  `,
  /* 4 — chat turns summarised away by compaction */ `
  ALTER TABLE sessions ADD COLUMN archive TEXT NOT NULL DEFAULT '[]';
  `,
  /* 5 — custom tools made by a model */ `
  ALTER TABLE tools ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';
  `,
  /* 6 — flow change history */ `
  CREATE TABLE workflow_versions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL,
    source TEXT NOT NULL,
    note TEXT,
    summary TEXT NOT NULL DEFAULT '',
    node_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX workflow_versions_flow ON workflow_versions(workflow_id, created_at);
  `,
  /* 7 — projects (chats point at theirs through config.projectId) */ `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT,
    color TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    defaults TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /* 8 — design systems; a project can follow one */ `
  CREATE TABLE design_systems (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    input TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE projects ADD COLUMN design_id TEXT;
  `,
  /* 9 — component library of a design system */ `
  CREATE TABLE design_components (
    id TEXT PRIMARY KEY,
    design_id TEXT NOT NULL REFERENCES design_systems(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    html TEXT NOT NULL,
    css TEXT NOT NULL,
    usage TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    history TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX design_components_design ON design_components(design_id, created_at);
  `
]

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i])
      db.exec(`PRAGMA user_version = ${i + 1}`)
    })
  }
  return db
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class Kv {
  constructor(private db: Db) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row ? json(row.value, fallback) : fallback
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }
}

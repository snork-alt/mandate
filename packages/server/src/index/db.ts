import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type DB = Database.Database;

/** Bump when the schema or the extraction logic changes: the index is rebuilt from scratch. */
export const SCHEMA_VERSION = 9;

const DDL = `
CREATE TABLE IF NOT EXISTS index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  head_commit TEXT,
  head_seq INTEGER NOT NULL DEFAULT 0,
  -- Last detected history rewrite (JSON), kept across rebuilds.
  history_rewrite TEXT,
  model_id TEXT,
  schema_version INTEGER NOT NULL,
  last_sync_at TEXT,
  last_error TEXT
);
-- Blob id per indexed repo file at head_commit: the incremental sync diffs against it.
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, blob TEXT NOT NULL, text TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS docs (
  uri TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT,
  status TEXT, category TEXT, repo TEXT, tags TEXT NOT NULL DEFAULT '[]', standards TEXT NOT NULL DEFAULT '[]',
  owner TEXT, priority TEXT, props TEXT NOT NULL DEFAULT '{}', path TEXT NOT NULL,
  line_start INTEGER, line_end INTEGER, updated_commit TEXT, updated_at TEXT, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_source ON docs(source);
CREATE TABLE IF NOT EXISTS sections (
  uri TEXT PRIMARY KEY, doc_uri TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, title TEXT NOT NULL,
  type TEXT NOT NULL, summary TEXT, line_start INTEGER, line_end INTEGER,
  standards TEXT NOT NULL DEFAULT '[]', tokens INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sections_doc ON sections(doc_uri);
CREATE INDEX IF NOT EXISTS sections_source ON sections(source);

-- Docs and sections with their doc's metadata (what search filters on).
CREATE VIEW IF NOT EXISTS entries AS
  SELECT d.uri, d.uri AS doc_uri, d.kind, d.kind AS doc_kind, d.title AS doc_title, NULL AS section_id, NULL AS section_title,
         NULL AS section_type, d.status, d.category, d.repo, d.tags, d.standards, d.updated_at, d.line_start, d.line_end, d.path
    FROM docs d
  UNION ALL
  SELECT s.uri, s.doc_uri, 'section', d.kind, d.title, s.id, s.title, s.type, d.status, d.category, d.repo, d.tags, s.standards,
         d.updated_at, s.line_start, s.line_end, d.path
    FROM sections s JOIN docs d ON d.uri = s.doc_uri;

-- Temporal graph over internal points (never exposed; rebuilt deterministically from git):
--  * every commit gets an order number o in a topological linearisation (side-branch commits right before their merge);
--  * first-parent (mainline) commits have point = o; rows are intervals valid_from <= point < valid_to (NULL = current);
--  * a side-branch commit has point = -o and its own snapshot rows (valid_from = -o, valid_to = -o + 1), i.e. its full state.
-- So "valid at point p" is always valid_from <= p AND (valid_to IS NULL OR valid_to > p), for mainline and side commits alike.
CREATE TABLE IF NOT EXISTS nodes (
  uri TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, props TEXT NOT NULL DEFAULT '{}', source TEXT,
  valid_from INTEGER NOT NULL, valid_to INTEGER,
  PRIMARY KEY (uri, valid_from)
);
CREATE INDEX IF NOT EXISTS nodes_current ON nodes(uri, valid_to);
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind, valid_to);
CREATE INDEX IF NOT EXISTS nodes_source ON nodes(source, valid_to);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY, from_uri TEXT NOT NULL, to_uri TEXT NOT NULL, kind TEXT NOT NULL, props TEXT, score REAL,
  source TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER
);
CREATE INDEX IF NOT EXISTS edges_from ON edges(from_uri, kind, valid_to);
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_uri, kind, valid_to);
CREATE INDEX IF NOT EXISTS edges_source ON edges(source, valid_to);
CREATE INDEX IF NOT EXISTS edges_from_seq ON edges(valid_from);
CREATE INDEX IF NOT EXISTS edges_to_seq ON edges(valid_to);

CREATE TABLE IF NOT EXISTS symbols (name TEXT NOT NULL, normalized TEXT NOT NULL, parts TEXT NOT NULL, section_uri TEXT NOT NULL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_norm ON symbols(normalized);
CREATE INDEX IF NOT EXISTS symbols_source ON symbols(source);
-- Distinct symbol names, trigram-tokenized for typo-tolerant lookup.
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_trgm USING fts5(name, tokenize = 'trigram');

CREATE TABLE IF NOT EXISTS code_refs (
  repo TEXT NOT NULL, path TEXT NOT NULL, line_start INTEGER, line_end INTEGER, commit_sha TEXT,
  section_uri TEXT NOT NULL, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS code_refs_range ON code_refs(repo, path, line_start, line_end);
CREATE INDEX IF NOT EXISTS code_refs_source ON code_refs(source);

-- One row per doc and per section. body = indexable text (mermaid/html reduced to visible text).
CREATE VIRTUAL TABLE IF NOT EXISTS fts_sections USING fts5(uri UNINDEXED, source UNINDEXED, title, summary, body, symbols, tokenize = 'porter unicode61');
-- Raw text, trigram-tokenized: prefilter for literal / regex search (no stemming).
CREATE VIRTUAL TABLE IF NOT EXISTS fts_raw USING fts5(uri UNINDEXED, source UNINDEXED, body, tokenize = 'trigram');

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, uri TEXT NOT NULL, doc_uri TEXT NOT NULL, chunk_index INTEGER NOT NULL, kind TEXT NOT NULL,
  line_start INTEGER, line_end INTEGER, content_hash TEXT NOT NULL, text TEXT NOT NULL, prefix TEXT NOT NULL, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS chunks_uri ON chunks(uri);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source);

-- Survives rebuilds: unchanged text is never embedded twice for the same model.
CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash TEXT NOT NULL, model_id TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL,
  PRIMARY KEY (content_hash, model_id)
);

-- Embedding outbox / job queue (see index/embed/jobs.ts). A row exists while a chunk text still needs a vector for a
-- model: the indexer inserts it in the same transaction as the chunk; the worker deletes it once the vector is stored
-- ('done' is never persisted). 'failed' rows stay until retried or until no chunk has that text any more.
-- Times are epoch milliseconds. Derived (wiped with the chunks): a replay re-enqueues what is still missing.
CREATE TABLE IF NOT EXISTS embed_jobs (
  content_hash TEXT NOT NULL, model_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  enqueued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (content_hash, model_id)
);
CREATE INDEX IF NOT EXISTS embed_jobs_due ON embed_jobs(model_id, status, next_attempt_at, priority);
CREATE INDEX IF NOT EXISTS embed_jobs_order ON embed_jobs(model_id, status, priority DESC, enqueued_at);
-- The model the jobs table is complete for. Missing (first start after this table was added) or another model:
-- the queue backfills jobs from the chunks (embed/jobs.ts backfill). Not derived.
CREATE TABLE IF NOT EXISTS embed_queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), model_id TEXT NOT NULL, backfilled_at INTEGER NOT NULL);

-- Every commit. seq = position on the first-parent chain (1 = root); merged side-branch commits share their merge's seq.
CREATE TABLE IF NOT EXISTS commits (
  sha TEXT PRIMARY KEY, seq INTEGER NOT NULL, parent_sha TEXT, mainline INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  author TEXT NOT NULL, email TEXT NOT NULL, date TEXT NOT NULL, trailers TEXT NOT NULL, agent TEXT, branch TEXT,
  kinds TEXT NOT NULL DEFAULT '[]', uris TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS commits_seq ON commits(seq);
CREATE INDEX IF NOT EXISTS commits_date ON commits(date);
CREATE TABLE IF NOT EXISTS commit_uris (sha TEXT NOT NULL, uri TEXT NOT NULL, PRIMARY KEY (sha, uri));
-- All parents of every commit (idx 0 = first parent): ancestry for side branches and isAncestor().
CREATE TABLE IF NOT EXISTS commit_parents (sha TEXT NOT NULL, parent TEXT NOT NULL, idx INTEGER NOT NULL, PRIMARY KEY (sha, idx));
CREATE INDEX IF NOT EXISTS commit_parents_parent ON commit_parents(parent);
-- Version nodes by (live uri, commit): versionAt() walks first parents from a commit to the nearest version.
CREATE TABLE IF NOT EXISTS versions (of_uri TEXT NOT NULL, sha TEXT NOT NULL, uri TEXT NOT NULL, point INTEGER NOT NULL, PRIMARY KEY (of_uri, sha));
-- Commits that disappeared in a history rewrite (pins to them are reported as lost). Survives rebuilds.
CREATE TABLE IF NOT EXISTS lost_commits (sha TEXT PRIMARY KEY, lost_at TEXT NOT NULL, rewrite_new_head TEXT);
CREATE INDEX IF NOT EXISTS commit_uris_uri ON commit_uris(uri);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_commits USING fts5(sha UNINDEXED, subject, body, trailers, tokenize = 'porter unicode61');
`;

/** Tables rebuilt from git (everything except the embedding cache, vectors and the queue state). */
export const DERIVED_TABLES = ['files', 'docs', 'sections', 'nodes', 'edges', 'symbols', 'symbols_trgm', 'code_refs', 'fts_sections', 'fts_raw', 'chunks', 'embed_jobs', 'commits', 'commit_uris', 'fts_commits', 'commit_parents', 'versions'];

/** vec0 table for a vector size; vectors are keyed by `<model_id>:<content_hash>` and partitioned by model. */
export const vecTable = (dims: number) => `vec_chunks_${dims}`;

export function ensureVecTable(db: DB, dims: number): string {
  const name = vecTable(dims);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(id TEXT PRIMARY KEY, model_id TEXT PARTITION KEY, embedding float[${dims}] distance_metric=cosine)`);
  return name;
}

/** Open (creating) the index database, load sqlite-vec and create the schema. Wipes derived tables on a schema change. */
export function openIndexDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  sqliteVec.load(db);
  const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'index_state'").get();
  const version = hasState ? (db.prepare('SELECT schema_version AS v FROM index_state WHERE id = 1').get() as { v: number } | undefined)?.v : undefined;
  if (hasState && version !== SCHEMA_VERSION) {
    // Schema changed: drop everything derived (the embedding cache and vectors survive) and recreate.
    db.exec('DROP VIEW IF EXISTS entries; DROP TABLE IF EXISTS index_state;');
    for (const t of DERIVED_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  db.exec(DDL);
  if (!db.prepare('SELECT 1 FROM index_state WHERE id = 1').get()) {
    db.prepare('INSERT INTO index_state (id, schema_version) VALUES (1, ?)').run(SCHEMA_VERSION);
  }
  return db;
}

export function clearDerived(db: DB): void {
  db.transaction(() => {
    for (const t of DERIVED_TABLES) db.exec(`DELETE FROM ${t}`);
    db.prepare('UPDATE index_state SET head_commit = NULL, head_seq = 0 WHERE id = 1').run();
  })();
}

export const json = (v: unknown): string => JSON.stringify(v ?? null);
export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

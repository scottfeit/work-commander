import fs from 'node:fs';
import path from 'node:path';
import { Kysely, SqliteDialect, PostgresDialect, sql, type Generated } from 'kysely';

/**
 * Storage is SQLite for local hosting and Postgres (Cloud SQL) on GCP. Columns are kept to
 * portable types: JSON lives in TEXT, booleans in INTEGER, timestamps as ISO-8601 TEXT.
 */
export interface DB {
  settings: { key: string; value: string };
  credentials: { id: string; label: string; backend: string; ref: string; updated_at: string };
  people: {
    id: string;
    name: string;
    email: string;
    title: string | null;
    department: string | null;
    manager_email: string | null;
    slack_user_id: string | null;
    atlassian_account_id: string | null;
    source: string;
  };
  streams: {
    id: string;
    title: string;
    summary: string;
    status: string;
    labels: string;
    ticket_target: string | null;
    agent_session_id: string | null;
    unread: number;
    pending: number;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    last_activity_at: string;
  };
  items: {
    id: string;
    stream_id: string | null;
    source: string;
    kind: string;
    external_id: string;
    title: string;
    url: string | null;
    data: string;
    updated_at: string;
  };
  inbound_events: {
    id: string;
    source: string;
    external_id: string;
    item_id: string | null;
    received_at: string;
    processed_at: string | null;
    relevant: number | null;
    decision: string | null;
  };
  proposals: {
    id: string;
    stream_id: string | null;
    run_id: string;
    kind: string;
    system: string;
    title: string;
    rationale: string;
    payload: string;
    original_payload: string;
    editable: string;
    depends_on: string;
    status: string;
    result: string | null;
    error: string | null;
    created_at: string;
    decided_at: string | null;
    executed_at: string | null;
  };
  chat_messages: {
    id: string;
    stream_id: string | null;
    role: string;
    content: string;
    meta: string;
    created_at: string;
  };
  grants: {
    id: string;
    stream_id: string | null;
    item_reference: string;
    item_title: string;
    allowed_hosts: string;
    auth_scheme: string;
    status: string;
    expires_at: string | null;
    created_at: string;
  };
  sync_state: { key: string; value: string };
  /** Original HTML of email messages (the item's data keeps only the text), so the rendered view survives deletion at the source. */
  message_html: { item_id: string; message_id: string; html: string };
  /** Every version of a stream's summary (the Overview), oldest first. `at` = when it became current; null for a version written before history was kept. */
  stream_summaries: { id: Generated<number>; stream_id: string; summary: string; by: string; at: string | null };
  /** Work handed off to Claude Code; RESULT.md in `folder` is brought back automatically. */
  handoffs: { id: string; stream_id: string; folder: string; created_at: string; result_mtime: string | null; returned_at: string | null };
  /** Files attached to drafts (uploaded by the PU or taken from a Claude Code hand-off folder). `data` is base64 so it works on SQLite and Postgres alike. */
  attachments: { id: string; stream_id: string | null; filename: string; mime_type: string; size: number; source: string; data: string; created_at: string };
  audit_log: {
    id: Generated<number>;
    at: string;
    actor: string;
    action: string;
    detail: string;
  };
}

export type Database = Kysely<DB>;

export async function openDatabase(url: string): Promise<{ db: Database; dialect: 'sqlite' | 'postgres' }> {
  if (url.startsWith('sqlite:')) {
    const file = url.slice('sqlite:'.length);
    const { default: SQLite } = await import('better-sqlite3');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = new SQLite(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: conn }) });
    await migrate(db, 'sqlite');
    return { db, dialect: 'sqlite' };
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const { default: pg } = await import('pg');
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 5 }) }) });
    await migrate(db, 'postgres');
    return { db, dialect: 'postgres' };
  }
  throw new Error(`Unsupported DATABASE_URL: ${url.split(':')[0]}`);
}

async function migrate(db: Database, dialect: 'sqlite' | 'postgres') {
  const s = db.schema;
  await s.createTable('settings').ifNotExists().addColumn('key', 'text', (c) => c.primaryKey()).addColumn('value', 'text', (c) => c.notNull()).execute();
  await s
    .createTable('credentials')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('backend', 'text', (c) => c.notNull())
    .addColumn('ref', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s
    .createTable('people')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('title', 'text')
    .addColumn('department', 'text')
    .addColumn('manager_email', 'text')
    .addColumn('slack_user_id', 'text')
    .addColumn('atlassian_account_id', 'text')
    .addColumn('source', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('people_email').ifNotExists().on('people').column('email').execute();
  await s
    .createTable('streams')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('summary', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('labels', 'text', (c) => c.notNull())
    .addColumn('ticket_target', 'text')
    .addColumn('agent_session_id', 'text')
    .addColumn('unread', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('closed_at', 'text')
    .addColumn('last_activity_at', 'text', (c) => c.notNull())
    .execute();
  await s
    .createTable('items')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('stream_id', 'text')
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('external_id', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('url', 'text')
    .addColumn('data', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('items_source_ext', ['source', 'external_id'])
    .execute();
  await s.createIndex('items_stream').ifNotExists().on('items').column('stream_id').execute();
  await s
    .createTable('inbound_events')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('external_id', 'text', (c) => c.notNull())
    .addColumn('item_id', 'text')
    .addColumn('received_at', 'text', (c) => c.notNull())
    .addColumn('processed_at', 'text')
    .addColumn('relevant', 'integer')
    .addColumn('decision', 'text')
    .addUniqueConstraint('inbound_source_ext', ['source', 'external_id'])
    .execute();
  await s
    .createTable('proposals')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('stream_id', 'text')
    .addColumn('run_id', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('system', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('rationale', 'text', (c) => c.notNull())
    .addColumn('payload', 'text', (c) => c.notNull())
    .addColumn('original_payload', 'text', (c) => c.notNull())
    .addColumn('editable', 'text', (c) => c.notNull())
    .addColumn('depends_on', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('result', 'text')
    .addColumn('error', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('decided_at', 'text')
    .addColumn('executed_at', 'text')
    .execute();
  await s.createIndex('proposals_stream').ifNotExists().on('proposals').columns(['stream_id', 'status']).execute();
  await s
    .createTable('chat_messages')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('stream_id', 'text')
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('content', 'text', (c) => c.notNull())
    .addColumn('meta', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('chat_stream').ifNotExists().on('chat_messages').columns(['stream_id', 'created_at']).execute();
  await s
    .createTable('grants')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('stream_id', 'text')
    .addColumn('item_reference', 'text', (c) => c.notNull())
    .addColumn('item_title', 'text', (c) => c.notNull())
    .addColumn('allowed_hosts', 'text', (c) => c.notNull())
    .addColumn('auth_scheme', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createTable('sync_state').ifNotExists().addColumn('key', 'text', (c) => c.primaryKey()).addColumn('value', 'text', (c) => c.notNull()).execute();
  let hist = s.createTable('stream_summaries').ifNotExists();
  hist =
    dialect === 'postgres'
      ? hist.addColumn('id', 'serial', (c) => c.primaryKey())
      : hist.addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement());
  await hist
    .addColumn('stream_id', 'text', (c) => c.notNull())
    .addColumn('summary', 'text', (c) => c.notNull())
    .addColumn('by', 'text', (c) => c.notNull())
    .addColumn('at', 'text')
    .execute();
  await s.createIndex('stream_summaries_stream').ifNotExists().on('stream_summaries').column('stream_id').execute();
  await s
    .createTable('handoffs')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('stream_id', 'text', (c) => c.notNull())
    .addColumn('folder', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('result_mtime', 'text')
    .addColumn('returned_at', 'text')
    .execute();
  await s
    .createTable('attachments')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('stream_id', 'text')
    .addColumn('filename', 'text', (c) => c.notNull())
    .addColumn('mime_type', 'text', (c) => c.notNull())
    .addColumn('size', 'integer', (c) => c.notNull())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('data', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s
    .createTable('message_html')
    .ifNotExists()
    .addColumn('item_id', 'text', (c) => c.notNull())
    .addColumn('message_id', 'text', (c) => c.notNull())
    .addColumn('html', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('message_html_pk', ['item_id', 'message_id'])
    .execute();
  let audit = s.createTable('audit_log').ifNotExists();
  audit =
    dialect === 'postgres'
      ? audit.addColumn('id', 'serial', (c) => c.primaryKey())
      : audit.addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement());
  await audit
    .addColumn('at', 'text', (c) => c.notNull())
    .addColumn('actor', 'text', (c) => c.notNull())
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('detail', 'text', (c) => c.notNull())
    .execute();
  void sql;
  // Columns added after the first release: older databases get them here (SQLite has no ADD COLUMN IF NOT EXISTS).
  if (dialect === 'postgres') {
    await sql`ALTER TABLE streams ADD COLUMN IF NOT EXISTS pending integer NOT NULL DEFAULT 0`.execute(db);
  } else {
    const cols = await sql<{ name: string }>`PRAGMA table_info(streams)`.execute(db);
    if (!cols.rows.some((c) => c.name === 'pending')) await sql`ALTER TABLE streams ADD COLUMN pending integer NOT NULL DEFAULT 0`.execute(db);
  }
}

export const now = () => new Date().toISOString();
export const j = (v: unknown) => JSON.stringify(v ?? null);
export function pj<T>(v: string | null | undefined, fallback: T): T {
  if (v == null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

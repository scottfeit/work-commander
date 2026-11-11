/**
 * Draft attachments, and read-only access to the files Claude Code produced in a stream's hand-off folder.
 *
 * Attachments are copied into the database when attached, so what the PU reviews is exactly what is sent,
 * even if the file on disk changes later. The agent can list, read and attach files only inside the
 * stream's hand-off folders, never elsewhere on the machine, and never hidden or secret-looking files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { AttachmentRef } from '@wc/shared';
import type { Database } from '../db/index.js';
import { now } from '../db/index.js';
import type { Repo } from './repo.js';
import { HttpError } from './errors.js';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Gmail rejects messages over 25 MB after base64 encoding, which adds about a third. */
export const MAX_EMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const MAX_READ_BYTES = 60_000;
const MAX_LIST = 300;

export interface OutFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
  '.py': 'text/x-python', '.js': 'text/javascript', '.ts': 'text/plain', '.sh': 'text/x-shellscript', '.sql': 'application/sql', '.log': 'text/plain',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tgz': 'application/gzip', '.whl': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const mimeFor = (filename: string) => MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
const isText = (mime: string) => mime.startsWith('text/') || ['application/json', 'application/yaml', 'application/xml', 'application/sql'].includes(mime);

/** Folders that are noise (dependencies, caches, VCS) and files that may hold secrets. */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'dist-info', '.idea', '.vscode']);
const SECRETISH = /(^|[/\\])(\.[^/\\]*|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|keystore)|.*credentials.*|.*secret.*)$/i;

const cleanName = (n: string) => path.basename(n).replace(/[\r\n"\\]/g, '_').slice(0, 200) || 'file';

export class AttachmentStore {
  constructor(
    private db: Database,
    private repo: Repo,
  ) {}

  async save(input: { streamId: string | null; filename: string; mimeType?: string; data: Buffer; source: 'upload' | 'claude-code' }): Promise<AttachmentRef> {
    if (input.data.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `${input.filename} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    const filename = cleanName(input.filename);
    const mimeType = input.mimeType && input.mimeType !== 'application/octet-stream' ? input.mimeType : mimeFor(filename);
    const row = { id: nanoid(12), stream_id: input.streamId, filename, mime_type: mimeType, size: input.data.length, source: input.source, data: input.data.toString('base64'), created_at: now() };
    await this.db.insertInto('attachments').values(row).execute();
    return { id: row.id, filename, mimeType, size: row.size };
  }

  async meta(id: string) {
    return this.db.selectFrom('attachments').select(['id', 'stream_id', 'filename', 'mime_type', 'size', 'source', 'created_at']).where('id', '=', id).executeTakeFirst();
  }

  async read(id: string) {
    const r = await this.db.selectFrom('attachments').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) throw new HttpError(404, 'Attachment not found');
    return { streamId: r.stream_id, file: { filename: r.filename, mimeType: r.mime_type, data: Buffer.from(r.data, 'base64') } as OutFile };
  }

  /** Resolve a draft's payload.attachments to file contents, refusing files that belong to another stream. */
  async resolve(refs: unknown, streamId: string | null): Promise<OutFile[]> {
    if (!Array.isArray(refs) || refs.length === 0) return [];
    const out: OutFile[] = [];
    for (const ref of refs) {
      const id = typeof ref === 'string' ? ref : (ref as AttachmentRef)?.id;
      if (!id) continue;
      const a = await this.read(id);
      if (a.streamId && streamId && a.streamId !== streamId) throw new Error(`Attachment ${a.file.filename} belongs to a different work stream`);
      out.push(a.file);
    }
    return out;
  }

  // ---------- Claude Code hand-off folders (agent access) ----------

  async folders(streamId: string) {
    const all = (await this.repo.listHandoffs()).filter((h) => h.stream_id === streamId);
    return [...new Set(all.map((h) => h.folder))].filter((f) => fs.existsSync(f));
  }

  /** Resolve a path the agent gave (relative to a hand-off folder, or absolute) to a real file inside one. */
  async locate(streamId: string, p: string) {
    const folders = await this.folders(streamId);
    if (!folders.length) throw new Error('This stream has no Claude Code hand-off folder. Files can only be read or attached from one.');
    for (const folder of folders) {
      const root = fs.realpathSync(folder);
      const cand = path.resolve(root, p);
      if (!fs.existsSync(cand)) continue;
      const real = fs.realpathSync(cand);
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`${p} is outside the hand-off folder`);
      const rel = path.relative(root, real);
      if (SECRETISH.test(rel) || rel.split(path.sep).some((part) => SKIP_DIRS.has(part))) throw new Error(`${p} is a hidden, dependency or secret-looking file and can't be used`);
      if (!fs.statSync(real).isFile()) throw new Error(`${p} is not a file`);
      return { folder: root, rel, abs: real };
    }
    throw new Error(`No file ${p} in the hand-off folder (${folders.join(', ')}). Use list_handoff_files.`);
  }

  async listFiles(streamId: string) {
    const out: { folder: string; path: string; size: number; modified: string }[] = [];
    for (const folder of await this.folders(streamId)) {
      const root = fs.realpathSync(folder);
      const walk = (dir: string) => {
        if (out.length >= MAX_LIST) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (out.length >= MAX_LIST) return;
          if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.name.endsWith('.egg-info')) continue;
          const abs = path.join(dir, e.name);
          const rel = path.relative(root, abs);
          if (e.isDirectory()) walk(abs);
          else if (e.isFile() && !SECRETISH.test(rel)) {
            const st = fs.statSync(abs);
            out.push({ folder: root, path: rel, size: st.size, modified: st.mtime.toISOString() });
          }
        }
      };
      walk(root);
    }
    return { files: out, truncated: out.length >= MAX_LIST };
  }

  async readText(streamId: string, p: string) {
    const f = await this.locate(streamId, p);
    const mime = mimeFor(f.rel);
    const buf = fs.readFileSync(f.abs);
    if (!isText(mime) && buf.subarray(0, 8000).includes(0)) return `${f.rel} is a binary file (${mime}, ${buf.length} bytes). It can be attached but not read.`;
    const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
    return buf.length > MAX_READ_BYTES ? `${text}\n…[truncated: ${buf.length} bytes total]` : text;
  }

  async attachFromHandoff(streamId: string, p: string) {
    const f = await this.locate(streamId, p);
    return this.save({ streamId, filename: path.basename(f.rel), data: fs.readFileSync(f.abs), source: 'claude-code' });
  }
}

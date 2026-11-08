import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OnePasswordSettings } from '@wc/shared';

const run = promisify(execFile);

export interface OpItemSummary {
  id: string;
  title: string;
  vault: string;
  urls: string[];
  category: string;
}

/** Field values a credential grant may use. Never sent to the model. */
export interface OpItemSecret {
  title: string;
  urls: string[];
  username?: string;
  password?: string;
  credential?: string; // API credential field
  fields: Record<string, string>;
}

/**
 * One interface over the three ways to reach 1Password, chosen in Settings:
 *  - service-account: @1password/sdk with a service account token (works locally and on GCP)
 *  - connect: a self-hosted 1Password Connect server
 *  - cli: the `op` CLI, unlocked by the PU's desktop app (local only)
 */
export interface OnePasswordClient {
  listItems(vault: string, query?: string): Promise<OpItemSummary[]>;
  getItem(vault: string, itemIdOrTitle: string): Promise<OpItemSecret>;
  /** Resolve an op://vault/item/field reference. */
  read(reference: string): Promise<string>;
  /** Create or replace a single-secret item; returns an op:// reference to its value. */
  upsertSecret(vault: string, title: string, value: string): Promise<string>;
}

export async function createOnePasswordClient(
  s: OnePasswordSettings,
  resolveSecret: (id: string) => Promise<string>,
): Promise<OnePasswordClient> {
  switch (s.mode) {
    case 'service-account': {
      if (!s.serviceAccountTokenId) throw new Error('1Password service account token is not configured');
      return new SdkClient(await resolveSecret(s.serviceAccountTokenId));
    }
    case 'connect': {
      if (!s.connect?.url || !s.connect.tokenId) throw new Error('1Password Connect URL/token not configured');
      return new ConnectClient(s.connect.url, await resolveSecret(s.connect.tokenId));
    }
    case 'cli':
      return new CliClient(s.cli?.account);
  }
}

const norm = (v: string) => v.trim().toLowerCase();

class SdkClient implements OnePasswordClient {
  private clientP: Promise<any>;
  constructor(token: string) {
    this.clientP = import('@1password/sdk').then((m) =>
      m.createClient({ auth: token, integrationName: 'Work Commander', integrationVersion: '0.1.0' }),
    );
  }
  private async vaultId(vault: string) {
    const c = await this.clientP;
    const vaults: any[] = await c.vaults.list();
    const v = vaults.find((x) => x.id === vault || norm(x.title) === norm(vault));
    if (!v) throw new Error(`1Password vault not found or not shared with the service account: ${vault}`);
    return v.id as string;
  }
  async listItems(vault: string, query?: string) {
    const c = await this.clientP;
    const vid = await this.vaultId(vault);
    const items: any[] = await c.items.list(vid);
    return items
      .filter((i) => !query || norm(i.title).includes(norm(query)))
      .map((i) => ({ id: i.id, title: i.title, vault, category: String(i.category), urls: (i.websites ?? []).map((w: any) => w.url) }));
  }
  async getItem(vault: string, idOrTitle: string): Promise<OpItemSecret> {
    const c = await this.clientP;
    const vid = await this.vaultId(vault);
    let id = idOrTitle;
    const list: any[] = await c.items.list(vid);
    const hit = list.find((i) => i.id === idOrTitle || norm(i.title) === norm(idOrTitle));
    if (!hit) throw new Error(`1Password item not found: ${idOrTitle}`);
    id = hit.id;
    const item = await c.items.get(vid, id);
    const fields: Record<string, string> = {};
    for (const f of item.fields ?? []) fields[f.title || f.id] = f.value;
    return {
      title: item.title,
      urls: (item.websites ?? []).map((w: any) => w.url),
      username: fields.username,
      password: fields.password,
      credential: fields.credential,
      fields,
    };
  }
  async read(ref: string) {
    const c = await this.clientP;
    return c.secrets.resolve(ref);
  }
  async upsertSecret(vault: string, title: string, value: string) {
    const m = await import('@1password/sdk');
    const c = await this.clientP;
    const vid = await this.vaultId(vault);
    const existing: any[] = await c.items.list(vid);
    for (const e of existing.filter((i) => i.title === title)) await c.items.delete(vid, e.id);
    const item = await c.items.create({
      category: m.ItemCategory.Password,
      vaultId: vid,
      title,
      fields: [{ id: 'password', title: 'password', fieldType: m.ItemFieldType.Concealed, value }],
      tags: ['work-commander'],
    });
    return `op://${vid}/${item.id}/password`;
  }
}

class ConnectClient implements OnePasswordClient {
  private op: any;
  private ready: Promise<void>;
  constructor(url: string, token: string) {
    this.ready = import('@1password/connect').then((m) => {
      this.op = m.OnePasswordConnect({ serverURL: url, token, keepAlive: true });
    });
  }
  private async vaultId(vault: string) {
    await this.ready;
    const vaults: any[] = await this.op.listVaults();
    const v = vaults.find((x) => x.id === vault || norm(x.name ?? '') === norm(vault));
    if (!v) throw new Error(`1Password vault not found via Connect: ${vault}`);
    return v.id as string;
  }
  async listItems(vault: string, query?: string) {
    const vid = await this.vaultId(vault);
    const items: any[] = await this.op.listItems(vid);
    return items
      .filter((i) => !query || norm(i.title ?? '').includes(norm(query)))
      .map((i) => ({ id: i.id, title: i.title, vault, category: i.category, urls: (i.urls ?? []).map((u: any) => u.href) }));
  }
  async getItem(vault: string, idOrTitle: string) {
    const vid = await this.vaultId(vault);
    let item: any;
    try {
      item = await this.op.getItemById(vid, idOrTitle);
    } catch {
      item = await this.op.getItemByTitle(vid, idOrTitle);
    }
    const fields: Record<string, string> = {};
    for (const f of item.fields ?? []) if (f.value != null) fields[f.label || f.id] = f.value;
    return {
      title: item.title,
      urls: (item.urls ?? []).map((u: any) => u.href),
      username: fields.username,
      password: fields.password,
      credential: fields.credential,
      fields,
    };
  }
  async read(ref: string) {
    const m = /^op:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(ref);
    if (!m) throw new Error(`Bad 1Password reference: ${ref}`);
    const item = await this.getItem(m[1], m[2]);
    const v = item.fields[m[3]];
    if (v == null) throw new Error(`Field ${m[3]} not found in ${m[2]}`);
    return v;
  }
  async upsertSecret(vault: string, title: string, value: string) {
    const vid = await this.vaultId(vault);
    try {
      const old = await this.op.getItemByTitle(vid, title);
      await this.op.deleteItemById(vid, old.id);
    } catch {
      /* not found */
    }
    const created = await this.op.createItem(vid, {
      title,
      category: 'PASSWORD',
      tags: ['work-commander'],
      fields: [{ id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value }],
    });
    return `op://${vid}/${created.id}/password`;
  }
}

class CliClient implements OnePasswordClient {
  constructor(private account?: string) {}
  private async op(args: string[], input?: string) {
    const full = [...args, ...(this.account ? ['--account', this.account] : [])];
    const p = run('op', full, { maxBuffer: 10 * 1024 * 1024 });
    if (input !== undefined) p.child.stdin?.end(input);
    const { stdout } = await p;
    return stdout;
  }
  async listItems(vault: string, query?: string) {
    const out = JSON.parse(await this.op(['item', 'list', '--vault', vault, '--format', 'json'])) as any[];
    return out
      .filter((i) => !query || norm(i.title).includes(norm(query)))
      .map((i) => ({ id: i.id, title: i.title, vault, category: i.category, urls: (i.urls ?? []).map((u: any) => u.href) }));
  }
  async getItem(vault: string, idOrTitle: string) {
    const item = JSON.parse(await this.op(['item', 'get', idOrTitle, '--vault', vault, '--format', 'json', '--reveal']));
    const fields: Record<string, string> = {};
    for (const f of item.fields ?? []) if (f.value != null) fields[f.label || f.id] = f.value;
    return {
      title: item.title,
      urls: (item.urls ?? []).map((u: any) => u.href),
      username: fields.username,
      password: fields.password,
      credential: fields.credential,
      fields,
    };
  }
  async read(ref: string) {
    return (await this.op(['read', ref])).replace(/\n$/, '');
  }
  async upsertSecret(vault: string, title: string, value: string) {
    try {
      await this.op(['item', 'delete', title, '--vault', vault]);
    } catch {
      /* not found */
    }
    // Pass the value on stdin via a JSON template so it never appears in the process list.
    const template = JSON.stringify({
      title,
      category: 'PASSWORD',
      tags: ['work-commander'],
      fields: [{ id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value }],
    });
    const created = JSON.parse(await this.op(['item', 'create', '--vault', vault, '--format', 'json', '-'], template));
    return `op://${vault}/${created.id}/password`;
  }
}

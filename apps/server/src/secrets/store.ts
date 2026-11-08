import type { CredentialInfo, SecretBackend, Settings } from '@wc/shared';
import type { Database } from '../db/index.js';
import { now } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { createOnePasswordClient } from '../onepassword/client.js';

/**
 * Credentials are never stored in the app database. Each credential row only records which
 * backend holds it and a reference (keychain service/account, Secret Manager resource name, or
 * op:// reference). The PU picks the backend per credential in Settings.
 */
interface Backend {
  write(id: string, value: string): Promise<string>; // returns ref
  read(ref: string): Promise<string>;
  remove(ref: string): Promise<void>;
}

const KEYCHAIN_SERVICE = 'work-commander';

class KeychainBackend implements Backend {
  async write(id: string, value: string) {
    const { Entry } = await import('@napi-rs/keyring');
    new Entry(KEYCHAIN_SERVICE, id).setPassword(value);
    return `${KEYCHAIN_SERVICE}/${id}`;
  }
  async read(ref: string) {
    const { Entry } = await import('@napi-rs/keyring');
    const [service, ...rest] = ref.split('/');
    const v = new Entry(service, rest.join('/')).getPassword();
    if (v == null) throw new Error(`Keychain entry missing: ${ref}`);
    return v;
  }
  async remove(ref: string) {
    const { Entry } = await import('@napi-rs/keyring');
    const [service, ...rest] = ref.split('/');
    try {
      new Entry(service, rest.join('/')).deletePassword();
    } catch {
      /* already gone */
    }
  }
}

class GcpSecretManagerBackend implements Backend {
  private clientP = import('@google-cloud/secret-manager').then((m) => new m.SecretManagerServiceClient());
  constructor(private projectId: string) {}
  private secretName(id: string) {
    return `wc-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }
  async write(id: string, value: string) {
    if (!this.projectId) throw new Error('Set the GCP project for Secret Manager in Settings → Secrets');
    const c = await this.clientP;
    const parent = `projects/${this.projectId}`;
    const name = `${parent}/secrets/${this.secretName(id)}`;
    try {
      await c.getSecret({ name });
    } catch {
      await c.createSecret({
        parent,
        secretId: this.secretName(id),
        secret: { replication: { automatic: {} }, labels: { app: 'work-commander' } },
      });
    }
    const [version] = await c.addSecretVersion({ parent: name, payload: { data: Buffer.from(value, 'utf8') } });
    // Disable older versions so only the current one is readable.
    const [versions] = await c.listSecretVersions({ parent: name });
    for (const v of versions) if (v.name !== version.name && v.state === 'ENABLED') await c.disableSecretVersion({ name: v.name! });
    return `${name}/versions/latest`;
  }
  async read(ref: string) {
    const c = await this.clientP;
    const [res] = await c.accessSecretVersion({ name: ref });
    return Buffer.from(res.payload!.data as Uint8Array).toString('utf8');
  }
  async remove(ref: string) {
    const c = await this.clientP;
    await c.deleteSecret({ name: ref.replace(/\/versions\/.*$/, '') }).catch(() => undefined);
  }
}

class OnePasswordBackend implements Backend {
  constructor(private getSettings: () => Promise<Settings>, private resolve: (id: string) => Promise<string>) {}
  private async client() {
    const s = await this.getSettings();
    if (!s.onepassword.secretsVault) throw new Error('Choose a 1Password vault for secrets in Settings → 1Password');
    return { c: await createOnePasswordClient(s.onepassword, this.resolve), vault: s.onepassword.secretsVault };
  }
  async write(id: string, value: string) {
    const { c, vault } = await this.client();
    return c.upsertSecret(vault, `Work Commander: ${id}`, value);
  }
  async read(ref: string) {
    const { c } = await this.client();
    return c.read(ref);
  }
  async remove() {
    /* Leave 1Password items in place; PU manages their vault. */
  }
}

export const CREDENTIAL_LABELS: Record<string, string> = {
  'anthropic.apiKey': 'Anthropic API key',
  'google.oauth.clientSecret': 'Google OAuth client secret',
  'google.oauth.refreshToken': 'Google OAuth refresh token',
  'slack.userToken': 'Slack user token (xoxp-)',
  'slack.appToken': 'Slack app-level token (xapp-) for Socket Mode',
  'atlassian.apiToken': 'Atlassian API token',
  'atlassian.webhookSecret': 'Jira webhook shared secret',
  'onepassword.serviceAccountToken': '1Password service account token',
  'onepassword.connectToken': '1Password Connect token',
  'workday.clientSecret': 'Workday API client secret',
  'workday.refreshToken': 'Workday refresh token',
  'workday.raasPassword': 'Workday RaaS integration user password',
};

export class SecretStore {
  private backends: Partial<Record<SecretBackend, Backend>> = {};
  private memo = new Map<string, { v: string; at: number }>();
  constructor(
    private db: Database,
    private cfg: AppConfig,
    private getSettings: () => Promise<Settings>,
  ) {}

  /** Keychain needs a desktop session; on Cloud Run only Secret Manager and 1Password apply. */
  availableBackends(): SecretBackend[] {
    return this.cfg.hosting === 'gcp' ? ['gcp-secret-manager', 'onepassword'] : ['keychain', 'gcp-secret-manager', 'onepassword'];
  }

  private async backend(b: SecretBackend): Promise<Backend> {
    if (!this.availableBackends().includes(b)) throw new Error(`Secret backend ${b} is not available when hosted on ${this.cfg.hosting}`);
    if (b === 'gcp-secret-manager') {
      const s = await this.getSettings();
      return new GcpSecretManagerBackend(s.secrets.gcpProjectId || this.cfg.gcpProjectId || '');
    }
    if (!this.backends[b]) {
      this.backends[b] =
        b === 'keychain'
          ? new KeychainBackend()
          : new OnePasswordBackend(this.getSettings, (id) => this.get(id));
    }
    return this.backends[b]!;
  }

  async set(id: string, value: string, backend: SecretBackend, label?: string) {
    if (backend === 'onepassword' && id.startsWith('onepassword.')) {
      throw new Error('1Password access tokens cannot be stored in 1Password itself; pick the keychain or Secret Manager');
    }
    const existing = await this.db.selectFrom('credentials').selectAll().where('id', '=', id).executeTakeFirst();
    const ref = await (await this.backend(backend)).write(id, value);
    if (existing && existing.backend !== backend) await (await this.backend(existing.backend as SecretBackend)).remove(existing.ref).catch(() => undefined);
    const row = { id, label: label ?? CREDENTIAL_LABELS[id] ?? id, backend, ref, updated_at: now() };
    await this.db
      .insertInto('credentials')
      .values(row)
      .onConflict((oc) => oc.column('id').doUpdateSet({ label: row.label, backend, ref, updated_at: row.updated_at }))
      .execute();
    this.memo.delete(id);
    return id;
  }

  /** Point a credential at an existing secret (e.g. an op:// reference) without writing. */
  async link(id: string, backend: SecretBackend, ref: string, label?: string) {
    const row = { id, label: label ?? CREDENTIAL_LABELS[id] ?? id, backend, ref, updated_at: now() };
    await this.db
      .insertInto('credentials')
      .values(row)
      .onConflict((oc) => oc.column('id').doUpdateSet({ label: row.label, backend, ref, updated_at: row.updated_at }))
      .execute();
    this.memo.delete(id);
  }

  async get(id: string): Promise<string> {
    const m = this.memo.get(id);
    if (m && Date.now() - m.at < 5 * 60_000) return m.v;
    const row = await this.db.selectFrom('credentials').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new Error(`Credential not configured: ${CREDENTIAL_LABELS[id] ?? id}`);
    const v = await (await this.backend(row.backend as SecretBackend)).read(row.ref);
    this.memo.set(id, { v, at: Date.now() });
    return v;
  }

  async has(id: string) {
    return !!(await this.db.selectFrom('credentials').select('id').where('id', '=', id).executeTakeFirst());
  }

  async remove(id: string) {
    const row = await this.db.selectFrom('credentials').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) return;
    await (await this.backend(row.backend as SecretBackend)).remove(row.ref).catch(() => undefined);
    await this.db.deleteFrom('credentials').where('id', '=', id).execute();
    this.memo.delete(id);
  }

  async list(): Promise<CredentialInfo[]> {
    const rows = await this.db.selectFrom('credentials').selectAll().orderBy('id').execute();
    return rows.map((r) => ({ id: r.id, label: r.label, backend: r.backend as SecretBackend, ref: r.ref, isSet: true, updatedAt: r.updated_at }));
  }
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackupStatus, CredentialInfo, EnvironmentInfo, FieldMapping, OrgChartSourceSettings, OrgChartSyncStatus, Person, Settings } from '@wc/shared';
import { get, post, put } from '../api';
import { BACKEND_LABEL, CredentialField, IngestionEditor, McpEditor, PolicyEditor, Row, Select, Text, Toggle } from './parts';

const SECTIONS = [
  ['pu', 'Primary user & org chart'],
  ['claude', 'Claude'],
  ['google', 'Google Workspace'],
  ['slack', 'Slack'],
  ['atlassian', 'Atlassian'],
  ['onepassword', '1Password'],
  ['secrets', 'Secrets'],
  ['backup', 'Backup'],
  ['status', 'Status & audit'],
] as const;
type Section = (typeof SECTIONS)[number][0];

export function SettingsPage({ env, onBack }: { env: EnvironmentInfo | null; onBack: () => void }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [creds, setCreds] = useState<CredentialInfo[]>([]);
  const [section, setSection] = useState<Section>(() => {
    const q = new URLSearchParams(location.search);
    const mcp = q.get('mcp');
    return q.get('google') ? 'google' : mcp === 'google' || mcp === 'slack' || mcp === 'atlassian' ? (mcp as Section) : 'pu';
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const flash = new URLSearchParams(location.search).get('google');

  const load = useCallback(async () => {
    const [st, cr] = await Promise.all([get<Settings>('/api/settings'), get<{ items: CredentialInfo[] }>('/api/credentials')]);
    setSaved(st);
    setS(st);
    setCreds(cr.items);
  }, []);
  useEffect(() => void load(), [load]);
  const reloadCreds = async () => {
    setCreds((await get<{ items: CredentialInfo[] }>('/api/credentials')).items);
    const st = await get<Settings>('/api/settings');
    setSaved(st);
    // Keep unsaved edits but pick up credential pointers the server just set.
    setS((cur) => (cur ? { ...st, ...diffKeep(cur, saved ?? st) } : st));
  };
  const dirty = useMemo(() => JSON.stringify(s) !== JSON.stringify(saved), [s, saved]);

  if (!s || !env) return <div className="settings loading">Loading settings…</div>;
  const up = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => setS({ ...s, [k]: typeof s[k] === 'object' && !Array.isArray(s[k]) ? { ...(s[k] as object), ...v } : v });
  const save = async () => {
    try {
      const next = await put<Settings>('/api/settings', { ...s, setupComplete: s.setupComplete || !!(s.pu.name && s.pu.email) });
      setSaved(next);
      setS(next);
      setMsg({ ok: true, text: 'Settings saved' });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };
  const credProps = { creds, backends: env.availableBackends, defaultBackend: s.secrets.defaultBackend, onSaved: reloadCreds };

  return (
    <div className="settings">
      <aside className="settings-nav">
        <button className="btn ghost small back" onClick={onBack}>
          ← Dashboard
        </button>
        <h1>Settings</h1>
        {SECTIONS.map(([k, label]) => (
          <button key={k} className={`nav-item ${section === k ? 'active' : ''}`} onClick={() => setSection(k)}>
            {label}
          </button>
        ))}
        <div className="muted small env">
          Hosting: {env.hosting}
          {env.demoMode ? ' · demo mode' : ''} · v{env.version}
        </div>
      </aside>
      <main className="settings-body">
        <div className="settings-bar">
          {!s.setupComplete && <span className="chip attention">Setup: add your name and email, connect your systems, then save.</span>}
          {msg && <span className={msg.ok ? 'ok' : 'error'}>{msg.text}</span>}
          <button className="btn primary right" disabled={!dirty} onClick={save}>
            {dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>

        {section === 'pu' && <PuSection s={s} up={up} credProps={credProps} />}

        {section === 'claude' && (
          <section>
            <h2>Claude</h2>
            <Row label="Provider" hint="How this instance reaches Claude">
              <Select
                value={s.claude.provider}
                onChange={(provider) => up('claude', { provider })}
                options={[
                  { value: 'claude-code-login', label: 'Claude Code login (this machine)', disabled: !env.availableProviders.includes('claude-code-login') },
                  { value: 'vertex', label: 'Claude on Google Vertex AI' },
                  { value: 'api-key', label: 'Anthropic API key' },
                ]}
              />
              {s.claude.provider === 'claude-code-login' && (
                <div className="small muted">
                  Uses your own <code>claude</code> sign-in on this computer. Run <code>claude</code> once in a terminal and log in. Only for a local instance used by you alone.
                </div>
              )}
              {env.hosting === 'gcp' && <div className="small muted">Claude Code login isn't available when hosted on GCP.</div>}
            </Row>
            {s.claude.provider === 'vertex' && (
              <>
                <Row label="Vertex project id">
                  <Text value={s.claude.vertex.projectId} onChange={(projectId) => up('claude', { vertex: { ...s.claude.vertex, projectId } })} />
                </Row>
                <Row label="Region" hint='"global" or a region such as us-east5'>
                  <Text value={s.claude.vertex.region} onChange={(region) => up('claude', { vertex: { ...s.claude.vertex, region } })} />
                </Row>
              </>
            )}
            {s.claude.provider === 'api-key' && <CredentialField id="anthropic.apiKey" label="Anthropic API key" {...credProps} />}
            <Row label="Model" hint='An alias ("sonnet", "opus") or a full model id'>
              <Text value={s.claude.model} onChange={(model) => up('claude', { model })} />
            </Row>
            <Row label="Draft automatically" hint="When triage spots something that needs a reply or a ticket, Claude prepares drafts right away. Nothing is sent without your approval unless a system's write policy is automatic.">
              <Toggle checked={s.claude.autoDraft} onChange={(autoDraft) => up('claude', { autoDraft })} label="Prepare drafts without asking first" />
            </Row>
            <Row label="Reopen closed streams" hint="New activity on a stream closed within this many days reopens it. Older closed streams stay closed and the activity starts a new work stream.">
              <input className="num" type="number" min={0} max={365} aria-label="Reopen closed streams within days" value={s.claude.reopenClosedWithinDays} onChange={(e) => up('claude', { reopenClosedWithinDays: Math.max(0, Number(e.target.value)) })} /> <span className="small muted">days</span>
            </Row>
            <Row label="Web research" hint="Lets Claude use web search and fetch during research">
              <Toggle checked={s.claude.allowWebResearch} onChange={(allowWebResearch) => up('claude', { allowWebResearch })} label="Allow web search" />
            </Row>
            <Row label="Max agent turns per run">
              <input className="num" type="number" min={5} max={200} value={s.claude.maxTurns} onChange={(e) => up('claude', { maxTurns: Number(e.target.value) })} />
            </Row>
            <TestButton label="Test Claude connection" run={() => post('/api/claude/test').then((r) => `Claude replied: ${r.reply}`)} note={dirty ? 'Save first' : undefined} />
          </section>
        )}

        {section === 'google' && (
          <section>
            <h2>Google Workspace</h2>
            {flash && <div className={flash === 'connected' ? 'ok' : 'error'}>{flash === 'connected' ? 'Google account connected.' : `Google sign-in: ${flash}`}</div>}
            <Toggle checked={s.google.enabled} onChange={(enabled) => up('google', { enabled })} label="Enabled" />
            <Row label="Connect with">
              <Select value={s.google.mode} onChange={(mode) => up('google', { mode, ingestion: mode === 'mcp' && s.google.ingestion === 'realtime' ? 'polling' : s.google.ingestion })} options={[{ value: 'oauth', label: 'OAuth (Gmail, Drive, Calendar APIs)' }, { value: 'mcp', label: 'MCP server' }]} />
            </Row>
            {s.google.mode === 'oauth' ? (
              <>
                <p className="muted small">
                  Create an OAuth client (type "Web application") in a GCP project you control, enable the Gmail, Drive and Calendar APIs, and add <code>{env.publicUrl}/api/oauth/google/callback</code> as an authorized redirect URI.
                </p>
                <Row label="OAuth client id">
                  <Text value={s.google.oauth.clientId} onChange={(clientId) => up('google', { oauth: { ...s.google.oauth, clientId } })} />
                </Row>
                <CredentialField id="google.oauth.clientSecret" label="OAuth client secret" {...credProps} />
                <Row label="Account" hint={s.google.oauth.connectedEmail ? `Connected as ${s.google.oauth.connectedEmail}` : 'Not connected'}>
                  <a className={`btn small ${dirty || !s.google.oauth.clientId ? 'disabled' : 'primary'}`} href={dirty ? undefined : '/api/oauth/google/start'}>
                    {s.google.oauth.connectedEmail ? 'Reconnect Google' : 'Connect Google'}
                  </a>
                  {s.google.oauth.connectedEmail && (
                    <button
                      className="btn small danger"
                      disabled={dirty}
                      onClick={async () => {
                        if (!confirm(`Disconnect ${s.google.oauth.connectedEmail}? Gmail, Drive and Calendar will stop syncing until you connect again.`)) return;
                        try {
                          const r = await post<{ revoked: boolean }>('/api/oauth/google/disconnect');
                          history.replaceState(null, '', location.pathname);
                          await load();
                          setMsg({ ok: true, text: r.revoked ? 'Google disconnected and access revoked.' : 'Google disconnected. Revoking at Google failed, so also remove access at myaccount.google.com/permissions.' });
                        } catch (e: any) {
                          setMsg({ ok: false, text: e.message });
                        }
                      }}
                    >
                      Disconnect
                    </button>
                  )}
                  {dirty && <span className="small muted"> Save first</span>}
                </Row>
                <Row label="Inbox filter" hint="Gmail query used for the first sync">
                  <Text value={s.google.oauth.gmailQuery} onChange={(gmailQuery) => up('google', { oauth: { ...s.google.oauth, gmailQuery } })} />
                </Row>
              </>
            ) : (
              <McpEditor value={s.google.mcp!} onChange={(mcp) => up('google', { mcp })} creds={creds} system="google" dirty={dirty} credProps={credProps} publicUrl={env.publicUrl} />
            )}
            <IngestionEditor
              mode={s.google.ingestion}
              seconds={s.google.pollSeconds}
              realtimeAvailable={s.google.mode === 'oauth'}
              realtimeHint={s.google.mode === 'oauth' ? 'Real time uses Gmail push notifications through a Pub/Sub topic and pull subscription.' : 'MCP mode supports polling only.'}
              onChange={(ingestion, pollSeconds) => up('google', { ingestion, pollSeconds })}
            />
            {s.google.mode === 'oauth' && s.google.ingestion === 'realtime' && (
              <>
                <Row label="Pub/Sub topic" hint="Grant gmail-api-push@system.gserviceaccount.com the Publisher role on it">
                  <Text value={s.google.oauth.pubsubTopic} placeholder="projects/PROJECT/topics/wc-gmail" onChange={(pubsubTopic) => up('google', { oauth: { ...s.google.oauth, pubsubTopic } })} />
                </Row>
                <Row label="Pull subscription">
                  <Text value={s.google.oauth.pubsubSubscription} placeholder="projects/PROJECT/subscriptions/wc-gmail-pull" onChange={(pubsubSubscription) => up('google', { oauth: { ...s.google.oauth, pubsubSubscription } })} />
                </Row>
              </>
            )}
            <h3>Approvals</h3>
            <PolicyEditor value={s.google.policy} onChange={(policy) => up('google', { policy })} />
            <TestButton label="Test" run={() => post('/api/integrations/google/test').then(fmtTest)} note={dirty ? 'Save first' : undefined} />
          </section>
        )}

        {section === 'slack' && (
          <section>
            <h2>Slack</h2>
            <Toggle checked={s.slack.enabled} onChange={(enabled) => up('slack', { enabled })} label="Enabled" />
            <Row label="Connect with">
              <Select value={s.slack.mode} onChange={(mode) => up('slack', { mode, ingestion: mode === 'mcp' && s.slack.ingestion === 'realtime' ? 'polling' : s.slack.ingestion })} options={[{ value: 'api', label: 'Slack app tokens (API)' }, { value: 'mcp', label: 'MCP server' }]} />
            </Row>
            {s.slack.mode === 'api' ? (
              <>
                <p className="muted small">
                  Create a Slack app from <code>deploy/slack-app-manifest.yaml</code>, install it to your workspace, and paste the tokens. The user token posts messages as you.
                </p>
                <CredentialField id="slack.userToken" label="User OAuth token" placeholder="xoxp-…" {...credProps} />
                <CredentialField id="slack.appToken" label="App-level token (Socket Mode)" placeholder="xapp-…" {...credProps} />
              </>
            ) : (
              <McpEditor value={s.slack.mcp!} onChange={(mcp) => up('slack', { mcp })} creds={creds} system="slack" dirty={dirty} credProps={credProps} publicUrl={env.publicUrl} />
            )}
            <Row label="Watched channels" hint="Also look at new messages in the channels you tick, not only DMs, mentions and threads you're in">
              <ChannelPicker value={s.slack.watchedChannels} onChange={(watchedChannels) => up('slack', { watchedChannels })} canLoad={!dirty} />
            </Row>
            <IngestionEditor
              mode={s.slack.ingestion}
              seconds={s.slack.pollSeconds}
              realtimeAvailable={s.slack.mode === 'api'}
              realtimeHint={s.slack.mode === 'api' ? 'Real time uses Socket Mode (needs the app-level token). Polling checks mentions, DMs and tracked threads.' : 'MCP mode supports polling only.'}
              onChange={(ingestion, pollSeconds) => up('slack', { ingestion, pollSeconds })}
            />
            <h3>Approvals</h3>
            <PolicyEditor value={s.slack.policy} onChange={(policy) => up('slack', { policy })} />
            <TestButton label="Test" run={() => post('/api/integrations/slack/test').then(fmtTest)} note={dirty ? 'Save first' : undefined} />
          </section>
        )}

        {section === 'atlassian' && <AtlassianSection s={s} up={up} credProps={credProps} creds={creds} env={env} dirty={dirty} />}

        {section === 'onepassword' && (
          <section>
            <h2>1Password</h2>
            <p className="muted small">
              Agents ask for access to systems you control through 1Password. You approve each request in the draft pane. Claude never sees the secret: approved credentials are injected server-side into requests to the allowed hosts only.
            </p>
            <Toggle checked={s.onepassword.enabled} onChange={(enabled) => up('onepassword', { enabled })} label="Enabled" />
            <Row label="Connect with">
              <Select
                value={s.onepassword.mode}
                onChange={(mode) => up('onepassword', { mode })}
                options={[
                  { value: 'service-account', label: 'Service account token' },
                  { value: 'connect', label: '1Password Connect server' },
                  { value: 'cli', label: '1Password CLI + desktop app (local only)', disabled: env.hosting !== 'local' },
                ]}
              />
            </Row>
            {s.onepassword.mode === 'service-account' && <CredentialField id="onepassword.serviceAccountToken" label="Service account token" placeholder="ops_…" {...credProps} />}
            {s.onepassword.mode === 'connect' && (
              <>
                <Row label="Connect server URL">
                  <Text value={s.onepassword.connect?.url} onChange={(url) => up('onepassword', { connect: { ...s.onepassword.connect, url } })} />
                </Row>
                <CredentialField id="onepassword.connectToken" label="Connect access token" {...credProps} />
              </>
            )}
            {s.onepassword.mode === 'cli' && (
              <Row label="Account" hint="Optional: account shorthand or sign-in address if you have several">
                <Text value={s.onepassword.cli?.account} onChange={(account) => up('onepassword', { cli: { account } })} />
              </Row>
            )}
            <Row label="Vault agents may request from">
              <Text value={s.onepassword.accessVault} onChange={(accessVault) => up('onepassword', { accessVault })} placeholder="Agent Access" />
            </Row>
            <Row label="Vault for dashboard secrets" hint="Used when you choose 1Password as a credential's storage">
              <Text value={s.onepassword.secretsVault} onChange={(secretsVault) => up('onepassword', { secretsVault })} placeholder="Work Commander" />
            </Row>
            <Row label="Grants expire after (minutes)">
              <input className="num" type="number" min={5} value={s.onepassword.grantTtlMinutes} onChange={(e) => up('onepassword', { grantTtlMinutes: Number(e.target.value) })} />
            </Row>
            <h3>Approvals</h3>
            <PolicyEditor value={s.onepassword.policy} onChange={(policy) => up('onepassword', { policy })} />
            <p className="small muted">Access requests always need your approval, whatever the write policy.</p>
            <TestButton label="List vault items" run={() => get('/api/onepassword/items').then((r: any[]) => `${r.length} items: ${r.slice(0, 5).map((x) => x.title).join(', ')}`)} note={dirty ? 'Save first' : undefined} />
          </section>
        )}

        {section === 'secrets' && (
          <section>
            <h2>Secrets</h2>
            <p className="muted small">API keys and tokens never go in the dashboard database. Each one lives in the backend you pick for it. The database stores only a reference.</p>
            <Row label="Default storage for new credentials">
              <Select value={s.secrets.defaultBackend} onChange={(defaultBackend) => up('secrets', { defaultBackend })} options={env.availableBackends.map((b) => ({ value: b, label: BACKEND_LABEL[b] }))} />
            </Row>
            <Row label="GCP project for Secret Manager" hint="Uses Application Default Credentials (gcloud auth application-default login locally, the service account on Cloud Run)">
              <Text value={s.secrets.gcpProjectId} onChange={(gcpProjectId) => up('secrets', { gcpProjectId })} />
            </Row>
            <h3>Stored credentials</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Credential</th>
                  <th>Stored in</th>
                  <th>Reference</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.id}>
                    <td>{c.label}</td>
                    <td>{BACKEND_LABEL[c.backend]}</td>
                    <td>
                      <code className="small">{c.ref}</code>
                    </td>
                    <td className="small">{new Date(c.updatedAt).toLocaleString()}</td>
                  </tr>
                ))}
                {creds.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      None yet. Add them in each integration's section.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <h3>Custom credential</h3>
            <p className="muted small">For MCP server headers and environment variables.</p>
            <CustomCredential credProps={credProps} />
          </section>
        )}

        {section === 'backup' && <BackupSection s={s} up={up} env={env} />}
        {section === 'status' && <StatusSection />}
      </main>
    </div>
  );
}

function diffKeep(cur: Settings, base: Settings): Partial<Settings> {
  // Return top-level sections the PU has edited locally (so a credential save doesn't wipe them).
  const out: Partial<Settings> = {};
  for (const k of Object.keys(cur) as (keyof Settings)[]) if (JSON.stringify(cur[k]) !== JSON.stringify(base[k])) (out as any)[k] = cur[k];
  return out;
}

const fmtTest = (r: any) => (r.tools ? `MCP OK: ${r.tools.length} tools (${r.tools.filter((t: any) => t.readOnly).length} read-only)` : r.detail);

function TestButton({ label, run, note }: { label: string; run: () => Promise<string>; note?: string }) {
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="test">
      <button
        className="btn small"
        disabled={busy || !!note}
        onClick={async () => {
          setBusy(true);
          try {
            setOut({ ok: true, text: await run() });
          } catch (e: any) {
            setOut({ ok: false, text: e.message });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Testing…' : label}
      </button>
      {note && <span className="small muted"> {note}</span>}
      {out && <div className={`small ${out.ok ? 'ok' : 'error'}`}>{out.text}</div>}
    </div>
  );
}

function CustomCredential({ credProps }: { credProps: any }) {
  const [id, setId] = useState('');
  return (
    <>
      <Row label="Credential id" hint="e.g. mcp.atlassian.token">
        <Text value={id} onChange={(v) => setId(v.replace(/[^\w.-]/g, ''))} />
      </Row>
      {id && <CredentialField id={id} label={id} {...credProps} />}
    </>
  );
}

type Up = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => void;

function PuSection({ s, up, credProps }: { s: Settings; up: Up; credProps: any }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [preview, setPreview] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [q, setQ] = useState('');
  const loadPeople = () => get<Person[]>('/api/people').then(setPeople);
  const [sync, setSync] = useState<OrgChartSyncStatus>({});
  const [updating, setUpdating] = useState(false);
  const loadSync = () => get<OrgChartSyncStatus>('/api/orgchart/sync').then(setSync).catch(() => undefined);
  useEffect(() => {
    void loadPeople();
    void loadSync();
  }, []);
  const updateNow = async () => {
    setOut(null);
    setUpdating(true);
    try {
      const st = await post<OrgChartSyncStatus>('/api/orgchart/refresh');
      setSync(st);
      void loadPeople();
    } catch (e: any) {
      setOut({ ok: false, text: e.message });
    } finally {
      setUpdating(false);
    }
  };
  const oc = s.orgChart;
  const setOc = async (type: OrgChartSourceSettings['type']) => {
    if (type === 'none') return up('orgChart', { type: 'none' } as any);
    const mapping = (await get<FieldMapping>(`/api/orgchart/default-mapping/${type}`)) ?? { name: '', email: '' };
    const base: any = { type, mapping };
    if (type === 'workday-rest') Object.assign(base, { host: '', tenant: '', clientId: '' });
    if (type === 'workday-raas') Object.assign(base, { url: '', username: '' });
    if (type === 'jira-assets') Object.assign(base, { workspaceId: '', aql: 'objectType = "Employee"' });
    setS(base);
  };
  const setS = (v: any) => up('orgChart', v as never);
  const run = async (previewOnly: boolean) => {
    setOut(null);
    try {
      let body: FormData | undefined;
      if (oc.type === 'file') {
        if (!file) throw new Error('Choose a file');
        body = new FormData();
        body.append('file', file);
      }
      const r = await fetch(`/api/orgchart/import${previewOnly ? '?preview=1' : ''}`, { method: 'POST', body });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (previewOnly) setPreview(j);
      else {
        setOut({ ok: true, text: `Imported ${j.imported} people${j.skipped ? `, skipped ${j.skipped} without name/email` : ''}` });
        void loadPeople();
      }
    } catch (e: any) {
      setOut({ ok: false, text: e.message });
    }
  };
  const mapping = (oc as any).mapping as FieldMapping | undefined;
  const shown = people.filter((p) => !q || `${p.name} ${p.email} ${p.title} ${p.department}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <section>
      <h2>Primary user</h2>
      <p className="muted small">Claude acts for this person. It treats messages aimed at them as relevant and everything else as noise.</p>
      <Row label="Name">
        <Text value={s.pu.name} onChange={(name) => up('pu', { name })} />
      </Row>
      <Row label="Work email">
        <Text value={s.pu.email} onChange={(email) => up('pu', { email: email.trim() })} type="email" />
      </Row>
      <Row label="Org function" hint="e.g. IT Systems Administration">
        <Text value={s.pu.orgFunction} onChange={(orgFunction) => up('pu', { orgFunction })} />
      </Row>
      <Row label="Other names" hint="Nicknames, aliases, other emails (comma separated)">
        <Text value={s.pu.aliases.join(', ')} onChange={(v) => up('pu', { aliases: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
      </Row>
      <Row label="What matters / what's noise" hint="Free text Claude uses when triaging">
        <textarea rows={3} value={s.pu.relevanceNotes} onChange={(e) => up('pu', { relevanceNotes: e.target.value })} placeholder="I own access requests and SaaS integrations. Vendor newsletters are noise." />
      </Row>
      <Row label="Linked identities" hint="Filled in by each integration's Test button">
        <span className="small">
          Slack: {s.pu.slackUserId ?? '—'} · Atlassian: {s.pu.atlassianAccountId ?? '—'}
        </span>
      </Row>

      <h2>Org chart</h2>
      <p className="muted small">The org chart tells Claude who people are (titles, teams, managers) so it can judge relevance and pick the right person to ask.</p>
      <Row label="Source">
        <Select
          value={oc.type}
          onChange={setOc}
          options={[
            { value: 'none', label: 'None' },
            { value: 'workday-rest', label: 'Workday REST API' },
            { value: 'workday-raas', label: 'Workday report (RaaS)' },
            { value: 'file', label: 'File upload (CSV/XLSX)' },
            { value: 'jira-assets', label: 'Jira Assets' },
          ]}
        />
      </Row>
      {oc.type === 'workday-rest' && (
        <>
          <Row label="Workday host" hint="e.g. wd2-impl-services1.workday.com">
            <Text value={oc.host} onChange={(host) => setS({ ...oc, host })} />
          </Row>
          <Row label="Tenant">
            <Text value={oc.tenant} onChange={(tenant) => setS({ ...oc, tenant })} />
          </Row>
          <Row label="API client id">
            <Text value={oc.clientId} onChange={(clientId) => setS({ ...oc, clientId })} />
          </Row>
          <CredentialField id="workday.clientSecret" label="API client secret" {...credProps} />
          <CredentialField id="workday.refreshToken" label="Refresh token" {...credProps} />
        </>
      )}
      {oc.type === 'workday-raas' && (
        <>
          <Row label="Report URL" hint="The report's web service URL (JSON format is requested automatically)">
            <Text value={oc.url} onChange={(url) => setS({ ...oc, url })} />
          </Row>
          <Row label="Integration user">
            <Text value={oc.username} onChange={(username) => setS({ ...oc, username })} />
          </Row>
          <CredentialField id="workday.raasPassword" label="Integration user password" {...credProps} />
          <Row label="Update every" hint="hours. The report is re-pulled on this schedule to pick up org changes">
            <input
              type="number"
              min={1}
              step={1}
              value={oc.updateEveryHours ?? 24}
              onChange={(e) => setS({ ...oc, updateEveryHours: Math.max(1, Math.floor(Number(e.target.value)) || 1) })}
            />
          </Row>
          <div className="inline">
            <button className="btn small" disabled={updating} onClick={() => void updateNow()}>
              {updating ? 'Updating…' : 'Update now'}
            </button>
            <span className="small muted">Uses the saved settings. If the report can't be read or a mapped field is missing, the current org chart is kept.</span>
          </div>
          {sync.lastSuccessAt && <div className="small muted">Last updated {new Date(sync.lastSuccessAt).toLocaleString()} · {sync.lastCount} people</div>}
          {sync.lastError && (
            <div className="small error">
              Last update failed{sync.lastAttemptAt ? ` (${new Date(sync.lastAttemptAt).toLocaleString()})` : ''}: {sync.lastError}. The existing org chart was kept.
            </div>
          )}
        </>
      )}
      {oc.type === 'jira-assets' && (
        <>
          <Row label="Assets workspace id" hint="Uses the Atlassian site credentials from the Atlassian section">
            <Text value={oc.workspaceId} onChange={(workspaceId) => setS({ ...oc, workspaceId })} />
          </Row>
          <Row label="AQL query">
            <Text value={oc.aql} onChange={(aql) => setS({ ...oc, aql })} />
          </Row>
        </>
      )}
      {oc.type === 'file' && (
        <Row label="File" hint="First row is the header">
          <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Row>
      )}
      {mapping && (
        <>
          <h3>Field mapping</h3>
          <p className="muted small">Column names or dot paths in the source records. Preview shows the available fields.</p>
          {(['name', 'email', 'title', 'department'] as (keyof FieldMapping)[]).map((k) => (
            <Row key={k} label={k[0].toUpperCase() + k.slice(1)}>
              <Text value={mapping[k] as string | undefined} onChange={(v) => setS({ ...oc, mapping: { ...mapping, [k]: v } })} />
            </Row>
          ))}
          {oc.type === 'workday-raas' && (
            <Row label="Manager link" hint="How each person is matched to their manager">
              <select value={mapping.managerLink ?? 'email'} onChange={(e) => setS({ ...oc, mapping: { ...mapping, managerLink: e.target.value as 'email' | 'employeeId' } })}>
                <option value="email">Manager email</option>
                <option value="employeeId">Manager employee ID</option>
              </select>
            </Row>
          )}
          {(oc.type === 'workday-raas' && mapping.managerLink === 'employeeId'
            ? (['employeeId', 'managerEmployeeId'] as (keyof FieldMapping)[])
            : (['managerEmail'] as (keyof FieldMapping)[])
          ).map((k) => (
            <Row key={k} label={{ managerEmail: 'Manager email', employeeId: 'Employee ID', managerEmployeeId: 'Manager employee ID'}[k as string]!}>
              <Text value={mapping[k] as string | undefined} onChange={(v) => setS({ ...oc, mapping: { ...mapping, [k]: v } })} />
            </Row>
          ))}
          <div className="inline">
            <button className="btn small" onClick={() => run(true)}>
              Preview
            </button>
            <button className="btn small primary" onClick={() => run(false)}>
              Import
            </button>
            <span className="small muted">Save settings before previewing or importing.</span>
          </div>
          {out && <div className={`small ${out.ok ? 'ok' : 'error'}`}>{out.text}</div>}
          {preview && (
            <div className="preview">
              <div className="small">
                {preview.total} records · {preview.mappedTotal} map to a person. Fields: <code>{preview.fields.join(', ')}</code>
              </div>
              <pre className="small">{JSON.stringify(preview.mapped, null, 2)}</pre>
            </div>
          )}
        </>
      )}
      <h3>People · {people.length}</h3>
      <input className="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Title</th>
            <th>Department</th>
            <th>Manager</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {shown.slice(0, 200).map((p) => (
            <tr key={p.id} className={p.email === s.pu.email.toLowerCase() ? 'me' : ''}>
              <td>{p.name}</td>
              <td>{p.email}</td>
              <td>{p.title}</td>
              <td>{p.department}</td>
              <td>{p.managerEmail}</td>
              <td className="small muted">{p.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function AtlassianSection({ s, up, credProps, creds, env, dirty }: { s: Settings; up: Up; credProps: any; creds: CredentialInfo[]; env: EnvironmentInfo; dirty: boolean }) {
  const a = s.atlassian;
  const [desks, setDesks] = useState<{ id: string; projectKey: string; name: string }[]>([]);
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const t = a.defaultTicketTarget ?? { flavor: 'jsm' as const, projectKey: '', typeId: '', serviceDeskId: '' };
  const setT = (v: Partial<typeof t>) => up('atlassian', { defaultTicketTarget: { ...t, ...v } });
  const loadDesks = () =>
    get('/api/atlassian/servicedesks')
      .then(setDesks)
      .catch((e) => setErr(e.message));
  return (
    <section>
      <h2>Atlassian</h2>
      <Toggle checked={a.enabled} onChange={(enabled) => up('atlassian', { enabled })} label="Enabled" />
      <Row label="Connect with">
        <Select value={a.mode} onChange={(mode) => up('atlassian', { mode, ingestion: mode === 'mcp' && a.ingestion === 'realtime' ? 'polling' : a.ingestion })} options={[{ value: 'api', label: 'API token (Jira, JSM, Confluence REST)' }, { value: 'mcp', label: 'MCP server' }]} />
      </Row>
      {a.mode === 'api' ? (
        <>
          <Row label="Site URL">
            <Text value={a.api.siteUrl} onChange={(siteUrl) => up('atlassian', { api: { ...a.api, siteUrl } })} placeholder="https://yourco.atlassian.net" />
          </Row>
          <Row label="Account email">
            <Text value={a.api.email} onChange={(email) => up('atlassian', { api: { ...a.api, email } })} />
          </Row>
          <CredentialField id="atlassian.apiToken" label="API token" {...credProps} />
        </>
      ) : (
        <McpEditor value={a.mcp!} onChange={(mcp) => up('atlassian', { mcp })} creds={creds} system="atlassian" dirty={dirty} credProps={credProps} publicUrl={env.publicUrl} />
      )}
      <Row label="Tickets to watch (JQL)" hint="Tickets attached to open streams are always watched too">
        <Text value={a.jql} onChange={(jql) => up('atlassian', { jql })} />
      </Row>
      <IngestionEditor
        mode={a.ingestion}
        seconds={a.pollSeconds}
        realtimeAvailable={a.mode === 'api'}
        realtimeHint={a.mode === 'api' ? 'Real time uses a Jira webhook, which needs a URL Jira can reach (GCP hosting, or a tunnel locally). A slow safety poll keeps running.' : 'MCP mode supports polling only.'}
        onChange={(ingestion, pollSeconds) => up('atlassian', { ingestion, pollSeconds })}
      />
      {a.mode === 'api' && a.ingestion === 'realtime' && (
        <>
          <CredentialField id="atlassian.webhookSecret" label="Webhook shared secret" placeholder="Any long random string" {...credProps} />
          <Row label="Webhook URL" hint="In Jira: Settings → System → WebHooks. Events: issue created/updated, comment created.">
            <code className="small">{env.publicUrl}/api/webhooks/jira?secret=&lt;your secret&gt;</code>
          </Row>
        </>
      )}
      <h3>Default ticket target</h3>
      <p className="muted small">Where new tickets go unless a stream overrides it.</p>
      <Row label="Type">
        <Select value={t.flavor} onChange={(flavor) => setT({ flavor })} options={[{ value: 'jsm', label: 'JSM service request' }, { value: 'jira', label: 'Jira issue' }]} />
      </Row>
      {t.flavor === 'jsm' ? (
        <>
          <Row label="Service desk">
            <div className="inline">
              <select
                value={t.serviceDeskId ?? ''}
                onChange={(e) => {
                  const d = desks.find((x) => x.id === e.target.value);
                  setT({ serviceDeskId: e.target.value, projectKey: d?.projectKey ?? t.projectKey });
                  if (e.target.value) get(`/api/atlassian/requesttypes?desk=${e.target.value}`).then(setTypes).catch((x) => setErr(x.message));
                }}
              >
                <option value="">{t.serviceDeskId ? `Desk ${t.serviceDeskId} (${t.projectKey})` : 'Select…'}</option>
                {desks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.projectKey})
                  </option>
                ))}
              </select>
              <button className="btn ghost small" disabled={dirty} onClick={loadDesks}>
                Load from Jira
              </button>
            </div>
          </Row>
          <Row label="Request type">
            <select value={t.typeId} onChange={(e) => setT({ typeId: e.target.value })}>
              <option value="">{t.typeId ? `Type ${t.typeId}` : 'Select…'}</option>
              {types.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Row>
        </>
      ) : (
        <>
          <Row label="Project key">
            <Text value={t.projectKey} onChange={(projectKey) => setT({ projectKey })} />
          </Row>
          <Row label="Issue type">
            <Text value={t.typeId} onChange={(typeId) => setT({ typeId })} placeholder="Task" />
          </Row>
        </>
      )}
      {err && <div className="error small">{err}</div>}
      <h3>Approvals</h3>
      <PolicyEditor value={a.policy} onChange={(policy) => up('atlassian', { policy })} />
      <TestButton label="Test" run={() => post('/api/integrations/atlassian/test').then(fmtTest)} note={dirty ? 'Save first' : undefined} />
    </section>
  );
}

type SlackChannel = { id: string; name: string; private: boolean };

/** Tick the Slack channels to watch. Lists the channels you're in (needs the connection saved), 5 rows at a time. */
function ChannelPicker({ value, onChange, canLoad }: { value: string; onChange: (v: string) => void; canLoad: boolean }) {
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const picked = value.split(/[,\n;]+/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean);
  const isPicked = (c: { id: string; name: string }) => picked.some((p) => p.toLowerCase() === c.name.toLowerCase() || p === c.id);
  const load = async () => {
    setBusy(true);
    setErr(null);
    try {
      setChannels((await get<{ channels: SlackChannel[] }>('/api/slack/channels')).channels);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (name: string, on: boolean) => {
    const rest = picked.filter((p) => p.toLowerCase() !== name.toLowerCase());
    onChange((on ? [...rest, name] : rest).map((n) => (/^[CG][A-Z0-9]{6,}$/.test(n) ? n : `#${n}`)).join(', '));
  };
  // Entries typed earlier that aren't in your channel list stay visible so they aren't silently dropped.
  const extra = channels ? picked.filter((p) => !channels.some((c) => c.name.toLowerCase() === p.toLowerCase() || c.id === p)) : [];
  const rows: { key: string; name: string; label: string; priv?: boolean }[] = [
    ...extra.map((p) => ({ key: `x-${p}`, name: p, label: `${p} (not in your channel list)` })),
    ...(channels ?? []).map((c) => ({ key: c.id, name: c.name, label: c.name, priv: c.private })),
  ].filter((r) => !q || r.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="channel-picker">
      <div className="inline">
        <button className="btn small" disabled={busy || !canLoad} onClick={() => void load()}>
          {busy ? 'Loading…' : channels ? 'Reload channels' : 'Load my channels'}
        </button>
        <span className="small muted">{canLoad ? `${picked.length} selected` : 'Save the Slack connection first'}</span>
        {channels && <input className="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      {err && <div className="small error">{err}</div>}
      {!channels && picked.length > 0 && <div className="small muted">Watching: {picked.map((p) => `#${p}`).join(', ')}</div>}
      {channels && (
        <div className="channel-list" role="group" aria-label="Slack channels">
          {rows.length === 0 && <div className="small muted pad">No matching channels.</div>}
          {rows.map((r) => (
            <label key={r.key} className="channel-row">
              <input type="checkbox" checked={isPicked({ id: r.key, name: r.name })} onChange={(e) => toggle(r.name, e.target.checked)} />
              <span>
                {r.priv ? '🔒 ' : '# '}
                {r.label}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function BackupSection({ s, up, env }: { s: Settings; up: <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => void; env: EnvironmentInfo }) {
  const b = s.backup;
  const [st, setSt] = useState<BackupStatus>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => void get<BackupStatus>('/api/backup/status').then(setSt).catch(() => undefined), []);
  if (!env.backupAvailable)
    return (
      <section>
        <h2>Backup</h2>
        <p className="muted">Scheduled backups copy the local SQLite database, so they aren't available with the hosted (Postgres) setup. Use your database's own backups there.</p>
      </section>
    );
  const now = async () => {
    setBusy(true);
    try {
      setSt(await post<BackupStatus>('/api/backup/run'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h2>Backup</h2>
      <p className="muted small">
        Saves a consistent copy of Work Commander's database (work streams, messages, drafts, settings) to a folder on a schedule. It runs while Work Commander is running, and
        right at startup if one is overdue. Credentials are in your OS keychain and are not part of the backup.
      </p>
      <Row label="Schedule">
        <Toggle checked={b.enabled} onChange={(enabled) => up('backup', { enabled })} label="Back up automatically" />
      </Row>
      <Row label="Folder" hint="e.g. a Google Drive folder. ~ is your home folder. The folder is created if needed">
        <Text value={b.folder} onChange={(folder) => up('backup', { folder })} placeholder="~/Google Drive/My Drive/WC backups" />
      </Row>
      <Row label="Back up every" hint="hours">
        <input type="number" min={1} step={1} value={b.everyHours} onChange={(e) => up('backup', { everyHours: Math.max(1, Math.floor(Number(e.target.value)) || 1) })} />
      </Row>
      <Row label="Keep" hint="most recent backups; older ones are deleted">
        <input type="number" min={1} step={1} value={b.keep} onChange={(e) => up('backup', { keep: Math.max(1, Math.floor(Number(e.target.value)) || 1) })} />
      </Row>
      <div className="inline">
        <button className="btn small" disabled={busy} onClick={() => void now()}>
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
        <span className="small muted">Uses the saved settings.</span>
      </div>
      {st.lastSuccessAt && (
        <div className="small muted">
          Last backup {new Date(st.lastSuccessAt).toLocaleString()} · <code>{st.lastFile}</code>
        </div>
      )}
      {st.lastError && <div className="small error">Last attempt failed{st.lastAttemptAt ? ` (${new Date(st.lastAttemptAt).toLocaleString()})` : ''}: {st.lastError}</div>}
    </section>
  );
}

function StatusSection() {
  const [status, setStatus] = useState<Record<string, { ok: boolean; message: string; at: string }>>({});
  const [audit, setAudit] = useState<any[]>([]);
  const load = () => {
    get('/api/integrations/status').then(setStatus);
    get('/api/audit').then(setAudit);
  };
  useEffect(load, []);
  return (
    <section>
      <h2>Integration status</h2>
      <div className="inline">
        <button className="btn small" onClick={() => post('/api/integrations/sync').then(setStatus)}>
          Sync now
        </button>
        <button className="btn ghost small" onClick={load}>
          Refresh
        </button>
      </div>
      <table className="table">
        <tbody>
          {Object.entries(status).map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className={v.ok ? 'ok' : 'error'}>{v.message}</td>
              <td className="small muted">{new Date(v.at).toLocaleTimeString()}</td>
            </tr>
          ))}
          {Object.keys(status).length === 0 && (
            <tr>
              <td className="muted">No ingestion running yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <h2>Audit log</h2>
      <table className="table">
        <tbody>
          {audit.map((a) => (
            <tr key={a.id}>
              <td className="small">{new Date(a.at).toLocaleString()}</td>
              <td>{a.actor}</td>
              <td>{a.action}</td>
              <td>
                <code className="small">{a.detail.slice(0, 160)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

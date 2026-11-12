import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CredentialInfo, IngestionMode, McpServerSettings, PolicyMode, SecretBackend } from '@wc/shared';
import { del, post, put } from '../api';

export const BACKEND_LABEL: Record<SecretBackend, string> = {
  keychain: 'OS keychain',
  'gcp-secret-manager': 'GCP Secret Manager',
  onepassword: '1Password',
};

export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const labelId = useId();
  const controls = useRef<HTMLDivElement>(null);
  // Name the row's form controls after the row label (they are passed in as children, so they cannot carry htmlFor themselves).
  useLayoutEffect(() => {
    controls.current?.querySelectorAll<HTMLElement>('input:not([type=checkbox]):not([type=radio]), select, textarea').forEach((el) => {
      const labelled = (el as HTMLInputElement).labels?.length || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
      if (!labelled) el.setAttribute('aria-labelledby', labelId);
    });
  });
  return (
    <div className="srow">
      <div className="srow-label">
        <span id={labelId} className="srow-title">
          {label}
        </span>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="srow-control" ref={controls}>
        {children}
      </div>
    </div>
  );
}

export function Text({ value, onChange, placeholder, type = 'text' }: { value?: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return <input type={type} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function Select<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="toggle" style={disabled ? { opacity: 0.55 } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

/**
 * Write-only credential input. The value goes straight to the chosen backend; the dashboard
 * only ever shows whether it's set and where it lives.
 */
export function CredentialField({
  id,
  label,
  creds,
  backends,
  defaultBackend,
  onSaved,
  placeholder,
}: {
  id: string;
  label: string;
  creds: CredentialInfo[];
  backends: SecretBackend[];
  defaultBackend: SecretBackend;
  onSaved: () => void;
  placeholder?: string;
}) {
  const cur = creds.find((c) => c.id === id);
  const usable = backends.filter((b) => !(b === 'onepassword' && id.startsWith('onepassword.')));
  const [backend, setBackend] = useState<SecretBackend>(cur?.backend && usable.includes(cur.backend) ? cur.backend : usable.includes(defaultBackend) ? defaultBackend : usable[0]);
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<'value' | 'ref'>('value');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'value') await put(`/api/credentials/${id}`, { value, backend });
      else await post(`/api/credentials/${id}/link`, { ref: value, backend });
      setValue('');
      setMsg('Saved');
      onSaved();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label={label}
      hint={cur ? <>Stored in {BACKEND_LABEL[cur.backend]} · updated {new Date(cur.updatedAt).toLocaleDateString()}</> : 'Not set'}
    >
      <div className="cred">
        <input
          type={mode === 'value' ? 'password' : 'text'}
          autoComplete="off"
          placeholder={mode === 'value' ? (cur ? '•••••••• (enter to replace)' : placeholder ?? 'Paste value') : backend === 'onepassword' ? 'op://vault/item/field' : backend === 'gcp-secret-manager' ? 'projects/…/secrets/…/versions/latest' : 'service/account'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <select value={backend} onChange={(e) => setBackend(e.target.value as SecretBackend)} title="Where to store it">
          {usable.map((b) => (
            <option key={b} value={b}>
              {BACKEND_LABEL[b]}
            </option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'value' | 'ref')} title="Store a new value, or point at a secret that already exists">
          <option value="value">New value</option>
          <option value="ref">Existing secret</option>
        </select>
        <button className="btn small primary" disabled={busy || !value} onClick={save}>
          Save
        </button>
        {cur && (
          <button className="btn small ghost" onClick={() => del(`/api/credentials/${id}`).then(onSaved)}>
            Remove
          </button>
        )}
      </div>
      {msg && <div className={`small ${msg === 'Saved' ? 'ok' : 'error'}`}>{msg}</div>}
    </Row>
  );
}

export function PolicyEditor({ value, onChange }: { value: { read: PolicyMode; write: PolicyMode }; onChange: (v: { read: PolicyMode; write: PolicyMode }) => void }) {
  const opts = [
    { value: 'auto' as PolicyMode, label: 'Run automatically' },
    { value: 'approve' as PolicyMode, label: 'Ask me first' },
  ];
  return (
    <>
      <Row label="Reads" hint="Searching and fetching for research">
        <Select value={value.read} options={opts} onChange={(read) => onChange({ ...value, read })} />
      </Row>
      <Row label="Writes" hint="Sending, posting, creating, changing">
        <Select value={value.write} options={opts} onChange={(write) => onChange({ ...value, write })} />
        {value.write === 'auto' && <div className="small warn">Claude will send and change things in this system without showing you a draft first.</div>}
      </Row>
    </>
  );
}

export function IngestionEditor({
  mode,
  seconds,
  onChange,
  realtimeAvailable,
  realtimeHint,
}: {
  mode: IngestionMode;
  seconds: number;
  onChange: (m: IngestionMode, s: number) => void;
  realtimeAvailable: boolean;
  realtimeHint: string;
}) {
  return (
    <Row label="Pick up new activity" hint={realtimeHint}>
      <div className="inline">
        <Select
          value={mode}
          onChange={(m) => onChange(m, seconds)}
          options={[
            { value: 'realtime', label: 'Real time', disabled: !realtimeAvailable },
            { value: 'polling', label: 'Polling' },
            { value: 'off', label: 'Off' },
          ]}
        />
        {mode === 'polling' && (
          <>
            every <input className="num" type="number" min={15} value={seconds} onChange={(e) => onChange(mode, Number(e.target.value))} /> s
          </>
        )}
      </div>
    </Row>
  );
}

type Pair = [string, string | { secretId: string }];

function PairList({ list, onChange, creds, label }: { list: Pair[]; onChange: (l: Pair[]) => void; creds: CredentialInfo[]; label: string }) {
  return (
    <Row label={label} hint="Value can be plain text or a stored credential">
      {list.map(([name, v], i) => (
        <div className="inline" key={i}>
          <input value={name} placeholder="Name" onChange={(e) => onChange(list.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} />
          {typeof v === 'string' ? (
            <input value={v} placeholder="Value" onChange={(e) => onChange(list.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} />
          ) : (
            <select value={v.secretId} onChange={(e) => onChange(list.map((p, j) => (j === i ? [p[0], { secretId: e.target.value }] : p)))}>
              {creds.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <button className="btn ghost small" onClick={() => onChange(list.map((p, j) => (j === i ? [p[0], typeof v === 'string' ? { secretId: creds[0]?.id ?? '' } : ''] : p)))}>
            {typeof v === 'string' ? 'Use credential' : 'Use text'}
          </button>
          <button className="btn ghost small" onClick={() => onChange(list.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn ghost small" onClick={() => onChange([...list, ['', '']])}>
        + Add
      </button>
    </Row>
  );
}

/** Edit an MCP server connection; header/env values can be plain or reference a stored credential. */
export function McpEditor({
  value,
  onChange,
  creds,
  system,
  dirty,
  credProps,
  publicUrl,
}: {
  value: McpServerSettings;
  onChange: (v: McpServerSettings) => void;
  creds: CredentialInfo[];
  system: 'google' | 'slack' | 'atlassian';
  dirty: boolean;
  credProps: { creds: CredentialInfo[]; backends: SecretBackend[]; defaultBackend: SecretBackend; onSaved: () => void };
  publicUrl: string;
}) {
  // Keep rows with empty names while editing; they are dropped server-side when unused.
  const set = (key: 'headers' | 'env', list: Pair[]) => onChange({ ...value, [key]: Object.fromEntries(list) });
  const env = Object.entries(value.env ?? {}) as Pair[];
  const headers = Object.entries(value.headers ?? {}) as Pair[];
  return (
    <div className="subsection">
      <Row label="Transport">
        <Select
          value={value.transport}
          onChange={(transport) => onChange({ ...value, transport })}
          options={[
            { value: 'http', label: 'Streamable HTTP' },
            { value: 'sse', label: 'SSE' },
            { value: 'stdio', label: 'Local command (stdio)' },
          ]}
        />
      </Row>
      {value.transport === 'stdio' ? (
        <>
          <Row label="Command">
            <Text value={value.command} onChange={(command) => onChange({ ...value, command })} placeholder="npx" />
          </Row>
          <Row label="Arguments" hint="Space separated">
            <Text value={(value.args ?? []).join(' ')} onChange={(a) => onChange({ ...value, args: a.split(' ').filter(Boolean) })} placeholder="-y some-mcp-server" />
          </Row>
          <PairList list={env} onChange={(l) => set('env', l)} creds={creds} label="Environment" />
        </>
      ) : (
        <>
          <Row label="URL">
            <Text value={value.url} onChange={(url) => onChange({ ...value, url })} placeholder="https://…/mcp" />
          </Row>
          <McpOAuthEditor value={value} onChange={onChange} system={system} dirty={dirty} credProps={credProps} publicUrl={publicUrl} />
          <PairList list={headers} onChange={(l) => set('headers', l)} creds={creds} label="Headers" />
        </>
      )}
      <Row label="Read-only tool patterns" hint="Regexes. Matching tools count as reads; everything else is a write that needs a draft. Tool annotations win when present.">
        <Text value={(value.readOnlyToolPatterns ?? []).join(', ')} onChange={(v) => onChange({ ...value, readOnlyToolPatterns: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
      </Row>
      <Row label="Collection instructions" hint="MCP mode collects new activity by having Claude call the server's read-only tools on each poll. Use {since} for the last poll time.">
        <textarea rows={2} value={value.ingestionPrompt ?? ''} placeholder="Leave blank for the default" onChange={(e) => onChange({ ...value, ingestionPrompt: e.target.value })} />
      </Row>
    </div>
  );
}

/** Sign-in for remote MCP servers that use OAuth (e.g. Slack's and Atlassian's hosted servers). */
function McpOAuthEditor({
  value,
  onChange,
  system,
  dirty,
  credProps,
  publicUrl,
}: {
  value: McpServerSettings;
  onChange: (v: McpServerSettings) => void;
  system: 'google' | 'slack' | 'atlassian';
  dirty: boolean;
  credProps: { creds: CredentialInfo[]; backends: SecretBackend[]; defaultBackend: SecretBackend; onSaved: () => void };
  publicUrl: string;
}) {
  const o = value.oauth ?? { enabled: false };
  const setO = (v: Partial<NonNullable<McpServerSettings['oauth']>>) => onChange({ ...value, oauth: { ...o, ...v } });
  const params = new URLSearchParams(location.search);
  const flash = params.get('mcp') === system ? params.get('result') : null;
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Row label="Sign-in" hint="Turn on for servers that ask you to log in (OAuth), such as Slack's or Atlassian's hosted MCP servers.">
        <Toggle checked={o.enabled} onChange={(enabled) => setO({ enabled })} label="Sign in with OAuth" />
      </Row>
      {o.enabled && (
        <div className="subsection">
          {flash && <div className={flash === 'connected' ? 'ok' : 'error'}>{flash === 'connected' ? 'Signed in to the MCP server.' : `MCP sign-in: ${flash}`}</div>}
          <p className="muted small">
            If the server needs a registered app, add <code>{publicUrl}/api/oauth/mcp/callback</code> as its redirect URL and enter its client id below. Leave the client id blank to register
            automatically, for servers that support it.
          </p>
          <Row label="Client id" hint="Optional">
            <Text value={o.clientId ?? ''} onChange={(clientId) => setO({ clientId: clientId || undefined })} placeholder="Register automatically" />
          </Row>
          {o.clientId && <CredentialField id={`${system}.mcp.oauthClientSecret`} label="Client secret (if the app has one)" {...credProps} />}
          <Row label="Scopes" hint="Optional, space separated. Blank uses the server's defaults.">
            <Text value={o.scope ?? ''} onChange={(scope) => setO({ scope: scope || undefined })} />
          </Row>
          <Row label="Account" hint={o.connectedAt ? `Signed in ${new Date(o.connectedAt).toLocaleString()}` : 'Not signed in'}>
            <div className="row-form">
            <a className={`btn small ${dirty || !value.url ? 'disabled' : 'primary'}`} href={dirty || !value.url ? undefined : `/api/oauth/mcp/${system}/start`}>
              {o.connectedAt ? 'Sign in again' : 'Sign in'}
            </a>
            {o.connectedAt && (
              <button
                className="btn small ghost"
                disabled={dirty || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await post(`/api/oauth/mcp/${system}/signout`);
                    credProps.onSaved();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Sign out
              </button>
            )}
            {dirty && <span className="small muted"> Save first</span>}
            </div>
          </Row>
        </div>
      )}
    </>
  );
}

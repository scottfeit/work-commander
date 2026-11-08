import { useId, useState } from 'react';
import type { EditableField, Proposal } from '@wc/shared';
import { patch, post } from '../api';

const SYSTEM_LABEL: Record<string, string> = { google: 'Gmail', slack: 'Slack', atlassian: 'Atlassian', onepassword: '1Password', internal: 'Work Commander' };

const getPath = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o: any, path: string, v: unknown) {
  const copy = structuredClone(o);
  const keys = path.split('.');
  let cur = copy;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys[keys.length - 1]] = v;
  return copy;
}

/** Bottom-right pane: every draft Claude prepared, directly editable before it is posted anywhere. */
export function DraftPane({ drafts }: { drafts: Proposal[] }) {
  // Unsaved PU edits, keyed by proposal id. Kept here so "Approve all" sends the edited text.
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const titles = new Map(drafts.map((d) => [d.id, d.title]));
  const approveAll = async () => {
    // Approve in creation order so dependencies are already approved when their dependents are.
    for (const d of drafts) await post(`/api/proposals/${d.id}/approve`, { payload: edits[d.id] ?? d.payload });
  };
  const setEdit = (id: string, v: Record<string, unknown> | null) =>
    setEdits((e) => {
      const n = { ...e };
      if (v) n[id] = v;
      else delete n[id];
      return n;
    });
  return (
    <div className="drafts">
      <div className="pane-head">
        Drafts to review <span className="chip attention">{drafts.length}</span>
        {drafts.length > 1 && (
          <button className="btn small primary right" onClick={approveAll}>
            Approve all
          </button>
        )}
      </div>
      <div className="drafts-scroll">
        {drafts.map((d) => (
          <DraftCard key={d.id} p={d} edited={edits[d.id] ?? null} onEdit={(v) => setEdit(d.id, v)} dependsOn={d.dependsOn.map((x) => titles.get(x) ?? x)} />
        ))}
      </div>
    </div>
  );
}

function DraftCard({ p, dependsOn, edited, onEdit }: { p: Proposal; dependsOn: string[]; edited: Record<string, unknown> | null; onEdit: (v: Record<string, unknown> | null) => void }) {
  const payload = edited ?? p.payload;
  const dirty = edited !== null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const update = (key: string, v: unknown) => onEdit(setPath(payload, key, v));
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const hasPlaceholder = JSON.stringify(payload).includes('{{');

  return (
    <div className={`draft kind-${p.kind}`}>
      <div className="draft-head">
        <span className={`sys sys-${p.system}`}>{SYSTEM_LABEL[p.system] ?? p.system}</span>
        <strong>{p.title}</strong>
        {(dirty || JSON.stringify(p.payload) !== JSON.stringify(p.originalPayload)) && <span className="chip subtle">edited</span>}
      </div>
      {p.rationale && <div className="muted small">{p.rationale}</div>}
      {dependsOn.length > 0 && <div className="small dep">Runs after: {dependsOn.join(', ')}</div>}
      <div className="fields">
        {p.editable.map((f) => (
          <Field key={f.key} f={f} value={getPath(payload, f.key)} onChange={(v) => update(f.key, v)} />
        ))}
      </div>
      {hasPlaceholder && <div className="small muted">Text in {'{{ }}'} is filled in automatically when the step it depends on runs.</div>}
      {err && <div className="error small">{err}</div>}
      {rejecting ? (
        <div className="row-form">
          <input autoFocus placeholder="Why? (optional, Claude sees this)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn small danger" disabled={busy} onClick={() => act(() => post(`/api/proposals/${p.id}/reject`, { reason }))}>
            Reject
          </button>
          <button className="btn small ghost" onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="actions">
          <button className="btn small primary" disabled={busy} onClick={() => act(() => post(`/api/proposals/${p.id}/approve`, { payload }))}>
            {p.kind === 'credential_request' ? 'Grant access' : p.kind === 'read_approval' ? 'Allow' : p.kind === 'stream_close' ? 'Close stream' : 'Approve & send'}
          </button>
          {dirty && (
            <button className="btn small" disabled={busy} onClick={() => act(() => patch(`/api/proposals/${p.id}`, { payload }).then(() => onEdit(null)))}>
              Save edits
            </button>
          )}
          <button className="btn small ghost" disabled={busy} onClick={() => setRejecting(true)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ f, value, onChange }: { f: EditableField; value: unknown; onChange: (v: unknown) => void }) {
  const id = useId();
  if (f.type === 'readonly')
    return (
      <div className="field ro">
        <label>{f.label}</label>
        <div>{Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</div>
      </div>
    );
  return (
    <div className="field">
      <label htmlFor={id}>{f.label}</label>
      {f.type === 'textarea' ? (
        <textarea id={id} rows={Math.min(14, Math.max(4, String(value ?? '').split('\n').length + 1))} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : f.type === 'list' ? (
        <input id={id} value={Array.isArray(value) ? value.join(', ') : String(value ?? '')} onChange={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />
      ) : f.type === 'select' ? (
        <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(f.options ?? []).map((o) => (
            <option key={o}>{o}</option>
          ))}
          {value && !(f.options ?? []).includes(String(value)) ? <option>{String(value)}</option> : null}
        </select>
      ) : (
        <input id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

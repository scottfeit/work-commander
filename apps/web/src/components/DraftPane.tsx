import { useEffect, useId, useRef, useState } from 'react';
import { ATTACHABLE_KINDS, type AttachmentRef, type EditableField, type Proposal } from '@wc/shared';
import { api, patch, post } from '../api';
import { SourceBadge } from './TabBar';
import { ConfirmButton } from './ConfirmButton';

/** The tool a draft goes to, as its icon (the same icons as work item tabs). */
const SYSTEM_SOURCE: Record<string, string> = { google: 'gmail', slack: 'slack', atlassian: 'jira', onepassword: 'grant' };
function SystemIcon({ system }: { system: string }) {
  const source = SYSTEM_SOURCE[system];
  return source ? <SourceBadge source={source} /> : <span className="logo small" role="img" aria-label="Work Commander" title="Work Commander" />;
}

/** The text a Quick Reply draft is waiting for (a blank one can't be sent). */
const mainText = (p: Proposal, payload: Record<string, any>) => (p.kind === 'mcp_tool_call' ? payload.args?.message : p.kind === 'slack_post' ? payload.text : payload.body);

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
/**
 * `onDecided` reports the server's answer to an approve/reject so the pane updates at once, without waiting for
 * the live event stream (which may have dropped). `onStale` reloads the list when a draft was already handled.
 */
export function DraftPane({ drafts, onDecided, onStale, focusId, onFocused }: { drafts: Proposal[]; onDecided: (p: Proposal) => void; onStale: () => void; focusId?: string | null; onFocused?: () => void }) {
  // Unsaved PU edits, keyed by proposal id. Kept here so "Approve all" sends the edited text.
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const titles = new Map(drafts.map((d) => [d.id, d.title]));
  const [allErr, setAllErr] = useState('');
  const approveAll = async () => {
    setAllErr('');
    // Approve in creation order so dependencies are already approved when their dependents are.
    for (const d of drafts) {
      const payload = (edits[d.id] ?? d.payload) as Record<string, any>;
      if (d.kind === 'stream_close') continue; // closing a work stream always takes its own two clicks
      if (payload.quick && !String(mainText(d, payload) ?? '').trim() && !payload.attachments?.length) continue; // a blank Quick Reply isn't sent
      try {
        onDecided(await post<Proposal>(`/api/proposals/${d.id}/approve`, { payload: edits[d.id] ?? d.payload }));
      } catch (e: any) {
        if (/^Proposal is /.test(e.message)) {
          onStale();
          continue;
        }
        setAllErr(`${d.title}: ${e.message}`);
        return;
      }
    }
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
          <button className="btn small primary right" title="Sends every draft except blank Quick Reply drafts and close-stream proposals" onClick={approveAll}>
            Approve all
          </button>
        )}
      </div>
      {allErr && <div className="error small" style={{ padding: '6px 12px' }}>{allErr}</div>}
      <div className="drafts-scroll">
        {drafts.map((d) => (
          <DraftCard key={d.id} p={d} focus={focusId === d.id} onFocused={onFocused} onDecided={onDecided} onStale={onStale} edited={edits[d.id] ?? null} onEdit={(v) => setEdit(d.id, v)} dependsOn={d.dependsOn.map((x) => titles.get(x) ?? x)} />
        ))}
      </div>
    </div>
  );
}

function DraftCard({
  p,
  focus,
  onFocused,
  dependsOn,
  edited,
  onEdit,
  onDecided,
  onStale,
}: {
  p: Proposal;
  focus?: boolean;
  onFocused?: () => void;
  dependsOn: string[];
  edited: Record<string, unknown> | null;
  onEdit: (v: Record<string, unknown> | null) => void;
  onDecided: (p: Proposal) => void;
  onStale: () => void;
}) {
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
      // Already approved/rejected (e.g. in another tab, or the update event was missed): just refresh.
      if (/^Proposal is /.test(e.message)) onStale();
      else setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const hasPlaceholder = JSON.stringify(payload).includes('{{');
  const quick = !!(p.payload as any).quick;
  const blank = quick && !String(mainText(p, payload) ?? '').trim() && !((payload.attachments as unknown[] | undefined)?.length);
  const card = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    // Quick Reply just opened (or re-opened) this draft: bring it into view with the cursor in the message.
    if (!focus) return;
    card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card.current?.querySelector('textarea')?.focus({ preventScroll: true });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    onFocused?.();
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  useEffect(() => {
    // A Quick Reply draft is yours: keep what you type so it survives switching tabs or streams and reloads.
    if (!quick || edited === null) return;
    const t = setTimeout(() => void patch(`/api/proposals/${p.id}`, { payload: edited }).catch(() => undefined), 700);
    return () => clearTimeout(t);
  }, [quick, edited, p.id]);

  return (
    <div ref={card} className={`draft kind-${p.kind} ${flash ? 'flash' : ''}`}>
      <div className="draft-head">
        <SystemIcon system={p.system} />
        <strong>{p.title}</strong>
        {!quick && (dirty || JSON.stringify(p.payload) !== JSON.stringify(p.originalPayload)) && <span className="chip subtle">edited</span>}
      </div>
      {p.rationale && <div className="muted small">{p.rationale}</div>}
      {dependsOn.length > 0 && <div className="small dep">Runs after: {dependsOn.join(', ')}</div>}
      <div className="fields">
        {p.editable.map((f) => (
          <Field key={f.key} f={f} value={getPath(payload, f.key)} onChange={(v) => update(f.key, v)} />
        ))}
      </div>
      {ATTACHABLE_KINDS.includes(p.kind) && (
        <Attachments
          streamId={p.streamId}
          value={(payload.attachments as AttachmentRef[] | undefined) ?? []}
          disabled={busy}
          onChange={(attachments) =>
            act(async () => {
              // Persist straight away (with any unsaved text edits) so an upload is never lost.
              const next = { ...payload, attachments };
              onEdit(next);
              await patch(`/api/proposals/${p.id}`, { payload: next });
              onEdit(null);
            })
          }
        />
      )}
      {hasPlaceholder && <div className="small muted">Text in {'{{ }}'} is filled in automatically when the step it depends on runs.</div>}
      {err && <div className="error small">{err}</div>}
        <div className="actions">
          {p.kind === 'stream_close' ? (
            <ConfirmButton
              className="btn small primary"
              armedClassName="btn small danger"
              disabled={busy}
              title="Close this work stream (asks you to click twice)"
              armedTitle="Click again to close this work stream"
              armedChildren="Click again to close"
              onConfirm={() => void act(async () => onDecided(await post<Proposal>(`/api/proposals/${p.id}/approve`, { payload })))}
            >
              Close stream
            </ConfirmButton>
          ) : (
          <button className="btn small primary" disabled={busy || blank} title={blank ? 'Write a message first' : undefined} onClick={() => act(async () => onDecided(await post<Proposal>(`/api/proposals/${p.id}/approve`, { payload })))}>
            {p.kind === 'credential_request' ? 'Grant access' : p.kind === 'read_approval' ? 'Allow' : p.kind === 'playbook' ? 'Save playbook' : 'Approve & send'}
          </button>
          )}
          {dirty && (
            <button className="btn small" disabled={busy} onClick={() => act(() => patch(`/api/proposals/${p.id}`, { payload }).then(() => onEdit(null)))}>
              Save edits
            </button>
          )}
          {/* One Reject button: the first click opens the "why?" box below; the second sends the rejection. */}
          <button
            className={`btn small ${rejecting ? 'danger' : 'ghost'}`}
            disabled={busy}
            onClick={() => (rejecting ? act(async () => (await post(`/api/proposals/${p.id}/reject`, { reason }), onDecided({ ...p, status: 'rejected' }))) : setRejecting(true))}
          >
            Reject
          </button>
          {rejecting && (
            <button className="btn small ghost" onClick={() => setRejecting(false)}>
              Cancel
            </button>
          )}
        </div>
      {rejecting && (
        <div className="row-form">
          <input autoFocus aria-label="Why reject this draft?" placeholder="Why? (optional, Claude sees this)" value={reason} onChange={(e) => setReason(e.target.value)} />
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
        <ListInput id={id} value={value} onChange={onChange} />
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

const parseList = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean);
const joinList = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

/** Comma-separated list field. Keeps what the PU is typing (including a trailing ", ") while the payload holds the parsed list. */
function ListInput({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(joinList(value));
  useEffect(() => {
    // Adopt outside changes (saved edits, reload) but never overwrite what is being typed.
    if (JSON.stringify(parseList(text)) !== JSON.stringify(Array.isArray(value) ? value : parseList(String(value ?? '')))) setText(joinList(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      id={id}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Files on a draft: download, remove, or attach more from this computer. */
function Attachments({ streamId, value, disabled, onChange }: { streamId: string | null; value: AttachmentRef[]; disabled: boolean; onChange: (v: AttachmentRef[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append('file', f, f.name);
      const added = await api<AttachmentRef[]>('POST', `/api/attachments${streamId ? `?streamId=${encodeURIComponent(streamId)}` : ''}`, form);
      onChange([...value, ...added]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="field attachments">
      <label>Attachments</label>
      <div>
        {value.length > 0 && (
          <ul className="attach-list">
            {value.map((a) => (
              <li key={a.id} className="attach-chip">
                <a href={`/api/attachments/${a.id}`} download={a.filename} title={`Download ${a.filename}`}>
                  {a.filename}
                </a>
                <span className="muted small">{fmtSize(a.size)}</span>
                <button type="button" className="x" aria-label={`Remove ${a.filename}`} disabled={disabled} onClick={() => onChange(value.filter((x) => x.id !== a.id))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        <button type="button" className="btn small ghost" disabled={disabled || uploading} onClick={() => input.current?.click()}>
          {uploading ? 'Uploading…' : '📎 Attach'}
        </button>
        {err && <div className="error small">{err}</div>}
      </div>
    </div>
  );
}

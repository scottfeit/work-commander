import { useEffect, useState } from 'react';
import type { StreamItem, ThreadMessage, TicketTarget, WorkStream } from '@wc/shared';
import { fmtTime, get, patch, post, timeAgo } from '../api';

const ago = (iso: string) => (timeAgo(iso) === 'just now' ? 'just now' : `${timeAgo(iso)} ago`);
import { SourceBadge, dragItem } from './TabBar';

function Message({ m, compact }: { m: ThreadMessage; compact?: boolean }) {
  return (
    <article className={`msg ${m.isFromPU ? 'from-pu' : ''} ${compact ? 'compact' : ''}`}>
      <header>
        <strong>{m.author.name ?? m.author.email ?? m.author.slackUserId}</strong>
        {!compact && m.author.email && <span className="muted"> &lt;{m.author.email}&gt;</span>}
        <span className="muted small right">{fmtTime(m.at)}</span>
      </header>
      {!compact && (m.to?.length || m.cc?.length) ? (
        <div className="muted small">
          {m.to?.length ? <>To: {m.to.join(', ')}</> : null}
          {m.cc?.length ? <> · Cc: {m.cc.join(', ')}</> : null}
        </div>
      ) : null}
      <div className="body">{m.text}</div>
    </article>
  );
}

export function ItemView({ item, onRemoved }: { item: StreamItem; onRemoved?: () => void }) {
  const t = item.data.ticket;
  return (
    <div className="item-view">
      <div className="item-head">
        <SourceBadge source={item.source} />
        <h2>{item.title}</h2>
        {item.url && (
          <a className="btn ghost small" href={item.url} target="_blank" rel="noreferrer">
            Open ↗
          </a>
        )}
        <button
          className="btn ghost small"
          title="Remove this from the work stream. It won't be added back to it."
          onClick={() => void post(`/api/items/${item.id}/not-relevant`).then(() => onRemoved?.())}
        >
          Not relevant
        </button>
      </div>
      {t ? (
        <>
          <dl className="ticket-fields">
            <div><dt>Status</dt><dd><span className="chip">{t.status}</span></dd></div>
            <div><dt>Assignee</dt><dd>{t.assignee ?? 'Unassigned'}</dd></div>
            <div><dt>Requester</dt><dd>{t.requester ?? t.reporter ?? '—'}</dd></div>
            <div><dt>Type</dt><dd>{t.flavor === 'jsm' ? 'Service request' : 'Jira issue'}</dd></div>
          </dl>
          {t.description && <div className="body block">{t.description}</div>}
          <h3>Comments · {t.comments.length}</h3>
          {t.comments.length === 0 && <p className="muted">No comments yet.</p>}
          {t.comments.map((c) => (
            <Message key={c.id} m={c} />
          ))}
        </>
      ) : item.data.messages ? (
        <div className={item.kind === 'slack_thread' ? 'thread slack' : 'thread'}>
          {item.data.messages.map((m) => (
            <Message key={m.id} m={m} compact={item.kind === 'slack_thread'} />
          ))}
        </div>
      ) : (
        <pre className="body block">{item.data.body ?? JSON.stringify(item.data.raw ?? item.data, null, 2)}</pre>
      )}
    </div>
  );
}

/** Coding work goes to Claude Code: Work Commander's agent has no shell or file tools by design. */
type HandoffInfo = { folder: string; canOpenTerminal: boolean; last: { folder: string; createdAt: string; returnedAt: string | null } | null };

function Handoff({ streamId, updatedAt }: { streamId: string; updatedAt: string }) {
  const [info, setInfo] = useState<HandoffInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState('');
  const [openTerminal, setOpenTerminal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ folder: string; command: string; opened: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setInfo(null);
    setOpen(false);
    setDone(null);
    setErr(null);
  }, [streamId]);
  useEffect(() => {
    get<HandoffInfo>(`/api/streams/${streamId}/handoff`)
      .then((r) => {
        setInfo(r);
        setFolder((f) => f || r.folder);
        setOpenTerminal(r.canOpenTerminal);
      })
      .catch(() => setInfo(null)); // not available (e.g. hosted on GCP)
  }, [streamId, updatedAt]);
  if (!info) return null;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      setDone(await post(`/api/streams/${streamId}/handoff`, { folder, openTerminal }));
      setInfo(await get<HandoffInfo>(`/api/streams/${streamId}/handoff`));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="handoff">
      {info.last && (
        <p className="small handoff-status">
          {info.last.returnedAt ? (
            <>
              <span className="chip">Results back</span> Claude Code reported back {fmtFull(info.last.returnedAt)} from <code>{info.last.folder}</code>
            </>
          ) : (
            <>
              <span className="chip running">With Claude Code</span> Handed off {fmtFull(info.last.createdAt)} to <code>{info.last.folder}</code>. Results come back here automatically when it writes RESULT.md.
            </>
          )}
        </p>
      )}
      {!open ? (
        <button className="btn small" onClick={() => setOpen(true)}>
          Hand off to Claude Code
        </button>
      ) : (
        <div className="handoff-form">
          <p className="muted small">Writes everything this stream knows to BRIEF.md in the folder below{info.canOpenTerminal ? ', then opens Terminal with Claude Code running there' : ''}. Use it for coding work, which Work Commander's agent can't do.</p>
          <label className="small">
            Project folder
            <input aria-label="Project folder" value={folder} onChange={(e) => setFolder(e.target.value)} />
          </label>
          {info.canOpenTerminal && (
            <label className="small check">
              <input type="checkbox" checked={openTerminal} onChange={(e) => setOpenTerminal(e.target.checked)} /> Open in Terminal
            </label>
          )}
          <div className="row-form">
            <button className="btn small primary" disabled={busy || !folder.trim()} onClick={go}>
              {busy ? 'Handing off…' : done ? 'Hand off again' : 'Hand off'}
            </button>
            <button className="btn small ghost" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {err && <div className="error small">{err}</div>}
          {done && (
            <div className="ok small">
              Brief written to <code>{done.folder}/BRIEF.md</code>. {done.opened ? 'Claude Code is starting in a new Terminal window.' : 'To start, run:'}
              {!done.opened && (
                <div className="row-form">
                  <code className="cmd">{done.command}</code>
                  <button className="btn small ghost" onClick={() => navigator.clipboard?.writeText(done.command)}>
                    Copy
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type SummaryVersion = { id: number; summary: string; by: 'claude' | 'you' | 'unknown'; at: string | null };
const fmtFull = (iso: string) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function StreamOverview({ stream, items, onOpen }: { stream: WorkStream; items: StreamItem[]; onOpen: (id: string) => void }) {
  const [title, setTitle] = useState(stream.title);
  const [summary, setSummary] = useState(stream.summary);
  const [grants, setGrants] = useState<any[]>([]);
  const [target, setTarget] = useState<TicketTarget>(stream.ticketTarget ?? { flavor: 'jsm', projectKey: '', typeId: '', serviceDeskId: '' });
  const [editTarget, setEditTarget] = useState(false);
  useEffect(() => {
    setTitle(stream.title);
    setSummary(stream.summary);
    setTarget(stream.ticketTarget ?? { flavor: 'jsm', projectKey: '', typeId: '', serviceDeskId: '' });
  }, [stream.id, stream.title, stream.summary, stream.ticketTarget]);
  useEffect(() => {
    get(`/api/streams/${stream.id}/grants`).then(setGrants).catch(() => setGrants([]));
  }, [stream.id, stream.updatedAt]);
  const [history, setHistory] = useState<SummaryVersion[]>([]);
  useEffect(() => {
    get<SummaryVersion[]>(`/api/streams/${stream.id}/summaries`)
      .then((all) => setHistory(all.slice(1))) // first = the current overview, shown above
      .catch(() => setHistory([]));
  }, [stream.id, stream.summary]);
  const save = (b: Partial<Omit<WorkStream, "ticketTarget">> & { ticketTarget?: TicketTarget | null }) => patch(`/api/streams/${stream.id}`, b);

  return (
    <div className="item-view overview">
      <div className="item-head">
        <input className="title-input" aria-label="Work stream title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== stream.title && save({ title })} />
        <button className="btn small" onClick={() => save({ status: stream.status === 'open' ? 'closed' : 'open' })}>
          {stream.status === 'open' ? 'Close stream' : 'Reopen'}
        </button>
      </div>
      <textarea className="summary-input" rows={2} value={summary} placeholder="Summary (Claude keeps this current)" onChange={(e) => setSummary(e.target.value)} onBlur={() => summary !== stream.summary && save({ summary })} />
      <div className="muted small">
        Opened {ago(stream.createdAt)} · last activity {ago(stream.lastActivityAt)} · {stream.labels.join(', ') || 'no labels'}
      </div>

      {history.length > 0 && (
        <>
          <h3>Previous overviews</h3>
          <ol className="summary-history">
            {history.map((v) => (
              <li key={v.id}>
                <div className="muted small">
                  {v.at ? <time dateTime={v.at}>{fmtFull(v.at)}</time> : 'Before history was kept'}
                  {v.by === 'you' ? ' · edited by you' : v.by === 'claude' ? ' · by Claude' : ''}
                </div>
                <div>{v.summary}</div>
              </li>
            ))}
          </ol>
        </>
      )}

      <Handoff streamId={stream.id} updatedAt={stream.updatedAt} />

      <h3>Linked items</h3>
      {items.length === 0 && <p className="muted">Nothing linked yet.</p>}
      <ul className="linked">
        {items.map((i) => (
          <li key={i.id}>
            <button className="link-row" onClick={() => onOpen(i.id)} title="Drag to another work stream to move it" {...dragItem(i.id)}>
              <SourceBadge source={i.source} /> <span>{i.title}</span>
              <span className="muted small right">{timeAgo(i.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>

      <h3>Ticket target</h3>
      {!editTarget ? (
        <p>
          {stream.ticketTarget ? (
            <>
              {stream.ticketTarget.flavor.toUpperCase()} · project {stream.ticketTarget.projectKey} · type {stream.ticketTarget.typeId}
              {stream.ticketTarget.serviceDeskId ? ` · desk ${stream.ticketTarget.serviceDeskId}` : ''}
            </>
          ) : (
            <span className="muted">Uses the default from Settings → Atlassian.</span>
          )}{' '}
          <button className="btn ghost small" onClick={() => setEditTarget(true)}>
            Change
          </button>
        </p>
      ) : (
        <div className="row-form">
          <select value={target.flavor} onChange={(e) => setTarget({ ...target, flavor: e.target.value as 'jsm' | 'jira' })}>
            <option value="jsm">JSM request</option>
            <option value="jira">Jira issue</option>
          </select>
          <input placeholder="Project key" value={target.projectKey} onChange={(e) => setTarget({ ...target, projectKey: e.target.value })} />
          {target.flavor === 'jsm' && <input placeholder="Service desk id" value={target.serviceDeskId ?? ''} onChange={(e) => setTarget({ ...target, serviceDeskId: e.target.value })} />}
          <input placeholder={target.flavor === 'jsm' ? 'Request type id' : 'Issue type (e.g. Task)'} value={target.typeId} onChange={(e) => setTarget({ ...target, typeId: e.target.value })} />
          <button className="btn small primary" onClick={() => save({ ticketTarget: target }).then(() => setEditTarget(false))}>
            Save
          </button>
          <button className="btn small ghost" onClick={() => save({ ticketTarget: null }).then(() => setEditTarget(false))}>
            Use default
          </button>
        </div>
      )}

      {grants.length > 0 && (
        <>
          <h3>Credential grants</h3>
          <ul className="linked">
            {grants.map((g) => (
              <li key={g.id} className="grant">
                <SourceBadge source="grant" /> {g.item_title} → {g.allowed_hosts.join(', ')} · <span className="chip">{g.status}</span>{' '}
                <span className="muted small">expires {g.expires_at ? fmtTime(g.expires_at) : 'never'}</span>
                {g.status === 'active' && (
                  <button className="btn ghost small" onClick={() => post(`/api/grants/${g.id}/revoke`).then(() => setGrants(grants.map((x) => (x.id === g.id ? { ...x, status: 'revoked' } : x))))}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

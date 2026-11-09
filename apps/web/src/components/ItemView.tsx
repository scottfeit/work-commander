import { useEffect, useState } from 'react';
import type { StreamItem, ThreadMessage, TicketTarget, WorkStream } from '@wc/shared';
import { fmtTime, get, patch, post, timeAgo } from '../api';

const ago = (iso: string) => (timeAgo(iso) === 'just now' ? 'just now' : `${timeAgo(iso)} ago`);
import { SourceBadge } from './TabBar';

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

export function ItemView({ item }: { item: StreamItem }) {
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

      <h3>Linked items</h3>
      {items.length === 0 && <p className="muted">Nothing linked yet.</p>}
      <ul className="linked">
        {items.map((i) => (
          <li key={i.id}>
            <button className="link-row" onClick={() => onOpen(i.id)}>
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

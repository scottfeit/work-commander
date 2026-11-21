import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFoldWhenTight } from './useFoldWhenTight';
import type { ClaudeCodeStatus, GmailAction, GmailThreadState, MessageAttachment, StreamItem, StreamUsage, ThreadMessage, TicketTarget, TicketTransitionOption, WorkStream } from '@wc/shared';
import { USAGE_CATEGORIES, formatUsage } from '@wc/shared';
import { ccPost, fmtTime, get, patch, post, timeAgo } from '../api';
import { UsagePie } from './usageViz';

const ago = (iso: string) => (timeAgo(iso) === 'just now' ? 'just now' : `${timeAgo(iso)} ago`);
import { SourceBadge, dragItem } from './TabBar';
import { waitedFor } from './StreamList';
import { setOpenSlackItem } from '../slackSelection';
import { PersonName } from './PersonCard';
import { Linkified } from './Linkified';
import { ConfirmButton } from './ConfirmButton';
import { AlarmIcon } from './AlarmIcon';
import { SnoozeMenu } from './SnoozeMenu';
import { splitQuoted } from './quoted';
import { Emoji, EmojiPicker, useEmoji } from './Emoji';
import { DueLine, promisedOption } from './Due';
import { EmailHtml } from './EmailHtml';

/** Slack conversations are split by topic: send this message (or this and every later one) to another work stream. */
function MoveMessages({ item, m, onDone }: { item: StreamItem; m: ThreadMessage; onDone: () => void }) {
  const [streams, setStreams] = useState<WorkStream[]>([]);
  const [scope, setScope] = useState<'one' | 'later'>('one');
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    get<WorkStream[]>('/api/streams').then((x) => setStreams(x.filter((s) => s.status === 'open' && s.id !== item.streamId))).catch(() => undefined);
  }, [item.streamId]);
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      await post(`/api/items/${item.id}/move-messages`, {
        ...(scope === 'one' ? { messageIds: [m.id] } : { fromMessageId: m.id }),
        ...(dest === '__new' ? { newStream: true } : { streamId: dest === '__none' ? null : dest }),
      });
      onDone();
    } catch (e: any) {
      setErr(e.message ?? String(e));
      setBusy(false);
    }
  };
  return (
    <div className="move-messages" role="group" aria-label="Move message">
      <label>
        <input type="radio" name={`scope-${m.id}`} checked={scope === 'one'} onChange={() => setScope('one')} /> This message
      </label>
      <label>
        <input type="radio" name={`scope-${m.id}`} checked={scope === 'later'} onChange={() => setScope('later')} /> This and every later message
      </label>
      <select aria-label="Move to" value={dest} onChange={(e) => setDest(e.target.value)}>
        <option value="">Move to…</option>
        {streams.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
        <option value="__new">A new work stream (Claude names it)</option>
        {item.streamId && <option value="__none">No work stream (not relevant)</option>}
      </select>
      {dest === '__new' && <div className="muted small">Claude reads the messages and gives the new work stream a title and overview. You can rename it afterwards.</div>}
      {err && <div className="error small">{err}</div>}
      <div className="row">
        <button className="btn small primary" disabled={busy || !dest} onClick={() => void go()}>
          {busy && dest === '__new' ? 'Naming it…' : 'Move'}
        </button>
        <button className="btn ghost small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A message's text, with the earlier quoted part ("On … wrote:" and below) folded behind a triangle. */
function TextBody({ text, fold }: { text: string; fold: boolean }) {
  const [open, setOpen] = useState(false);
  const { visible, quoted } = fold ? splitQuoted(text) : { visible: text, quoted: null };
  return (
    <>
      <div className="body">
        <Linkified text={visible} />
      </div>
      {quoted && (
        <div className="quoted">
          <button type="button" className="disclosure quoted-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span className="tri" aria-hidden="true">▸</span> Earlier messages
          </button>
          {open && (
            <div className="body quoted-body">
              <Linkified text={quoted} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Image types shown inline (SVG can carry scripts, so it's a download like any other file). */
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;
const fileSize = (n?: number) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A larger view of an image over the page: Esc, the × or a click outside the image closes it. */
function Lightbox({ src, name, download, onClose }: { src: string; name: string; download: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', esc, true);
    close.current?.focus();
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={name} />
        <figcaption>
          <span>{name}</span>
          <a href={download} download={name} className="link small">
            Download
          </a>
        </figcaption>
      </figure>
      <button ref={close} type="button" className="lightbox-x" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>,
    document.body,
  );
}

/** A message's (or ticket's) attachments: images inline (click for full size), other files as chips that download. */
function Attachments({ itemId, list }: { itemId: string; list: MessageAttachment[] }) {
  const url = (a: MessageAttachment, inline = false) => `/api/items/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(a.id)}${inline ? '?inline=1' : ''}`;
  const images = list.filter((a) => INLINE_IMAGE.test(a.mimeType));
  const files = list.filter((a) => !INLINE_IMAGE.test(a.mimeType));
  const [big, setBig] = useState<MessageAttachment | null>(null);
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className="att-images">
          {images.map((a) => (
            <button key={a.id} type="button" className="att-thumb" title={`${a.name} (${fileSize(a.size)}): click to enlarge`} aria-label={`Enlarge ${a.name}`} onClick={() => setBig(a)}>
              <img src={url(a, true)} alt={a.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {big && <Lightbox src={url(big, true)} name={big.name} download={url(big)} onClose={() => setBig(null)} />}
      {files.length > 0 && (
        <div className="att-files">
          {files.map((a) => (
            <a key={a.id} className="att-file" href={url(a)} download={a.name} title={`Download ${a.name}`}>
              <span aria-hidden="true">📎</span> {a.name} {a.size != null && <span className="muted small">{fileSize(a.size)}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const DEFAULT_QUICK = ['+1', 'white_check_mark', 'eyes', 'pray', 'tada'];

/** A Slack message's reactions: click one to add or take back yours; your quick five (on hover) and the full picker add new ones. Sent to Slack at once. */
function Reactions({ item, m, quick }: { item: StreamItem; m: ThreadMessage; quick: string[] }) {
  const c = useEmoji();
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const react = async (name: string, add: boolean) => {
    setErr(null);
    try {
      await post(`/api/items/${encodeURIComponent(item.id)}/messages/${encodeURIComponent(m.id)}/react`, { name, add });
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const list = m.reactions ?? [];
  return (
    <div className="reactions">
      {list.map((r) => (
        <button key={r.name} type="button" className={`reaction${r.mine ? ' mine' : ''}`} aria-pressed={r.mine} aria-label={`:${r.name}: ${r.count}${r.mine ? ', including you' : ''}`} title={r.mine ? `Take back your :${r.name}:` : `React :${r.name}: too`} onClick={() => void react(r.name, !r.mine)}>
          <Emoji name={r.name} c={c} /> <span className="reaction-n">{r.count}</span>
        </button>
      ))}
      <button type="button" className="reaction add" aria-label="Add a reaction" aria-expanded={!!picker} title="Add a reaction" onClick={(e) => setPicker(picker ? null : e.currentTarget)}>
        ☺<span aria-hidden="true">+</span>
      </button>
      <span className="quick-react">
        {quick
          .filter((n) => !list.some((r) => r.name === n && r.mine))
          .map((n) => (
            <button key={n} type="button" className="reaction quick" aria-label={`React :${n}:`} title={`React :${n}:`} onClick={() => void react(n, true)}>
              <Emoji name={n} c={c} />
            </button>
          ))}
      </span>
      {picker && <EmojiPicker anchor={picker} quick={quick} onPick={(n) => void react(n, true)} onClose={() => setPicker(null)} />}
      {err && <span className="small error">{err}</span>}
    </div>
  );
}

/** The checkbox on a Slack message: ticked or not, and what a click does (shift-click ticks the whole range). */
type Pick = { checked: boolean; onClick: (shift: boolean) => void };

/**
 * Ticking Slack messages to act on several at once: move them to another work stream, or take them out of this one. Shift-click
 * ticks every message between the last one clicked and this one.
 */
function SlackSelection({ item, enabled, order, children }: { item: StreamItem; enabled: boolean; order: ThreadMessage[]; children: (order: ThreadMessage[], pick?: (m: ThreadMessage) => Pick) => React.ReactNode }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [streams, setStreams] = useState<WorkStream[]>([]);
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    setSel(new Set());
    setAnchor(null);
    setDest('');
    setErr('');
  }, [item.id]);
  // messages that left the item drop out of the selection
  const ids = order.map((m) => m.id).join(',');
  useEffect(() => {
    const have = new Set(ids.split(','));
    setSel((s) => ([...s].every((id) => have.has(id)) ? s : new Set([...s].filter((id) => have.has(id)))));
  }, [ids]);
  // tell the Drafts pane which Slack conversation is open and what's ticked in it ("Reply in thread" uses it)
  useEffect(() => {
    setOpenSlackItem(item.source === 'slack' ? item : null, [...sel]);
  }, [item, sel]);
  useEffect(() => () => setOpenSlackItem(null), []);
  useEffect(() => {
    if (enabled && sel.size) get<WorkStream[]>('/api/streams').then((x) => setStreams(x.filter((s) => s.status === 'open' && s.id !== item.streamId))).catch(() => undefined);
  }, [enabled, sel.size > 0, item.streamId]);
  if (!enabled) return <>{children(order)}</>;
  const pick = (m: ThreadMessage): Pick => ({
    checked: sel.has(m.id),
    onClick: (shift) => {
      setSel((cur) => {
        const next = new Set(cur);
        if (shift && anchor && anchor !== m.id) {
          const a = order.findIndex((x) => x.id === anchor);
          const b = order.findIndex((x) => x.id === m.id);
          if (a >= 0 && b >= 0) for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x.id);
        } else if (next.has(m.id)) next.delete(m.id);
        else next.add(m.id);
        return next;
      });
      setAnchor(m.id);
    },
  });
  const act = async (streamId: string | null) => {
    setBusy(true);
    setErr('');
    try {
      await post(`/api/items/${item.id}/move-messages`, { messageIds: [...sel], streamId });
      setSel(new Set());
      setDest('');
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {sel.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Selected messages">
          <span className="bulk-n">{sel.size} selected</span>
          <select aria-label="Move selected to" value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">Move to…</option>
            {streams.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <button type="button" className="btn small primary" disabled={busy || !dest} onClick={() => void act(dest)}>
            Move
          </button>
          {item.streamId && (
            <button type="button" className="btn small" disabled={busy} title="Take these messages out of this work stream (into the conversation's 'no work stream' item)" onClick={() => void act(null)}>
              Remove from work stream
            </button>
          )}
          <button type="button" className="btn small ghost" onClick={() => setSel(new Set())}>
            Clear
          </button>
          {err && <span className="small error">{err}</span>}
        </div>
      )}
      {children(order, pick)}
    </>
  );
}

function Message({ m, compact, html, defaultOriginal, item, itemId, quick, pick }: { m: ThreadMessage; compact?: boolean; html?: string; defaultOriginal?: boolean; item?: StreamItem; itemId?: string; quick?: string[]; pick?: Pick }) {
  const [choice, setOriginal] = useState<boolean | null>(null); // null: follow the Settings default
  const [moving, setMoving] = useState(false);
  const original = choice ?? !!defaultOriginal;
  return (
    <article className={`msg ${m.isFromPU ? 'from-pu' : ''} ${compact ? 'compact' : ''}${pick?.checked ? ' picked' : ''}`}>
      <header>
        {pick && (
          <input
            type="checkbox"
            className="msg-pick"
            aria-label={`Select message from ${m.author.name ?? m.author.email ?? 'someone'}`}
            title="Select (shift-click to select a range)"
            checked={pick.checked}
            onChange={() => undefined}
            onClick={(e) => pick.onClick(e.shiftKey)}
          />
        )}
        <PersonName name={m.author.name ?? m.author.email ?? m.author.slackUserId ?? 'Someone'} email={m.author.email} slackUserId={m.author.slackUserId} />
        {!compact && m.author.email && <span className="muted"> &lt;{m.author.email}&gt;</span>}
        <span className="muted small right">
          {html && (
            <button className="link" aria-pressed={original} title={original ? 'Show the plain-text copy' : 'Show the email as it was sent'} onClick={() => setOriginal(!original)}>
              {original ? 'Text' : 'Original'}
            </button>
          )}{' '}
          {item && (
            <button className="link" title="Move this message to another work stream" aria-expanded={moving} onClick={() => setMoving(!moving)}>
              Move…
            </button>
          )}{' '}
          {fmtTime(m.at)}
        </span>
      </header>
      {item && moving && <MoveMessages item={item} m={m} onDone={() => setMoving(false)} />}
      {!compact && (m.to?.length || m.cc?.length) ? (
        <div className="muted small">
          {m.to?.length ? <>To: {m.to.join(', ')}</> : null}
          {m.cc?.length ? <> · Cc: {m.cc.join(', ')}</> : null}
        </div>
      ) : null}
      {original && html ? (
        <EmailHtml html={html} />
      ) : (
        <TextBody text={m.text} fold={!compact} />
      )}
      {itemId && !!m.attachments?.length && <Attachments itemId={itemId} list={m.attachments} />}
      {item?.source === 'slack' && <Reactions item={item} m={m} quick={quick ?? DEFAULT_QUICK} />}
    </article>
  );
}

export function ItemView({
  item,
  onRemoved,
  peek,
  onDismiss,
  onQuickReply,
  manualRead,
  onSetRead,
  newestFirst = {},
}: {
  /** Settings → Display: newest message first, per kind. */
  newestFirst?: { email?: boolean; slack?: boolean; tickets?: boolean };
  item: StreamItem;
  onRemoved?: () => void;
  peek?: boolean;
  onDismiss?: () => void;
  onQuickReply?: (item: StreamItem) => void;
  /** Settings → Display "mark work items Read myself": the button reads Read while it's unread. Otherwise it always reads Unread. */
  manualRead?: boolean;
  onSetRead?: (read: boolean) => void;
}) {
  const t = item.data.ticket;
  const [emailOriginal, setEmailOriginal] = useState(false);
  const [quick, setQuick] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    get('/api/settings')
      .then((s) => {
        setEmailOriginal(s.ui?.emailView === 'original');
        setQuick(s.slack?.quickReactions?.length ? s.slack.quickReactions : undefined);
      })
      .catch(() => undefined);
  }, [item.id]);
  // What's new since you last opened this item: remembered as it was when you opened it (opening it now updates it).
  const [seenBefore, setSeenBefore] = useState<string | null>(null);
  useEffect(() => {
    setSeenBefore(item.data.seenAt ?? null);
    if (!peek) void post(`/api/items/${item.id}/seen`).catch(() => undefined);
    // only on opening the item
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);
  const isNew = (m: ThreadMessage) => !!seenBefore && !m.isFromPU && m.at > seenBefore;
  const divider = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (seenBefore) divider.current?.scrollIntoView({ block: 'center' });
  }, [seenBefore, item.id]);
  /** Messages in display order, with a "new since you last looked" divider between the new ones and the rest. */
  const withDivider = (order: ThreadMessage[], render: (m: ThreadMessage) => ReactNode) => {
    const all = order.length;
    const fresh = order.filter(isNew).length;
    if (!fresh || fresh === all) return order.map(render); // nothing new, or never opened before / all of it new
    const newestFirstOrder = order.length > 1 && order[0].at > order[order.length - 1].at;
    const out: ReactNode[] = [];
    order.forEach((m, i) => {
      const prev = order[i - 1];
      const boundary = newestFirstOrder ? prev && isNew(prev) && !isNew(m) : isNew(m) && (!prev || !isNew(prev));
      if (boundary)
        out.push(
          <div key="new-divider" ref={divider} className="new-divider" role="separator" aria-label="New since you last looked">
            <span>{newestFirstOrder ? `↑ ${fresh} new since you last looked` : `${fresh} new since you last looked`}</span>
          </div>,
        );
      out.push(render(m));
    });
    return out;
  };
  const [htmls, setHtmls] = useState<Record<string, string>>({});
  useEffect(() => {
    setHtmls({});
    if (item.source === 'gmail') get<Record<string, string>>(`/api/items/${item.id}/html`).then(setHtmls).catch(() => undefined);
  }, [item.id, item.source, item.updatedAt]);
  // When the item's buttons can't fit on one line even on a row of their own, the less-used ones fold into "More ▾".
  const head = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLSpanElement>(null);
  const compact = useFoldWhenTight(head, actions, [item.id, peek, item.data.muted]);
  const muteButton = (inMenu: boolean) => (
    <button
      className={inMenu ? 'menu-item' : `btn small ${item.data.muted ? '' : 'ghost'}`}
      role={inMenu ? 'menuitem' : undefined}
      aria-pressed={inMenu ? undefined : !!item.data.muted}
      title={item.data.muted ? 'Updates are silenced: still pulled in, but no notifications, unread marks or reopening. Click to unsilence.' : 'Keep pulling in updates but stop notifying, marking the stream unread or reopening it'}
      onClick={() => void post(`/api/items/${item.id}/mute`, { muted: !item.data.muted })}
    >
      {item.data.muted ? 'Unsilence' : 'Ignore updates'}
    </button>
  );
  const notRelevantButton = (inMenu: boolean) => (
    <button
      className={inMenu ? 'menu-item' : 'btn ghost small'}
      role={inMenu ? 'menuitem' : undefined}
      title="Remove this from the work stream. It won't be added back to it."
      onClick={() => void post(`/api/items/${item.id}/not-relevant`).then(() => onRemoved?.())}
    >
      Not relevant
    </button>
  );
  return (
    <div className="item-view">
      <div className="item-head" ref={head}>
        <SourceBadge source={item.source} />
        <h2>{item.title}</h2>
        {peek && <span className="chip subtle">{item.data.proposedStream ? `Proposed work stream: ${item.data.proposedStream.title}` : 'Skipped · preview'}</span>}
        {/* The item's buttons stay on one line: when the title leaves too little room they move under it together. */}
        <span className={`item-head-actions${compact ? ' compact' : ''}`} ref={actions}>
          {item.url && (
            <a className="btn ghost small" href={item.url} target="_blank" rel="noreferrer">
              Open ↗
            </a>
          )}
          {!peek && ['gmail', 'slack', 'jira', 'jsm'].includes(item.source) && <RefreshItem id={item.id} />}
        {!peek && onQuickReply && ['gmail', 'slack', 'jira', 'jsm'].includes(item.source) && (
          <button
            className="btn small primary"
            title={item.source === 'gmail' ? 'Open a blank reply-all draft' : item.source === 'slack' ? 'Open a blank message to this conversation' : 'Open a blank public comment'}
            onClick={() => onQuickReply(item)}
          >
            Quick reply
          </button>
        )}
        {!peek && onSetRead && (
          <button
            className="btn small read-btn"
            aria-label={manualRead && item.data.unread ? 'Mark item read' : 'Mark item unread'}
            title={manualRead && item.data.unread ? 'Mark this work item read' : 'Mark this work item unread (its tab gets a dot until you open it again)'}
            onClick={() => onSetRead(!!(manualRead && item.data.unread))}
          >
            {manualRead && item.data.unread ? 'Read' : 'Unread'}
          </button>
        )}
        {peek ? (
          <button className="btn ghost small" title={item.data.proposedStream ? "Don't make this a work stream. It comes back if there is new activity." : 'Hide this from the Skipped list until it has new activity'} onClick={onDismiss}>
            Decline
          </button>
        ) : compact ? (
          <MoreMenu>
            {muteButton(true)}
            {notRelevantButton(true)}
          </MoreMenu>
        ) : (
          <>
            {muteButton(false)}
            {notRelevantButton(false)}
          </>
        )}
        </span>
        {/* Tool-specific actions (Gmail, Slack, Jira) get their own row under the title and the item buttons. */}
        {item.source === 'gmail' && <GmailButtons item={item} />}
        {item.source === 'slack' && <SlackReadButton item={item} />}
        {!!item.data.ticket && <TicketButtons item={item} />}
      </div>
      {t ? (
        <>
          <dl className="ticket-fields">
            <div><dt>Status</dt><dd><TicketStatus item={item} status={t.status} /></dd></div>
            {/* long values are cut with … and shown whole on hover */}
            <div><dt>Assignee</dt><dd className="trunc" title={t.assignee ?? 'Unassigned'}>{t.assignee ?? 'Unassigned'}</dd></div>
            <div><dt>Requester</dt><dd className="trunc" title={t.requester ?? t.reporter ?? ''}>{t.requester ?? t.reporter ?? '—'}</dd></div>
            <div><dt>Type</dt><dd className="trunc" title={t.flavor === 'jsm' ? 'Service request' : 'Jira issue'}>{t.flavor === 'jsm' ? 'Service request' : 'Jira issue'}</dd></div>
          </dl>
          {t.description && (
            <div className="body block">
              <Linkified text={t.description} />
            </div>
          )}
          {!!t.attachments?.length && (
            <>
              <h3>Attachments · {t.attachments.length}</h3>
              <Attachments itemId={item.id} list={t.attachments} />
            </>
          )}
          <h3>Comments · {t.comments.length}</h3>
          {t.comments.length === 0 && <p className="muted">No comments yet.</p>}
          {withDivider(newestFirst.tickets ? [...t.comments].reverse() : t.comments, (c) => (
            <Message key={c.id} m={c} itemId={item.id} />
          ))}
        </>
      ) : item.data.meeting ? (
        <MeetingView m={item.data.meeting} />
      ) : item.data.messages ? (
        <SlackSelection item={item} enabled={!peek && item.source === 'slack'} order={((item.source === 'gmail' && newestFirst.email) || (item.source === 'slack' && newestFirst.slack) ? [...item.data.messages].reverse() : item.data.messages)}>
          {(order, pick) => (
            <div className={item.kind === 'slack_thread' ? 'thread slack' : 'thread'}>
              {withDivider(order, (m) => (
                <Message key={m.id} m={m} itemId={item.id} quick={quick} compact={item.kind === 'slack_thread'} html={htmls[m.id]} defaultOriginal={emailOriginal} item={!peek && item.source === 'slack' ? item : undefined} pick={pick?.(m)} />
              ))}
            </div>
          )}
        </SlackSelection>
      ) : (
        <pre className="body block">{item.data.body ?? JSON.stringify(item.data.raw ?? item.data, null, 2)}</pre>
      )}
    </div>
  );
}

/** Re-read this work item from Gmail, Slack or Jira now, instead of waiting for the next poll (no triage, no Claude call). */
function RefreshItem({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setErr(null), [id]);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/items/${id}/refresh`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={`btn small ghost refresh-btn${busy ? ' busy' : ''}`} disabled={busy} aria-busy={busy} aria-label="Refresh this work item" title={err ?? 'Check the source for anything new now, instead of waiting for the next poll'} onClick={() => void go()}>
      <span className="refresh-icon" aria-hidden="true">↻</span>
      {err && <span className="small error"> failed</span>}
    </button>
  );
}

/** A calendar meeting linked to the stream: when, who, and what Work Commander did around it. */
function MeetingView({ m }: { m: NonNullable<StreamItem['data']['meeting']> }) {
  const start = new Date(m.start);
  const end = new Date(m.end);
  const day = start.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const t = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const now = Date.now();
  const state = now < start.getTime() ? 'Upcoming' : now < end.getTime() ? 'In progress' : 'Ended';
  return (
    <div className="meeting">
      <div className="meeting-when">
        <span className="chip">{state}</span> {day}, {t(start)} – {t(end)}
      </div>
      <h3>Attendees · {m.attendees.length}</h3>
      <ul className="meeting-people">
        {m.attendees.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      <p className="muted small">
        {m.briefedAt ? `Brief posted in the chat ${new Date(m.briefedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. ` : 'A brief is posted in the chat before it starts (Settings → Meetings). '}
        {m.followedUpAt ? 'Follow-up offered or drafted after it ended.' : ''}
      </p>
    </div>
  );
}

/** "More ▾": a few less-used buttons, folded away when there isn't room for them. Closes on a choice, Esc or a click elsewhere. */
function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="more-menu" ref={box}>
      <button type="button" className="btn ghost small" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        More ▾
      </button>
      {open && (
        <span className="more-menu-list" role="menu" onClick={() => setOpen(false)}>
          {children}
        </span>
      )}
    </span>
  );
}

/** Coding work goes to Claude Code: Work Commander's agent has no shell or file tools by design. */
type HandoffInfo = { folder: string; canOpenTerminal: boolean; last: { folder: string; createdAt: string; returnedAt: string | null } | null };

function Handoff({ cc, streamId, updatedAt, open, onClose, onAvailable }: { cc?: ClaudeCodeStatus | null; streamId: string; updatedAt: string; open: boolean; onClose: () => void; onAvailable: (ok: boolean) => void }) {
  const [running, setRunning] = useState(false);
  // Run here: Claude Code works inside WC, in this stream's Claude chat (sandboxed; asks before commands, edits and web requests).
  const runHere = async () => {
    if (!cc?.token) return;
    setRunning(true);
    setErr(null);
    try {
      await ccPost(`/api/streams/${streamId}/claude-code/start`, cc.token, { folder, task: task.trim() || undefined });
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRunning(false);
    }
  };
  const ccBusy = cc?.session?.state === 'running' || cc?.session?.state === 'waiting';
  const [info, setInfo] = useState<HandoffInfo | null>(null);
  const setOpen = (v: boolean) => !v && onClose();
  const [folder, setFolder] = useState('');
  const [openTerminal, setOpenTerminal] = useState(true);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ folder: string; command: string; opened: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setInfo(null);
    setDone(null);
    setErr(null);
    setTask('');
  }, [streamId]);
  useEffect(() => {
    get<HandoffInfo>(`/api/streams/${streamId}/handoff`)
      .then((r) => {
        setInfo(r);
        setFolder((f) => f || r.folder);
        setOpenTerminal(r.canOpenTerminal);
        onAvailable(true);
      })
      .catch(() => (setInfo(null), onAvailable(false))); // not available (e.g. hosted on GCP)
  }, [streamId, updatedAt]);
  if (!info) return null;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      setDone(await post(`/api/streams/${streamId}/handoff`, { folder, openTerminal, task: task.trim() || undefined }));
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
      {open && (
        <div className="handoff-form">
          <p className="muted small">Writes everything this stream knows to BRIEF.md in the folder below{info.canOpenTerminal ? ', then opens Terminal with Claude Code running there' : ''}. Use it for work Work Commander's agent can't do itself: coding, or changing something it has no tool for, such as editing a Google Sheet or Doc.</p>
          <label className="small">
            What should Claude Code do?
            <textarea aria-label="What should Claude Code do?" rows={4} value={task} placeholder="e.g. In the sheet linked in this stream, change the Gainsight column for row 12 to “Approved”. Don't touch other cells." onChange={(e) => setTask(e.target.value)} />
          </label>
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
            {cc?.enabled && (
              <button className="btn small primary" disabled={running || ccBusy || !folder.trim()} title={ccBusy ? 'Claude Code is already working on this stream (see the chat)' : 'Run Claude Code here, in this stream\'s chat: sandboxed, and it asks you before commands, edits and web requests'} onClick={() => void runHere()}>
                {running ? 'Starting…' : 'Run here'}
              </button>
            )}
            <button className={`btn small ${cc?.enabled ? '' : 'primary'}`} disabled={busy || !folder.trim()} onClick={go}>
              {busy ? 'Handing off…' : done ? 'Hand off again' : cc?.enabled ? 'Open in Terminal' : 'Hand off'}
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

/** Rewrite the overview from the stream's items now, with the triage model (Settings → Claude). The old one stays under Previous overviews. */
function RefreshOverview({ streamId, disabled }: { streamId: string; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setErr(null), [streamId]);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/streams/${streamId}/refresh-overview`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="refresh-overview">
      <button type="button" className="btn small ghost" disabled={busy || disabled} title={disabled ? 'Nothing linked to summarise yet' : 'Have Claude rewrite this overview from the linked items (uses the triage model). The current one is kept under Previous overviews.'} onClick={() => void go()}>
        {busy ? 'Refreshing…' : 'Refresh overview'}
      </button>
      {err && <span className="small error"> {err}</span>}
    </span>
  );
}

type SummaryVersion = { id: number; summary: string; by: 'claude' | 'you' | 'unknown'; at: string | null };
const fmtFull = (iso: string) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function StreamOverview({ cc, showReason, stream, items, onOpen, onMarkUnread, onSetRead, manualRead, onTogglePending, confirmClose = true }: { cc?: ClaudeCodeStatus | null; showReason?: boolean; stream: WorkStream; items: StreamItem[]; onOpen: (id: string) => void; onMarkUnread?: () => void; onSetRead?: (read: boolean) => void; manualRead?: boolean; onTogglePending?: () => void; confirmClose?: boolean }) {
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
  // Hand-off to Claude Code: its button sits in the row at the top; the form and its status show just below.
  const [handoffOpen, setHandoffOpen] = useState(false);
  // Previous overviews: collapsed until you open them; your choice holds for every work stream.
  const [historyOpen, setHistoryOpen] = useState(() => {
    try {
      return localStorage.getItem('wc.prevOverviewsOpen') === '1';
    } catch {
      return false;
    }
  });
  const toggleHistory = () =>
    setHistoryOpen((o) => {
      try {
        localStorage.setItem('wc.prevOverviewsOpen', o ? '0' : '1');
      } catch {
        /* just for now */
      }
      return !o;
    });
  const [canHandoff, setCanHandoff] = useState(false);
  useEffect(() => setHandoffOpen(false), [stream.id]);
  // When the buttons don't fit on one line, Unread and Claude Code fold into "More ▾" (the alarm and Close stay out).
  const ovRow = useRef<HTMLDivElement>(null);
  const ovFolded = useFoldWhenTight(ovRow, ovRow, [stream.id, stream.status, stream.unread, canHandoff, manualRead]);
  const unreadButton = (inMenu: boolean) =>
    manualRead && onSetRead ? (
      <button className={inMenu ? 'menu-item' : 'btn small read-btn'} role={inMenu ? 'menuitem' : undefined} aria-label={stream.unread ? 'Mark read' : 'Mark unread'} title={stream.unread ? 'Mark this work stream read' : 'Mark this work stream unread'} onClick={() => onSetRead(stream.unread)}>
        {stream.unread ? 'Read' : 'Unread'}
      </button>
    ) : onMarkUnread ? (
      <button className={inMenu ? 'menu-item' : 'btn small'} role={inMenu ? 'menuitem' : undefined} aria-label="Mark unread" title="Mark this work stream unread and go back to the list" onClick={onMarkUnread}>
        Unread
      </button>
    ) : null;
  const ccButton = (inMenu: boolean) =>
    canHandoff ? (
      <button type="button" className={inMenu ? 'menu-item' : `btn small${handoffOpen ? ' on' : ''}`} role={inMenu ? 'menuitem' : undefined} aria-expanded={inMenu ? undefined : handoffOpen} aria-label="Hand off to Claude Code" title="Hand this work off to Claude Code (writes a brief, then opens it in Terminal)" onClick={() => setHandoffOpen((o) => !o)}>
        Claude Code
      </button>
    ) : null;

  return (
    <div className="item-view overview">
      <div className="item-head">
        <input className="title-input" aria-label="Work stream title" title={title} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== stream.title && save({ title })} />
        <div className="ov-actions" ref={ovRow}>
        {onTogglePending && stream.status === 'open' && (
          <span className="pending-split">
          <button
            type="button"
            className={`btn small pending-btn ${stream.pending ? 'on' : ''}`}
            aria-label={stream.pending ? 'Pending: put back in Open' : 'Mark pending'}
            aria-pressed={stream.pending}
            title={stream.pending ? 'Pending: waiting on others. Click to put it back in Open.' : "Mark pending (snooze): I've done all I can for now and am waiting on others. It stays open and returns to the top when something new arrives, or as a Reminder if nothing happens for a few days (Settings → Display)."}
            onClick={onTogglePending}
          >
            <AlarmIcon />
          </button>
          <SnoozeMenu onPending={() => void save({ pending: true })} onSnooze={(snoozeUntil) => void patch(`/api/streams/${stream.id}`, { pending: true, snoozeUntil })} extra={promisedOption(stream)} />
          </span>
        )}
        {!ovFolded && unreadButton(false)}
        {stream.status === 'open' ? (
          // Same labels as the work stream's tile: Unread, Close, then Confirm.
          <ConfirmButton confirm={confirmClose} onConfirm={() => save({ status: 'closed' })} ariaLabel="Close stream" armedAriaLabel="Confirm close" armedChildren="Confirm" title={confirmClose ? 'Close this work stream (asks you to click twice)' : 'Close this work stream'} armedTitle="Click again to close this work stream">
            Close
          </ConfirmButton>
        ) : (
          <button className="btn small" onClick={() => save({ status: 'open' })}>
            Reopen
          </button>
        )}
        {!ovFolded && ccButton(false)}
        {ovFolded && (unreadButton(true) || ccButton(true)) && (
          <MoreMenu>
            {unreadButton(true)}
            {ccButton(true)}
          </MoreMenu>
        )}
        </div>
      </div>
      <Handoff cc={cc} streamId={stream.id} updatedAt={stream.updatedAt} open={handoffOpen} onClose={() => setHandoffOpen(false)} onAvailable={setCanHandoff} />
      {showReason && stream.reason && (
        <div className="ov-reason">
          <span className="muted">Why it's here:</span> {stream.reason}
        </div>
      )}
      {stream.pending && stream.waitingOn && (
        <div className="ov-waiting">
          Waiting on <b>{stream.waitingOn.who}</b> · {waitedFor(stream.waitingOn.since)}
        </div>
      )}
      {stream.status === 'open' && <DueLine stream={stream} />}
      <textarea className="summary-input" rows={12} value={summary} placeholder="Summary (Claude keeps this current)" onChange={(e) => setSummary(e.target.value)} onBlur={() => summary !== stream.summary && save({ summary })} />
      <div className="overview-foot">
        <div className="muted small">
          Opened {ago(stream.createdAt)} · last activity {ago(stream.lastActivityAt)}
        </div>
        <RefreshOverview streamId={stream.id} disabled={items.length === 0} />
      </div>

      {history.length > 0 && (
        <>
          <h3>
            <button type="button" className="disclosure" aria-expanded={historyOpen} onClick={toggleHistory}>
              <span className="tri" aria-hidden="true">▸</span> Previous overviews · {history.length}
            </button>
          </h3>
          {historyOpen && (
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
          )}
        </>
      )}

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

      <StreamUsageLine streamId={stream.id} updatedAt={stream.updatedAt} />
    </div>
  );
}

/** This stream's Claude usage so far, in estimated dollars by category (a pie with a labelled legend). */
function StreamUsageLine({ streamId, updatedAt }: { streamId: string; updatedAt: string }) {
  const [u, setU] = useState<StreamUsage | null>(null);
  useEffect(() => {
    get<StreamUsage>(`/api/streams/${streamId}/usage`).then(setU, () => setU(null));
  }, [streamId, updatedAt]);
  if (!u || u.total.calls === 0) return null;
  const parts = USAGE_CATEGORIES.filter((c) => u.byCategory?.[c.id]).map((c) => ({ id: c.id, label: c.label, hint: c.hint, t: u.byCategory[c.id]! }));
  return (
    <section className="stream-usage">
      <h3>Claude usage</h3>
      <p className="muted small">Estimated at API prices{u.unit === 'tokens' ? ` · ${formatUsage(u.total, 'tokens')}` : ''}. Background checks for new activity aren't tied to one work stream; they're in Settings → Usage.</p>
      <UsagePie parts={parts} />
    </section>
  );
}

/** Jira/JSM actions in their own row under the title: Copy link (the ticket's address, to the clipboard) and Assign to me. */
function TicketButtons({ item }: { item: StreamItem }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const assignMe = async () => {
    setAssigning(true);
    setErr(null);
    try {
      await post(`/api/items/${item.id}/jira/assign-me`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setAssigning(false);
    }
  };
  const url = item.url ?? '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <span className="gmail-actions" role="group" aria-label="Jira">
      {url && (
        <button type="button" className="btn small gmail-btn" title={`Copy ${url}`} onClick={() => void copy()}>
          <span>{copied === 'ok' ? 'Copied' : copied === 'fail' ? "Couldn't copy" : 'Copy link'}</span>
          <span aria-hidden="true" className="gmail-btn-alt">
            Couldn't copy
          </span>
        </button>
      )}
      <button type="button" className={`btn small gmail-btn${assigning ? ' busy' : ''}`} disabled={assigning} aria-busy={assigning} title="Assign this ticket to you in Jira (Undo gives it back)" onClick={() => void assignMe()}>
        Assign to me
      </button>
      {err && <span className="small error">{err}</span>}
    </span>
  );
}

/**
 * A Jira/JSM ticket's status as a drop-down: picking one moves the ticket right away (Undo moves it back). When Jira requires
 * something for that move (e.g. a Resolution), a small box asks for it first. Just the status when Jira can't be asked.
 */
function TicketStatus({ item, status }: { item: StreamItem; status: string }) {
  const [opts, setOpts] = useState<TicketTransitionOption[] | null>(null);
  const [asking, setAsking] = useState<TicketTransitionOption | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setAsking(null);
    setErr(null);
    get<{ transitions: TicketTransitionOption[] }>(`/api/items/${item.id}/jira/transitions`)
      .then((r) => setOpts(r.transitions))
      .catch(() => setOpts(null));
  }, [item.id, status]);
  if (!opts) return <span className="chip">{status}</span>;
  const apply = async (o: TicketTransitionOption, given: Record<string, string>) => {
    setBusy(true);
    setErr(null);
    try {
      const fields = Object.fromEntries(o.fields.map((f) => [f.key, f.allowed ? { id: given[f.key] } : given[f.key]]));
      await post(`/api/items/${item.id}/jira/transition`, { id: o.id, fields: o.fields.length ? fields : undefined });
      setAsking(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (id: string) => {
    const o = opts.find((x) => x.id === id);
    if (!o) return;
    if (!o.fields.length) return void apply(o, {});
    setValues(Object.fromEntries(o.fields.map((f) => [f.key, f.allowed?.[0]?.id ?? ''])));
    setAsking(o);
  };
  return (
    <span className="ticket-status">
      <select aria-label="Status" value="" disabled={busy} onChange={(e) => pick(e.target.value)} title="Change the status in Jira">
        <option value="" disabled>
          {busy ? 'Moving…' : status}
        </option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name === o.to ? o.to : `${o.name} → ${o.to}`}
          </option>
        ))}
      </select>
      {asking && (
        <span className="ticket-status-ask" role="group" aria-label={`Moving to ${asking.to}`}>
          {asking.fields.map((f) =>
            f.allowed ? (
              <label key={f.key}>
                {f.name}{' '}
                <select value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                  {f.allowed.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label key={f.key}>
                {f.name} <input value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              </label>
            ),
          )}
          <button type="button" className="btn small primary" disabled={busy || asking.fields.some((f) => !values[f.key])} onClick={() => void apply(asking, values)}>
            Move to {asking.to}
          </button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={() => setAsking(null)}>
            Cancel
          </button>
        </span>
      )}
      {err && <span className="small error">{err}</span>}
    </span>
  );
}

/**
 * Mark read / Mark unread in Slack itself, for a DM, group DM or channel item (Slack lets apps set no read marker on a thread, so
 * threads don't get it). Shows the conversation's state in Slack, re-checked on opening; hidden when Slack can't be asked.
 */
function SlackReadButton({ item }: { item: StreamItem }) {
  const [unread, setUnread] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setUnread(null);
    setErr(null);
    get<{ unread: boolean }>(`/api/items/${item.id}/slack-read`)
      .then((s) => setUnread(s.unread))
      .catch(() => setUnread(null));
  }, [item.id]);
  if (unread === null) return null;
  const act = async () => {
    setBusy(true);
    setErr(null);
    try {
      setUnread((await post<{ unread: boolean }>(`/api/items/${item.id}/slack-read`, { read: unread })).unread);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="gmail-actions" role="group" aria-label="Slack">
      <button type="button" className={`btn small gmail-btn${busy ? ' busy' : ''}`} disabled={busy} aria-busy={busy} title={unread ? 'Mark this conversation read in Slack' : 'Mark this conversation unread in Slack (from its latest message)'} onClick={() => void act()}>
        <span>{unread ? 'Mark read in Slack' : 'Mark unread in Slack'}</span>
        <span aria-hidden="true" className="gmail-btn-alt">
          {unread ? 'Mark unread in Slack' : 'Mark read in Slack'}
        </span>
      </button>
      {err && <span className="small error">{err}</span>}
    </span>
  );
}

/**
 * Mark read, Archive and Delete for an email work item, acting on the whole thread in Gmail. Each shows where the thread is
 * in Gmail now (re-checked when you open the item), so after a click it becomes its undo: Mark unread, Unarchive, Undelete.
 * The item stays in its work stream either way. Hidden when Gmail isn't reachable this way (e.g. connected over MCP).
 */
function GmailButtons({ item }: { item: StreamItem }) {
  const [state, setState] = useState<GmailThreadState | null>(item.data.gmail?.state ?? null);
  const [busy, setBusy] = useState<GmailAction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [usable, setUsable] = useState(true);
  useEffect(() => {
    setErr(null);
    get<GmailThreadState>(`/api/items/${item.id}/gmail`)
      .then((s) => {
        setState(s);
        setUsable(true);
      })
      .catch(() => setUsable(!!item.data.gmail?.state));
    // only on opening the item; later changes arrive with the item
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);
  useEffect(() => {
    if (item.data.gmail?.state) setState(item.data.gmail.state);
  }, [item.data.gmail?.state]);
  if (!usable || !state) return null;
  const act = async (action: GmailAction) => {
    setBusy(action);
    setErr(null);
    try {
      setState(await post<GmailThreadState>(`/api/items/${item.id}/gmail`, { action }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  // Each button keeps one width whichever of its two labels it shows (both are laid out; the other is invisible), and keeps its
  // label while working, so nothing in the toolbar shifts when you click.
  const PAIR: Record<GmailAction, string> = { read: 'Mark unread', unread: 'Mark read', archive: 'Unarchive', unarchive: 'Archive', trash: 'Undelete', untrash: 'Delete' };
  const btn = (action: GmailAction, label: string, title: string, off = false) => (
    <button type="button" className={`btn small gmail-btn${busy === action ? ' busy' : ''}`} disabled={!!busy || off} aria-busy={busy === action} title={title} onClick={() => void act(action)}>
      <span>{label}</span>
      <span aria-hidden="true" className="gmail-btn-alt">
        {PAIR[action]}
      </span>
    </button>
  );
  return (
    <span className="gmail-actions" role="group" aria-label="Gmail">
      {state.unread ? btn('read', 'Mark read', 'Mark the whole thread read in Gmail') : btn('unread', 'Mark unread', 'Mark the thread unread in Gmail again')}
      {/* While the thread is in Trash, Archive stays in place (disabled) so the buttons don't move. */}
      {state.inbox || state.trash ? btn('archive', 'Archive', state.trash ? 'The thread is in Trash: Undelete it first' : 'Archive the thread in Gmail (out of the Inbox). It stays in this work stream.', state.trash) : btn('unarchive', 'Unarchive', 'Move the thread back to the Gmail Inbox')}
      {state.trash ? btn('untrash', 'Undelete', 'Take the thread out of Gmail Trash, back to the Inbox') : btn('trash', 'Delete', 'Move the thread to Gmail Trash (recoverable for 30 days). It stays in this work stream.')}
      {err && <span className="small error">{err}</span>}
    </span>
  );
}

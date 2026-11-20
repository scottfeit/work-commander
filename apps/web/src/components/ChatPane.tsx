import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ClaudeCodeStatus, StreamItem } from '@wc/shared';
import { ccPost, get, post, fmtTime } from '../api';
import { ThinkingMark } from './ThinkingMark';

interface Props {
  streamId: string;
  streamTitle: string;
  selectedItem: StreamItem | null;
  messages: ChatMessage[];
  live: string | null;
  running: boolean;
  /** Claude Code inside WC for this stream, when it's on. */
  cc?: ClaudeCodeStatus | null;
}

export function ChatPane({ streamId, streamTitle, selectedItem, messages, live, running, cc }: Props) {
  const [text, setText] = useState('');
  // Who a message goes to: WC's Claude, or the stream's Claude Code session (the default while it's working).
  const ccSession = cc?.enabled ? cc.session : null;
  const ccWorking = ccSession?.state === 'running' || ccSession?.state === 'waiting';
  const [toCc, setToCc] = useState(false);
  useEffect(() => setToCc(ccWorking), [ccWorking, streamId]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, live]);
  const openQuestion = [...messages].reverse().find((m) => m.role === 'question' && !m.meta.question?.answered);

  const send = async (t = text, answersQuestionId = openQuestion?.id) => {
    if (!t.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      if (toCc && ccSession && cc?.token) await ccPost(`/api/streams/${streamId}/claude-code/message`, cc.token, { text: t.trim() });
      else await post(`/api/streams/${streamId}/chat`, { text: t.trim(), selectedItemId: selectedItem?.id, answersQuestionId });
      setText('');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat">
      <div className="pane-head">
        <span className="claude-mark" /> Claude
        <span className="muted small ctx">
          {streamTitle}
          {selectedItem ? ` › ${selectedItem.data.ticket?.key ?? selectedItem.title}` : ''}
        </span>
        {ccWorking && cc?.token && (
          <span className="cc-state">
            <span className="chip running" title={ccSession!.state === 'waiting' ? 'Claude Code is waiting for your Allow / Deny below' : 'Claude Code is working'}>{ccSession!.state === 'waiting' ? 'Claude Code: waiting for you' : 'Claude Code: working'}</span>
            <button type="button" className="btn small" onClick={() => void ccPost(`/api/streams/${streamId}/claude-code/stop`, cc.token!)}>
              Stop
            </button>
          </span>
        )}
      </div>
      <div className="chat-scroll" ref={scroller}>
        {messages.length === 0 && !live && <div className="muted pad">Ask about this work stream, or tell Claude what to do next. Claude also sees every other open stream.</div>}
        {messages.map((m) => (
          <ChatBubble key={m.id} m={m} onAnswer={(a) => send(a, m.id)} ccToken={cc?.token} cc={cc} streamId={streamId} />
        ))}
        {live !== null && (
          <div className="bubble assistant streaming">
            <div className="body">{live.trim() || <ThinkingMark />}</div>
          </div>
        )}
        {running && live === null && (
          <div className="typing">
            <ThinkingMark size={16} /> Claude is working…
          </div>
        )}
      </div>
      {err && <div className="error small">{err}</div>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {ccSession && (
          <div className="send-to" role="radiogroup" aria-label="Send to">
            <span className="muted small">To</span>
            <label className={!toCc ? 'on' : ''}>
              <input type="radio" name={`send-to-${streamId}`} checked={!toCc} onChange={() => setToCc(false)} /> Claude
            </label>
            <label className={toCc ? 'on' : ''}>
              <input type="radio" name={`send-to-${streamId}`} checked={toCc} onChange={() => setToCc(true)} /> Claude Code
            </label>
          </div>
        )}
        <textarea
          rows={2}
          placeholder={toCc && ccSession ? (ccWorking ? 'Message Claude Code (it reads this when it next can)' : 'Message Claude Code to carry on (same session)') : openQuestion ? 'Answer Claude…' : 'Message Claude (Enter to send, Shift+Enter for newline)'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

/** Claude Code asks to use a tool: what exactly, and Allow / Deny (answered right away, in Claude Code). */
function CcApproval({ m, token }: { m: ChatMessage; token?: string }) {
  const a = m.meta.ccApproval!;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answer = async (allow: boolean) => {
    if (!token) return;
    setBusy(true);
    setErr(null);
    try {
      await ccPost(`/api/claude-code/approvals/${a.id}`, token, { allow });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`cc-approval ${a.status}`} role="group" aria-label={`Claude Code asks: ${a.summary}`}>
      <div className="cc-approval-head">
        <span className="cc-tag">Claude Code</span> asks to <b>{a.summary.charAt(0).toLowerCase() + a.summary.slice(1)}</b>
      </div>
      {a.detail && <pre className="cc-detail">{a.detail}</pre>}
      {a.status === 'waiting' ? (
        <div className="row">
          <button type="button" className="btn small primary" disabled={busy || !token} onClick={() => void answer(true)}>
            Allow
          </button>
          <button type="button" className="btn small" disabled={busy || !token} onClick={() => void answer(false)}>
            Deny
          </button>
          {err && <span className="small error">{err}</span>}
        </div>
      ) : (
        <div className="muted small">{a.status === 'allowed' ? 'Allowed' : a.status === 'denied' ? 'Denied' : 'No longer waiting'}</div>
      )}
    </div>
  );
}

function ChatBubble({ m, onAnswer, ccToken, cc, streamId }: { m: ChatMessage; onAnswer: (a: string) => void; ccToken?: string; cc?: ClaudeCodeStatus | null; streamId: string }) {
  if (m.meta.ccApproval) return <CcApproval m={m} token={ccToken} />;
  if (m.meta.claudeCode && m.role === 'system') return <div className="sys-note cc-note">{m.content}</div>;
  if (m.meta.claudeCode && (m.role === 'assistant' || m.role === 'user'))
    return (
      <div className={`bubble ${m.role} cc`}>
        <div className="cc-tag">{m.role === 'assistant' ? 'Claude Code' : 'You → Claude Code'}</div>
        <div className="body">{m.content}</div>
        <div className="meta muted small">{fmtTime(m.createdAt)}</div>
      </div>
    );
  if (m.role === 'suggestion' && m.meta.handoffOffer) return <HandoffOfferBubble m={m} cc={cc} streamId={streamId} />;
  if (m.role === 'suggestion' && m.meta.chatOffer) return <ChatOfferBubble m={m} />;
  if (m.role === 'suggestion') {
    const st = m.meta.suggestion?.status ?? 'open';
    return (
      <div className={`bubble suggestion ${st}`}>
        <div className="small muted">Claude offers</div>
        <div className="body">{m.content}</div>
        {st === 'open' ? (
          <div className="actions">
            <button className="btn small primary" onClick={() => post(`/api/chat/${m.id}/suggestion`, { accept: true })}>
              Yes, go ahead
            </button>
            <button className="btn small ghost" onClick={() => post(`/api/chat/${m.id}/suggestion`, { accept: false })}>
              Dismiss
            </button>
          </div>
        ) : (
          <div className="small muted">{st === 'accepted' ? 'Accepted' : 'Dismissed'}</div>
        )}
      </div>
    );
  }
  if (m.role === 'question') {
    const answered = !!m.meta.question?.answered;
    return (
      <div className="bubble question">
        <div className="small muted">Claude asks</div>
        <div className="body">{m.content}</div>
        {!answered && m.meta.question?.options?.length ? (
          <div className="actions">
            {m.meta.question.options.map((o) => (
              <button key={o} className="btn small" onClick={() => onAnswer(o)}>
                {o}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (m.role === 'system') return <div className="sys-note">{m.content}</div>;
  return (
    <div className={`bubble ${m.role}`}>
      <div className="body">{m.content}</div>
      <div className="meta">
        {fmtTime(m.createdAt)}
        {m.meta.toolCalls?.length ? (
          <details>
            <summary>{m.meta.toolCalls.length} tool calls</summary>
            <ul>
              {m.meta.toolCalls.map((t, i) => (
                <li key={i}>
                  <code>{t.name}</code>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Someone said they added the PU to a chat; WC found one that looks like it. */
function ChatOfferBubble({ m }: { m: ChatMessage }) {
  const offer = m.meta.chatOffer!;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const choose = async (choice: 'add' | 'dismiss') => {
    setBusy(choice);
    setErr(null);
    try {
      await post(`/api/chat/${m.id}/chat-offer`, { choice });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={`bubble suggestion chat-offer ${offer.state === 'dismissed' ? 'dismissed' : ''}`}>
      <div className="small muted">Found a chat</div>
      <div className="body">{m.content}</div>
      {offer.reason && <div className="small muted">{offer.reason}</div>}
      {offer.state === 'open' && (
        <div className="actions">
          <button className="btn small primary" disabled={!!busy} onClick={() => choose('add')}>
            {busy === 'add' ? 'Adding…' : 'Add this chat'}
          </button>
          <button className="btn small ghost" disabled={!!busy} onClick={() => choose('dismiss')}>
            Not this one
          </button>
        </div>
      )}
      {offer.state === 'added' && <div className="small muted">{offer.added ? `Added ${offer.added} message${offer.added === 1 ? '' : 's'}.` : 'Nothing in it looked related, so nothing was added.'}</div>}
      {offer.state === 'dismissed' && <div className="small muted">Not added.</div>}
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

/** Claude asks: send an "I'm looking into it" reply, or hand the work to Claude Code? One click for either. */
function HandoffOfferBubble({ m, cc, streamId }: { m: ChatMessage; cc?: ClaudeCodeStatus | null; streamId: string }) {
  const offer = m.meta.handoffOffer!;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // With "Run Claude Code inside Work Commander" on, the hand-off runs here, in this chat; otherwise in Terminal.
  const here = !!(cc?.enabled && cc.token && !cc.unavailable);
  const choose = async (choice: 'reply' | 'handoff' | 'dismiss') => {
    setBusy(choice);
    setErr(null);
    try {
      if (choice === 'handoff' && here) {
        const st = cc!.session?.state;
        if (st === 'running' || st === 'waiting') {
          await ccPost(`/api/streams/${streamId}/claude-code/message`, cc!.token!, { text: offer.task });
        } else {
          const { folder } = await get<{ folder: string }>(`/api/streams/${streamId}/handoff`);
          await ccPost(`/api/streams/${streamId}/claude-code/start`, cc!.token!, { folder, task: offer.task });
        }
        await post(`/api/chat/${m.id}/handoff-offer`, { choice, where: 'here' });
        return;
      }
      await post(`/api/chat/${m.id}/handoff-offer`, { choice });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  const left = (offer.noReply ? (['handoff'] as const) : (['reply', 'handoff'] as const)).filter((c) => !offer.done.includes(c));
  return (
    <div className={`bubble suggestion handoff-offer ${offer.dismissed ? 'dismissed' : ''}`}>
      <div className="small muted">Claude asks</div>
      <div className="body">{m.content}</div>
      <details className="small">
        <summary>Task for Claude Code</summary>
        <div className="body">{offer.task}</div>
      </details>
      {!offer.dismissed && left.length > 0 && (
        <div className="actions">
          {left.includes('reply') && (
            <button className="btn small" disabled={!!busy} onClick={() => choose('reply')}>
              Draft “I’m looking into it”
            </button>
          )}
          {left.includes('handoff') && (
            <button className="btn small primary" disabled={!!busy} title={here ? 'Claude Code works on it here, in this chat (it asks before running commands or changing files)' : 'Opens Claude Code in Terminal with a brief'} onClick={() => choose('handoff')}>
              Hand off to Claude Code
            </button>
          )}
          <button className="btn small ghost" disabled={!!busy} onClick={() => choose('dismiss')}>
            Dismiss
          </button>
        </div>
      )}
      {(offer.done.length > 0 || offer.dismissed) && (
        <div className="small muted">
          {offer.dismissed ? 'Dismissed' : ''}
          {offer.done.includes('reply') ? 'Drafting “I’m looking into it”. ' : ''}
          {offer.done.includes('handoff') ? 'Handed off to Claude Code. ' : ''}
        </div>
      )}
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

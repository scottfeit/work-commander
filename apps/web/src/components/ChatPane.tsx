import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, StreamItem } from '@wc/shared';
import { post, fmtTime } from '../api';

interface Props {
  streamId: string;
  streamTitle: string;
  selectedItem: StreamItem | null;
  messages: ChatMessage[];
  live: string | null;
  running: boolean;
}

export function ChatPane({ streamId, streamTitle, selectedItem, messages, live, running }: Props) {
  const [text, setText] = useState('');
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
      await post(`/api/streams/${streamId}/chat`, { text: t.trim(), selectedItemId: selectedItem?.id, answersQuestionId });
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
      </div>
      <div className="chat-scroll" ref={scroller}>
        {messages.length === 0 && !live && <div className="muted pad">Ask about this work stream, or tell Claude what to do next. Claude also sees every other open stream.</div>}
        {messages.map((m) => (
          <ChatBubble key={m.id} m={m} onAnswer={(a) => send(a, m.id)} />
        ))}
        {live !== null && (
          <div className="bubble assistant streaming">
            <div className="body">{live.trim() || '…'}</div>
          </div>
        )}
        {running && live === null && <div className="typing">Claude is working…</div>}
      </div>
      {err && <div className="error small">{err}</div>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={2}
          placeholder={openQuestion ? 'Answer Claude…' : 'Message Claude (Enter to send, Shift+Enter for newline)'}
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

function ChatBubble({ m, onAnswer }: { m: ChatMessage; onAnswer: (a: string) => void }) {
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

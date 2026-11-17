import { useState } from 'react';
import type { Settings } from '@wc/shared';
import { post } from '../api';
import { Row, Toggle } from './parts';

/** Settings → Writing style: drafts that sound like you, from a guide learned from your sent messages (and editable). */
export function StyleSection({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const style = s.style ?? { enabled: true, guide: '' };
  const set = (patch: Partial<NonNullable<Settings['style']>>) => setS({ ...s, style: { ...style, ...patch } });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const learn = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ guide: string; sample: { email: number; slack: number } }>('/api/style/learn');
      set({ guide: r.guide, learnedAt: new Date().toISOString() });
      setMsg({ ok: true, text: `Learned from ${r.sample.email} email${r.sample.email === 1 ? '' : 's'} and ${r.sample.slack} Slack message${r.sample.slack === 1 ? '' : 's'} you wrote. Review it, then Save changes.` });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h2>Writing style</h2>
      <p className="muted small">
        Claude drafts replies, Slack messages and ticket comments the way you write: greeting, length, tone, sign-off, and who you usually copy. The guide below is learned from your own sent messages (one call to Claude; the
        copying habits are counted, not guessed). Edit it freely.
      </p>
      <Row label="Drafts">
        <Toggle checked={style.enabled} onChange={(enabled) => set({ enabled })} label="Write drafts in my style" />
      </Row>
      <div className="inline">
        <button type="button" className="btn small" disabled={busy} onClick={() => void learn()}>
          {busy ? 'Learning…' : style.guide ? 'Learn again from my sent messages' : 'Learn from my sent messages'}
        </button>
        {style.learnedAt && <span className="muted small">Last learned {new Date(style.learnedAt).toLocaleDateString()}</span>}
        {msg && <span className={`small ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</span>}
      </div>
      <textarea
        aria-label="Writing style guide"
        className="summary-input"
        rows={16}
        value={style.guide}
        placeholder={'Email\n- Short and direct; "Hi <first name>," then the point.\n\nSlack\n- Lower-case, no sign-off.\n\nSign-offs (" / " = new line)\n- Thanks, / Scott\n\nCopying people\n- You usually reply-all on group threads.'}
        onChange={(e) => set({ guide: e.target.value })}
      />
    </section>
  );
}

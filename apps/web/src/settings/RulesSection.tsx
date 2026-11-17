import { useEffect, useState } from 'react';
import type { Settings, TriageRule, WorkStream } from '@wc/shared';
import { get } from '../api';

type Up = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => void;

const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Settings → Rules: ignore or file matching updates before triage, without asking Claude. */
export function RulesSection({ s, setS }: { s: Settings; setS: (s: Settings) => void; up?: Up }) {
  const rules = s.rules ?? [];
  const [streams, setStreams] = useState<WorkStream[]>([]);
  useEffect(() => {
    get<WorkStream[]>('/api/streams?includeClosed=1').then(setStreams, () => undefined);
  }, []);
  const set = (next: TriageRule[]) => setS({ ...s, rules: next });
  const edit = (id: string, patch: Partial<TriageRule>) => set(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...rules];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set(next);
  };
  return (
    <section>
      <h2>Rules</h2>
      <p className="muted small">
        Applied before triage to anything that isn't in a work stream yet. A matching update is ignored, or filed straight into a work stream, without asking Claude, so it costs nothing. Every condition you fill in must
        match (it's "contains", ignoring case); the first matching rule wins. Press Save changes to apply.
      </p>
      <div className="rules">
        {rules.map((r, i) => {
          const empty = !r.from?.trim() && !r.subject?.trim() && !r.text?.trim();
          return (
            <div key={r.id} className={`rule${r.enabled === false ? ' off' : ''}`} aria-label={`Rule ${i + 1}`} role="group">
              <div className="rule-when">
                <span className="rule-k">When</span>
                <select aria-label="Source" value={r.source} onChange={(e) => edit(r.id, { source: e.target.value as TriageRule['source'] })}>
                  <option value="any">any source</option>
                  <option value="gmail">Gmail</option>
                  <option value="slack">Slack</option>
                  <option value="jira">Jira</option>
                </select>
                <input aria-label="From contains" placeholder="from contains (name or address)" value={r.from ?? ''} onChange={(e) => edit(r.id, { from: e.target.value })} />
                <input aria-label="Subject contains" placeholder="subject / title contains" value={r.subject ?? ''} onChange={(e) => edit(r.id, { subject: e.target.value })} />
                <input aria-label="Text contains" placeholder="message text contains" value={r.text ?? ''} onChange={(e) => edit(r.id, { text: e.target.value })} />
              </div>
              <div className="rule-then">
                <span className="rule-k">then</span>
                <select aria-label="Action" value={r.action === 'stream' ? `stream:${r.streamId ?? ''}` : 'ignore'} onChange={(e) => (e.target.value === 'ignore' ? edit(r.id, { action: 'ignore', streamId: undefined }) : edit(r.id, { action: 'stream', streamId: e.target.value.slice(7) || undefined }))}>
                  <option value="ignore">ignore it</option>
                  {r.action === 'stream' && !r.streamId && <option value="stream:">file into… (pick a work stream)</option>}
                  {r.action === 'stream' && r.streamId && !streams.some((x) => x.id === r.streamId) && <option value={`stream:${r.streamId}`}>file into (deleted work stream)</option>}
                  {streams.map((x) => (
                    <option key={x.id} value={`stream:${x.id}`}>
                      file into "{x.title}"{x.status === 'closed' ? ' (closed: reopens)' : ''}
                    </option>
                  ))}
                </select>
                <label className="small">
                  <input type="checkbox" aria-label="Rule on" checked={r.enabled !== false} onChange={(e) => edit(r.id, { enabled: e.target.checked })} /> On
                </label>
                <span className="rule-tools">
                  <button type="button" className="btn small ghost" aria-label="Move rule up" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="btn small ghost" aria-label="Move rule down" disabled={i === rules.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => set(rules.filter((x) => x.id !== r.id))}>
                    Delete
                  </button>
                </span>
              </div>
              {empty && <div className="small muted">Fill in at least one condition; an empty rule is never applied.</div>}
            </div>
          );
        })}
        {!rules.length && <p className="muted small">No rules yet.</p>}
      </div>
      <button type="button" className="btn small" onClick={() => set([...rules, { id: newId(), source: 'any', action: 'ignore', from: '' }])}>
        Add rule
      </button>
    </section>
  );
}

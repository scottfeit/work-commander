import type { Settings } from '@wc/shared';
import { Row, Toggle } from './parts';

/** Settings → Claude Code: run Claude Code inside WC (off by default), and its limits. */
export function ClaudeCodeSection({ s, setS, local }: { s: Settings; setS: (s: Settings) => void; local: boolean }) {
  const cc = s.claudeCode ?? { enabled: false, allowedDomains: [], maxMinutes: 30, maxTurns: 80, maxBudgetUsd: 5 };
  const set = (patch: Partial<typeof cc>) => setS({ ...s, claudeCode: { ...cc, ...patch } });
  return (
    <section>
      <h2>Claude Code</h2>
      <p className="muted small">
        Run Claude Code inside Work Commander: in a work stream, "Claude Code" → <b>Run here</b> starts it in the hand-off folder, and it works in the stream's Claude chat. (Open in Terminal still works as before.)
      </p>
      <Row label="Run inside Work Commander" hint={local ? undefined : 'Only when Work Commander runs on your own machine.'}>
        <Toggle checked={cc.enabled} disabled={!local} onChange={(enabled) => set({ enabled })} label="Let Claude Code run inside Work Commander" />
      </Row>
      <div className="cc-protections small">
        <b>How it's kept safe</b>
        <ul>
          <li>It only starts when you click Run here, never from a message or triage.</li>
          <li>Reading inside its folder is free; every command, file change, reading outside the folder and web request waits for your Allow in the chat.</li>
          <li>Commands run in your computer's sandbox: they can write only inside the folder, can't read SSH keys, cloud logins or Work Commander's own data, and reach only the sites below.</li>
          <li>Your own Claude Code settings, hooks and plugins aren't loaded (they could pre-approve commands), and it gets no Work Commander secrets.</li>
          <li>Messages and tickets are passed to it as information, never as instructions.</li>
          <li>Time, turn and spending limits below; Stop at any time; every request and your answer is in Status &amp; audit.</li>
        </ul>
      </div>
      <Row label="Sites it may reach" hint="One per line (subdomains included), e.g. github.com, registry.npmjs.org. Everything else is blocked, for commands and web fetches alike.">
        <textarea
          aria-label="Allowed sites"
          rows={5}
          value={cc.allowedDomains.join('\n')}
          placeholder={'github.com\nregistry.npmjs.org'}
          onChange={(e) => set({ allowedDomains: e.target.value.split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean) })}
        />
      </Row>
      <Row label="Limits" hint="Each time it runs (a reply carries on with fresh limits).">
        <div className="inline">
          <input className="num" type="number" min={1} max={480} aria-label="Minutes limit" value={cc.maxMinutes} onChange={(e) => set({ maxMinutes: Math.max(1, Math.floor(Number(e.target.value)) || 1) })} /> <span className="small muted">minutes</span>
          <input className="num" type="number" min={1} max={500} aria-label="Turns limit" value={cc.maxTurns} onChange={(e) => set({ maxTurns: Math.max(1, Math.floor(Number(e.target.value)) || 1) })} /> <span className="small muted">turns</span>
          <input className="num" type="number" min={0.1} step={0.5} aria-label="Spending limit" value={cc.maxBudgetUsd} onChange={(e) => set({ maxBudgetUsd: Math.max(0.1, Number(e.target.value) || 0.1) })} /> <span className="small muted">$ (estimated)</span>
        </div>
      </Row>
    </section>
  );
}

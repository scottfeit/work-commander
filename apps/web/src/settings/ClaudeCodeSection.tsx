import { useEffect, useState } from 'react';
import type { Settings } from '@wc/shared';
import { get } from '../api';
import { Row, Toggle } from './parts';

/** Pick the skills Claude Code may use: none, all, or ticked ones (yours, from ~/.claude/skills). */
function SkillsPicker({ value, onChange }: { value: 'all' | string[]; onChange: (v: 'all' | string[]) => void }) {
  const [skills, setSkills] = useState<{ name: string; description: string }[] | null>(null);
  useEffect(() => {
    get<{ name: string; description: string }[]>('/api/claude-code/skills').then(setSkills, () => setSkills([]));
  }, []);
  // (ticking nothing under "only the ones I tick" saves the same as None, so the choice itself is kept here)
  const [mode, setMode] = useState<'none' | 'all' | 'some'>(value === 'all' ? 'all' : value.length ? 'some' : 'none');
  const picked = value === 'all' ? [] : value;
  return (
    <div className="skills-picker">
      <div className="inline" role="radiogroup" aria-label="Skills">
        {(['none', 'all', 'some'] as const).map((m) => (
          <label key={m} className="small">
            <input type="radio" name="cc-skills" checked={mode === m} onChange={() => (setMode(m), onChange(m === 'all' ? 'all' : m === 'none' ? [] : picked))} />{' '}
            {m === 'none' ? 'None' : m === 'all' ? "All (yours and the project's)" : 'Only the ones I tick'}
          </label>
        ))}
      </div>
      {mode === 'some' && (
        <div className="skills-list" aria-label="Your skills">
          {skills === null && <p className="muted small">Looking for your skills…</p>}
          {skills?.length === 0 && <p className="muted small">No skills found in ~/.claude/skills.</p>}
          {skills?.map((k) => (
            <label key={k.name} className="skill-row">
              <input
                type="checkbox"
                aria-label={`Skill ${k.name}`}
                checked={picked.includes(k.name)}
                onChange={(e) => onChange(e.target.checked ? [...picked, k.name] : picked.filter((x) => x !== k.name))}
              />
              <span>
                <b>{k.name}</b>
                {k.description && <span className="muted small"> — {k.description}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

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
          <li>
            {cc.autoMode
              ? 'Auto Mode is on: Claude Code’s reviewer approves its actions and asks you only when unsure; each action is listed in the chat.'
              : 'Reading inside its folder is free; every command, file change, reading outside the folder and web request waits for your Allow in the chat.'}
          </li>
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
      <Row
        label="Auto Mode"
        hint="Claude Code's own reviewer approves or refuses each action, and asks you only when it's unsure. Each action is still listed in the chat. What stays fixed either way: commands run in the sandbox (writes only in the project folder, network only to the allowed sites), and secret folders and WC's data can't be read or edited. With it on, its web-fetch and web-search tools are off (commands can still reach the allowed sites). Edits to files elsewhere in your home folder are then the reviewer's call, not yours."
      >
        <Toggle checked={!!cc.autoMode} onChange={(autoMode) => set({ autoMode })} label="Let Claude Code approve its own actions (Auto Mode)" />
      </Row>
      <Row label="CLAUDE.md" hint="Your ~/.claude/CLAUDE.md and the project's CLAUDE.md files (and what they import), as standing instructions. Only these text files are read: never settings.json, hooks or permission rules.">
        <Toggle checked={!!cc.loadClaudeMd} onChange={(loadClaudeMd) => set({ loadClaudeMd })} label="Give Claude Code my CLAUDE.md instructions" />
      </Row>
      <Row label="Skills" hint="Copies of the chosen skills are handed to Claude Code for each session. Anything in a skill that could pre-approve tools or run commands on its own (allowed-tools, hooks, inline commands) is taken out, so what a skill does still asks you first. 'All' also includes the project folder's .claude/skills.">
        <SkillsPicker value={cc.skills ?? []} onChange={(skills) => set({ skills })} />
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

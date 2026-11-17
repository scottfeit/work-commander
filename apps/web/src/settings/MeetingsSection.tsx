import type { Settings } from '@wc/shared';
import { Row, Select, Toggle } from './parts';

/** Settings → Meetings: calendar meetings linked to work streams, briefed before and followed up after. */
export function MeetingsSection({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const m = s.meetings ?? { enabled: true, briefMinutes: 30, followUp: 'offer' as const };
  const set = (patch: Partial<typeof m>) => setS({ ...s, meetings: { ...m, ...patch } });
  return (
    <section>
      <h2>Meetings</h2>
      <p className="muted small">
        Work Commander looks at your Google Calendar every few minutes. A meeting with other people that shares attendees or topic words with an open work stream is checked by the cheap "Linking meetings" model, and if it's about
        that stream it appears there as a tab. Meetings that match no stream cost nothing.
      </p>
      <Row label="Calendar">
        <Toggle checked={m.enabled} onChange={(enabled) => set({ enabled })} label="Link meetings to work streams" />
      </Row>
      <Row label="Brief before" hint="Claude posts a short brief in the stream's chat: where things stand, what's open, who owes what. 0 = no brief.">
        <input className="num" type="number" min={0} max={240} aria-label="Brief minutes before" value={m.briefMinutes} disabled={!m.enabled} onChange={(e) => set({ briefMinutes: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} />{' '}
        <span className="small muted">minutes before it starts</span>
      </Row>
      <Row label="Follow-up after" hint="When the meeting ends. Claude doesn't know what was said, so the draft leaves [brackets] for you to fill in.">
        <Select
          value={m.followUp}
          onChange={(followUp) => set({ followUp })}
          options={[
            { value: 'offer', label: 'Offer to draft a follow-up (one click)' },
            { value: 'draft', label: 'Draft a follow-up email right away' },
            { value: 'off', label: 'Nothing' },
          ]}
        />
      </Row>
    </section>
  );
}

import { describe, expect, it } from 'vitest';
import { automatedFromYou, withoutAutomated } from '../src/integrations/google.js';

const msg = (headers: Record<string, string>, payload: any = { mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64') } }) => ({ payload: { ...payload, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } }) as any;
const ics = (method: string) => ({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: '' } }, { mimeType: 'text/calendar', headers: [{ name: 'Content-Type', value: `text/calendar; method=${method}` }], body: { data: Buffer.from(`BEGIN:VCALENDAR\nMETHOD:${method}\nEND:VCALENDAR`).toString('base64') } }] });

describe('notices Google sends as you are never pulled in', () => {
  it('RSVPs (by subject or calendar reply part)', () => {
    expect(automatedFromYou(msg({ From: 'Alex <alex@x.com>', Subject: 'Accepted: Weekly sync @ Mon 10am' }), true)).toBe(true);
    expect(automatedFromYou(msg({ From: 'Alex <alex@x.com>', Subject: 'Declined: Offsite' }), true)).toBe(true);
    expect(automatedFromYou(msg({ From: 'Alex <alex@x.com>', Subject: 'Re: plans' }, ics('REPLY')), true)).toBe(true);
  });

  it('Drive / Docs mail sent on your behalf', () => {
    expect(automatedFromYou(msg({ From: '"Alex Rivera (via Google Drive)" <drive-shares-dm-noreply@google.com>', Subject: 'Share request for "Budget"' }), true)).toBe(true);
    expect(automatedFromYou(msg({ From: '"Alex (via Google Docs)" <comments-noreply@docs.google.com>', Subject: 'Budget' }), true)).toBe(true);
  });

  it('not: what you wrote yourself, an invitation someone sent you, or a doc someone shared with you', () => {
    expect(automatedFromYou(msg({ From: 'Alex <alex@x.com>', Subject: 'Accepting the offer' }), true)).toBe(false);
    expect(automatedFromYou(msg({ From: 'Priya <priya@x.com>', Subject: 'Invitation: Kickoff' }, ics('REQUEST')), false)).toBe(false);
    expect(automatedFromYou(msg({ From: '"Priya (via Google Drive)" <drive-shares-dm-noreply@google.com>', Subject: 'Document shared with you' }), false)).toBe(false);
  });

  it('a thread of nothing else is dropped; real messages in the same thread stay', () => {
    const item = (ms: any[]) => ({ source: 'gmail', kind: 'email_thread', externalId: 't', title: 't', eventId: ms[ms.length - 1].id, data: { messages: ms } }) as any;
    expect(withoutAutomated(item([{ id: 'a', automated: true }]))).toBeNull();
    const kept = withoutAutomated(item([{ id: 'inv' }, { id: 'rsvp', automated: true }]))!;
    expect(kept.data.messages!.map((m: any) => m.id)).toEqual(['inv']);
    expect(kept.eventId).toBe('inv');
    const plain = item([{ id: 'x' }]);
    expect(withoutAutomated(plain)).toBe(plain);
  });
});

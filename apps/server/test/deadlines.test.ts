import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { applyDeadline, findDeadline, mentionsDeadline } from '../src/core/deadlines.js';
import type { Settings } from '@wc/shared';

const msg = (id: string, text: string, pu = false) => ({ id, author: pu ? { name: 'Scott', email: 'scott@x.com' } : { name: 'Dana', email: 'dana@x.com' }, text, at: new Date().toISOString(), isFromPU: pu });
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('deadlines', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('the free prefilter: a deadline cue and a date-ish word', () => {
    expect(mentionsDeadline([msg('1', 'Can you send the numbers by Friday?')])).toBe(true);
    expect(mentionsDeadline([msg('1', "I'll have it to you EOD")])).toBe(true);
    expect(mentionsDeadline([msg('1', 'Due 11/21 please')])).toBe(true);
    expect(mentionsDeadline([msg('1', 'Thanks, see you Friday')])).toBe(false); // a date, no deadline
    expect(mentionsDeadline([msg('1', 'Go by the office')])).toBe(false); // "by", no date
  });

  it('no deadline words: no call at all', async () => {
    let calls = 0;
    expect(await findDeadline({ structured: async () => (calls++, { deadline: null }) } as any, 'Scott', [msg('1', 'thanks!')])).toBeNull();
    expect(calls).toBe(0);
  });

  it('"needed" becomes the due date; "promised" the delivery date; a date you set yourself is kept', async () => {
    const s = await repo.createStream({ title: 'Budget', summary: '' });
    await applyDeadline(repo, s.id, { date: future(3), time: null, kind: 'needed', quote: 'need these by Friday', who: 'Dana' }, { itemId: 'i', source: 'gmail' });
    let st = (await repo.getStream(s.id))!;
    expect(st.due).toMatchObject({ allDay: true, quote: 'need these by Friday', who: 'Dana', source: 'gmail', by: 'triage' });
    expect(new Date(st.due!.at).getHours()).toBe(17); // end of that day, local
    await applyDeadline(repo, s.id, { date: future(5), time: '10:00', kind: 'promised', quote: "I'll get it to you Monday", who: 'Lee' }, { itemId: 'i', source: 'slack' });
    st = (await repo.getStream(s.id))!;
    expect(st.promised).toMatchObject({ allDay: false, who: 'Lee' });
    expect(st.due?.quote).toBe('need these by Friday'); // both kept
    await repo.setDeadlines(s.id, { ...st.deadlines, due: { at: new Date(Date.now() + 9 * 86_400_000).toISOString(), by: 'you' } });
    await applyDeadline(repo, s.id, { date: future(1), time: null, kind: 'needed', quote: 'tomorrow pls', who: 'Dana' }, { itemId: 'i', source: 'gmail' });
    expect((await repo.getStream(s.id))!.due?.by).toBe('you');
    // a delivery date already past is ignored
    await applyDeadline(repo, s.id, { date: '2020-01-01', time: null, kind: 'promised', quote: 'x', who: 'Pat' }, { itemId: 'i', source: 'gmail' });
    expect((await repo.getStream(s.id))!.promised?.who).toBe('Lee');
  });

  describe('in triage', () => {
    let s: Settings;
    let kinds: string[];
    let deadline: unknown;
    let triage: TriagePipeline;
    beforeEach(() => {
      s = defaultSettings();
      s.pu = { ...s.pu, name: 'Scott', email: 'scott@x.com' };
      kinds = [];
      deadline = { date: future(2), time: null, kind: 'needed', quote: 'need it by Wednesday', who: 'Dana' };
      const backend = {
        structured: async (i: any) => {
          kinds.push(i.usage.kind);
          if (i.usage.kind === 'deadlines') return { deadline };
          return { relevant: true, reason: 'asks', stream: { action: 'new', streamId: null, title: 'Report', summary: '', labels: [] }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null }, deadline };
        },
      };
      triage = new TriagePipeline(repo, backend as any, { run: async () => undefined } as any, async () => s);
    });

    it("Claude's triage decision carries the deadline: no extra call", async () => {
      await triage.handle({ source: 'gmail', kind: 'email_thread', externalId: 't', title: 'Report', eventId: 'e1', data: { messages: [msg('m1', 'Can you send the report? I need it by Wednesday.')] } });
      expect(kinds).toEqual(['triage']);
      const st = (await repo.listStreams(false))[0];
      expect(st.due?.quote).toBe('need it by Wednesday');
    });

    it("the PU's own promise (no triage call) is read by the cheap model, only when it looks like a deadline", async () => {
      await triage.handle({ source: 'gmail', kind: 'email_thread', externalId: 't', title: 'Report', eventId: 'e1', data: { messages: [msg('m1', 'Can you send the report?')] } });
      const st = (await repo.listStreams(false))[0];
      kinds = [];
      await triage.handle({ source: 'gmail', kind: 'email_thread', externalId: 't', title: 'Report', eventId: 'e2', data: { messages: [msg('m1', 'Can you send the report?'), msg('m2', 'Sure', true)] } });
      expect(kinds).toEqual([]);
      deadline = { date: future(4), time: null, kind: 'needed', quote: "I'll have it to you by Friday", who: 'Scott' };
      await triage.handle({ source: 'gmail', kind: 'email_thread', externalId: 't', title: 'Report', eventId: 'e3', data: { messages: [msg('m1', 'Can you send the report?'), msg('m2', 'Sure', true), msg('m3', "I'll have it to you by Friday.", true)] } });
      expect(kinds).toEqual(['deadlines']);
      expect((await repo.getStream(st.id))!.due?.quote).toBe("I'll have it to you by Friday");
    });
  });
});

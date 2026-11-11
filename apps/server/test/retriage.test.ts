import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';

const no = { relevant: false, reason: 'Newsletter', stream: { action: 'none', streamId: null, title: null, summary: null, labels: null }, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
const yes = { ...no, relevant: true, reason: 'Chris asks Scott for advice', stream: { action: 'new', streamId: null, title: 'Advice for Chris', summary: 'Chris asks for advice', labels: [] } };

describe('Triage again', () => {
  let repo: Repo;
  let answer: any;
  let seen: string[];
  const triage = () =>
    new TriagePipeline(repo, { structured: async (i: any) => (seen.push(i.prompt), answer) } as any, { run: async () => undefined } as any, async () => defaultSettings());
  const item = (messages: any[]) => repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Development Idea', data: { messages }, eventId: 'e1' });
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    seen = [];
  });

  it('lists the skipped item, and turns it into a work stream when triage now says so', async () => {
    const { item: it } = await item([{ id: 'm1', author: { name: 'Chris' }, text: 'Is this a good idea?', at: '2026-11-11T05:25:54Z' }]);
    expect((await repo.listSkipped()).map((x) => x.id)).toEqual([it.id]);
    answer = yes;
    const r = await triage().retriage(it.id);
    expect(r.decision.relevant).toBe(true);
    expect((await repo.getStream(r.streamId!))!.title).toBe('Advice for Chris');
    expect(await repo.listSkipped()).toEqual([]);
    expect(seen[0]).toContain('<message from="Chris');
  });

  it('reports "still not relevant" and only creates a stream when forced', async () => {
    const { item: it } = await item([{ id: 'm1', author: { name: 'News' }, text: 'Weekly digest', at: '2026-11-11T05:00:00Z' }]);
    answer = no;
    expect((await triage().retriage(it.id)).streamId).toBeNull();
    const forced = await triage().retriage(it.id, true);
    expect(forced.streamId).toBeTruthy();
    expect(forced.decision.reason).toMatch(/Marked relevant by the PU/);
  });

  it('triages only what others sent after the PU last wrote', async () => {
    const { item: it } = await item([
      { id: 'm1', author: { name: 'Chris' }, text: 'old question', at: '2026-11-11T01:00:00Z' },
      { id: 'm2', author: { name: 'Scott' }, text: 'my answer', at: '2026-11-11T02:00:00Z', isFromPU: true },
      { id: 'm3', author: { name: 'Chris' }, text: 'new question', at: '2026-11-11T03:00:00Z' },
    ]);
    answer = no;
    await triage().retriage(it.id);
    const newPart = seen[0].split('NEW activity:')[1];
    expect(newPart).toContain('new question');
    expect(newPart).not.toContain('old question');
  });
});

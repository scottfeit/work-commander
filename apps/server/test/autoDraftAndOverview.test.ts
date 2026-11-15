import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { buildTools } from '../src/agent/tools.js';
import { refreshOverview } from '../src/core/overview.js';

let repo: Repo;
let streamId: string;
beforeEach(async () => {
  repo = new Repo((await openDatabase('sqlite::memory:')).db);
  streamId = (await repo.createStream({ title: 'Budget', summary: 'old' })).id;
});

describe('automatic drafts off', () => {
  const tools = async (offerOnly: boolean) => {
    const hub = { systemMode: async () => 'api', api: async () => ({}) } as any;
    const list = await buildTools({ streamId, runId: 'run1', offerOnly }, { repo, hub, grants: {} as any, executor: {} as any, settings: async () => defaultSettings() });
    return (n: string) => list.find((t) => t.name === n);
  };
  it('a turn the PU did not start can offer a draft but not make one', async () => {
    const tool = await tools(true);
    expect(await tool('propose_email_reply')!.handler({ item_id: 'x', body: 'hi' })).toMatch(/turned off automatic drafts.*offer_draft/);
    expect(await repo.listProposals({ streamId, status: ['pending'] })).toHaveLength(0);
    await tool('offer_draft')!.handler({ label: 'Draft a reply to Dana', instruction: 'Reply to Dana confirming Friday.' });
    await tool('offer_draft')!.handler({ label: 'Draft a reply to Dana', instruction: 'Reply to Dana confirming Friday.' }); // not posted twice
    const offers = (await repo.listChat(streamId)).filter((m) => m.role === 'suggestion');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ content: 'Draft a reply to Dana', meta: { suggestion: { instruction: 'Reply to Dana confirming Friday.', status: 'open' } } });
    // Closing a stream isn't a draft of something sent elsewhere: still allowed.
    expect(await tool('propose_close_stream')!.handler({ reason: 'done' })).not.toMatch(/turned off/);
  });
  it('otherwise there is no offer_draft', async () => {
    const tool = await tools(false);
    expect(tool('offer_draft')).toBeUndefined();
  });
});

describe('Refresh overview', () => {
  it('rewrites the overview from the items with the triage model, keeping the old one in history', async () => {
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g1', title: 'Q3 budget', streamId, data: { messages: [{ id: 'm1', author: { name: 'Dana' }, text: 'Can you approve the Q3 budget by Friday?', at: '2026-11-10T10:00:00Z' }] } });
    const calls: any[] = [];
    const structured = async (i: any) => (calls.push(i), { title: 'Ignored', summary: 'Dana needs the Q3 budget approved by Friday.' });
    const out = await refreshOverview({ repo, settings: async () => defaultSettings(), structured }, streamId);
    expect(out).toEqual({ summary: 'Dana needs the Q3 budget approved by Friday.', title: 'Budget' });
    expect(calls[0].usage).toEqual({ kind: 'overview', streamId });
    expect(calls[0].prompt).toContain('Can you approve the Q3 budget');
    const st = (await repo.getStream(streamId))!;
    expect(st).toMatchObject({ title: 'Budget', summary: 'Dana needs the Q3 budget approved by Friday.' });
    expect((await repo.listSummaries(streamId)).map((v) => v.summary)).toEqual(['Dana needs the Q3 budget approved by Friday.', 'old']);
  });
  it('names the stream when asked (a stream made by dropping an item on "+")', async () => {
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g2', title: 'Re: thing', streamId, data: { messages: [] } });
    const out = await refreshOverview({ repo, settings: async () => defaultSettings(), structured: async () => ({ title: 'Vendor contract renewal', summary: 's' }) }, streamId, { title: true });
    expect(out.title).toBe('Vendor contract renewal');
  });
  it('refuses a stream with nothing linked', async () => {
    await expect(refreshOverview({ repo, settings: async () => defaultSettings(), structured: async () => ({ title: null, summary: 'x' }) }, streamId)).rejects.toThrow(/no items/);
  });
});

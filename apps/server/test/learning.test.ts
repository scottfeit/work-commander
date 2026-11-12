import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { Executor } from '../src/core/executor.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { buildTools } from '../src/agent/tools.js';
import { playbookBlock } from '../src/agent/prompts.js';
import { startQuickReply } from '../src/core/quickReply.js';

let repo: Repo;
beforeEach(async () => {
  repo = new Repo((await openDatabase('sqlite::memory:')).db);
});

describe('a Quick Reply never wakes Claude', () => {
  const executor = () => {
    const settled: string[] = [];
    const ex = new Executor(repo, {} as any, {} as any, async () => defaultSettings(), {} as any, () => async () => '');
    ex.onRunSettled = async (runId) => void settled.push(runId);
    return { ex, settled };
  };
  const draft = (streamId: string, runId: string) => repo.createProposal({ streamId, runId, kind: 'slack_post', system: 'slack', title: 'd', rationale: '', payload: { channel: 'C1', text: '' }, editable: [], quick: runId.startsWith('quick-') });

  it("closing (rejecting) a Quick Reply doesn't tell the agent, while closing Claude's own draft does", async () => {
    const streamId = (await repo.createStream({ title: 's', summary: '' })).id;
    const { ex, settled } = executor();
    const mine = await draft(streamId, 'quick-abc');
    await ex.reject(mine.id);
    expect(settled).toEqual([]);
    const claudes = await draft(streamId, 'run-xyz');
    await ex.reject(claudes.id);
    expect(settled).toEqual(['run-xyz']);
  });
  it("sending a Quick Reply doesn't either", async () => {
    const streamId = (await repo.createStream({ title: 's', summary: '' })).id;
    const item = (await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0SYSENG:1.1', title: '#sys-eng', data: { messages: [] }, streamId })).item;
    const s = { ...defaultSettings(), slack: { ...defaultSettings().slack, mode: 'api' as const } };
    const { proposal } = await startQuickReply(repo, item, s as any);
    expect(proposal.runId).toMatch(/^quick-/);
    const { ex, settled } = executor();
    await ex.approve(proposal.id, { ...proposal.payload, text: 'hi' }).catch(() => undefined); // the demo hub is empty, so the send itself fails; the point is the agent isn't told
    expect(settled).toEqual([]);
  });
});

describe('searching past work', () => {
  const stream = async (title: string, summary: string, closed = true) => {
    const s = await repo.createStream({ title, summary });
    if (closed) await repo.updateStream(s.id, { status: 'closed' });
    return s.id;
  };
  it('finds similar streams by title, summary, items and what was said in chat, best match first', async () => {
    const a = await stream('Gainsight sync failure for Acme', 'Sync job failed; added the failure to the tracking sheet.');
    const b = await stream('Okta lockout for a contractor', 'Unlocked the account.');
    const c = await stream('Unrelated thing', 'Nothing to see');
    await repo.addChat({ streamId: c, role: 'assistant', content: 'I added the Gainsight failure row to the tracking sheet at https://docs.google.com/spreadsheets/d/X/edit' });
    const found = await repo.searchPastWork('Gainsight sync failure tracking sheet');
    expect(found.map((f) => f.id)).toEqual([a, c]);
    expect(found[0].matched).toBeGreaterThan(found[1].matched);
    expect(found[1].snippet).toMatch(/tracking sheet/);
    expect(found.map((f) => f.id)).not.toContain(b);
  });
  it('can exclude the current stream, keep to closed ones, and require two matching words', async () => {
    const closed = await stream('Gainsight failure', 'x');
    const open = await stream('Gainsight failure again', 'y', false);
    expect((await repo.searchPastWork('gainsight failure', { excludeStreamId: open })).map((f) => f.id)).toEqual([closed]);
    expect((await repo.searchPastWork('gainsight failure', { closedOnly: true })).map((f) => f.id)).toEqual([closed]);
    expect(await repo.searchPastWork('gainsight onboarding', { minMatched: 2 })).toEqual([]);
    expect(await repo.searchPastWork('the and for')).toEqual([]);
  });
});

describe('playbooks reach triage and Claude', () => {
  it('playbookBlock', () => {
    expect(playbookBlock('')).toBe('');
    expect(playbookBlock('- Log Gainsight failures in the sheet')).toContain('Log Gainsight failures in the sheet');
  });
  it('triage is given the playbooks and similar closed work', async () => {
    const old = await repo.createStream({ title: 'Gainsight sync failure for Acme', summary: 'Added to the tracking sheet row 12.' });
    await repo.updateStream(old.id, { status: 'closed' });
    let prompt = '';
    const no = { relevant: false, reason: 'x', stream: { action: 'none', streamId: null, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    const t = new TriagePipeline(repo, { structured: async (i: any) => ((prompt = i.prompt), i.systemPrompt && no) } as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), playbooks: '- Gainsight failures go in the tracking sheet' }));
    await t.handle({ source: 'gmail', kind: 'email_thread', externalId: 'g1', title: 'Gainsight sync failure for Globex', eventId: 'e1', data: { messages: [{ id: '1', author: { name: 'Bot', email: 'bot@x.com' }, text: 'The Gainsight sync failed again', at: new Date().toISOString() }] } });
    expect(prompt).toContain('Standing instructions from the PU');
    expect(prompt).toContain('Gainsight failures go in the tracking sheet');
    expect(prompt).toContain('Similar past work');
    expect(prompt).toContain('Gainsight sync failure for Acme');
  });
});

describe('Claude proposing a playbook', () => {
  const setup = async (playbooks = '') => {
    const streamId = (await repo.createStream({ title: 's', summary: '' })).id;
    const saved: any[] = [];
    let current = playbooks;
    const settings = async () => ({ ...defaultSettings(), playbooks: current });
    const ex = new Executor(repo, {} as any, {} as any, settings, {} as any, () => async () => '', undefined, async (p) => { saved.push(p); current = p.playbooks ?? current; });
    const hub = { systemMode: async () => 'api', api: async () => ({}) } as any;
    const tools = await buildTools({ streamId, runId: 'run1' }, { repo, hub, grants: {} as any, executor: ex, settings });
    return { streamId, saved, ex, tool: (n: string) => tools.find((t) => t.name === n)! };
  };
  it('creates a pending draft (never auto-approved), and approving saves the edited text', async () => {
    const { streamId, saved, ex, tool } = await setup('- existing rule');
    const out = await tool('propose_playbook').handler({ text: 'Gainsight failures go in the tracking sheet', rationale: 'Third time' });
    expect(out).toMatch(/awaiting the PU's approval/);
    const [p] = await repo.listProposals({ streamId, status: ['pending'] });
    expect(p.kind).toBe('playbook');
    expect(saved).toEqual([]); // nothing saved yet
    await ex.approve(p.id, { text: 'Gainsight failures go in the tracking sheet (columns: date, ticket, cause)' });
    expect(saved).toEqual([{ playbooks: '- existing rule\n- Gainsight failures go in the tracking sheet (columns: date, ticket, cause)' }]);
    expect((await repo.getProposal(p.id))!.status).toBe('executed');
  });
  it('does not propose one that is already there, and an empty instruction is refused', async () => {
    const { streamId, tool } = await setup('- Gainsight failures go in the tracking sheet');
    expect(await tool('propose_playbook').handler({ text: 'gainsight failures go in the tracking sheet', rationale: 'x' })).toMatch(/already one of the PU's playbooks/);
    expect(await tool('propose_playbook').handler({ text: '  ', rationale: 'x' })).toMatch(/^Error/);
    expect(await repo.listProposals({ streamId, status: ['pending'] })).toEqual([]);
  });
  it('search_past_streams works for Claude and never includes the current stream', async () => {
    const { streamId, tool } = await setup();
    const old = await repo.createStream({ title: 'Gainsight failure A', summary: 'logged in the sheet' });
    await repo.updateStream(streamId, { title: 'Gainsight failure B' });
    const out = JSON.parse(await tool('search_past_streams').handler({ query: 'gainsight failure' }));
    expect(out.map((o: any) => o.id)).toEqual([old.id]);
    expect(await tool('search_past_streams').handler({ query: 'zzzz nothing' })).toBe('No similar past work found.');
  });
});

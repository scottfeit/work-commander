import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { buildQuickReply, startQuickReply } from '../src/core/quickReply.js';

const settings = (over: any = {}) => {
  const s = defaultSettings();
  s.pu = { ...s.pu, name: 'Scott Feit', email: 'scott@x.com', aliases: [] };
  return Object.assign(s, over);
};
const it_ = (over: any): any => ({ id: 'i1', streamId: 's1', source: 'gmail', kind: 'email_thread', externalId: 'T1', title: 'Budget', data: {}, updatedAt: '', ...over });

describe('Quick Reply drafts', () => {
  it('email: reply all, without me, original Cc kept as Cc', () => {
    const d = buildQuickReply(
      it_({ data: { gmail: { threadId: 'T9' }, messages: [
        { id: '1', author: { email: 'Ann@x.com' }, to: ['scott@x.com', 'bob@x.com'], cc: ['Cy <cy@x.com>', 'scott@x.com'], text: 'hi', at: 'a' },
        { id: '2', author: { email: 'scott@x.com' }, isFromPU: true, text: 'mine', at: 'b' },
      ] } }),
      settings(),
    );
    expect(d.kind).toBe('email_reply');
    expect(d.payload).toMatchObject({ thread_id: 'T9', to: ['ann@x.com', 'bob@x.com'], cc: ['cy@x.com'], subject: 'Re: Budget', body: '' });
  });
  it('slack: the DM or the channel, per connection mode', () => {
    const dm = it_({ source: 'slack', externalId: 'D1ABCDEF:dm', title: 'DM with Alex Newman', data: {} });
    const mcp = buildQuickReply(dm, settings({ slack: { ...defaultSettings().slack, mode: 'mcp' } }));
    expect(mcp.kind).toBe('mcp_tool_call');
    expect(mcp.payload).toMatchObject({ tool: 'slack_send_message', args: { channel_id: 'D1ABCDEF', message: '' }, recipient: 'DM with Alex Newman' });
    const ch = buildQuickReply(it_({ source: 'slack', externalId: 'C0SYSENG:1.1', title: '#sys-eng', data: {} }), settings({ slack: { ...defaultSettings().slack, mode: 'api' } }));
    expect(ch.kind).toBe('slack_post');
    expect(ch.payload).toMatchObject({ channel: 'C0SYSENG', recipient: '#sys-eng', text: '' });
  });
  it('jira/jsm: a public comment', () => {
    const d = buildQuickReply(it_({ source: 'jsm', externalId: 'IT-9', data: { ticket: { key: 'IT-9', summary: 's', status: 'Open', flavor: 'jsm', comments: [] } } }), settings());
    expect(d.kind).toBe('ticket_comment');
    expect(d.payload).toMatchObject({ key: 'IT-9', visibility: 'public', body: '' });
  });
  it('says so when the connection is MCP-only or the item has no reply', () => {
    expect(() => buildQuickReply(it_({}), settings({ google: { ...defaultSettings().google, mode: 'mcp' } }))).toThrow(/Gmail over MCP/);
    expect(() => buildQuickReply(it_({ source: 'drive' }), settings())).toThrow(/isn't available/);
  });
});

describe('startQuickReply', () => {
  let repo: Repo;
  let streamId: string;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    streamId = (await repo.createStream({ title: 't', summary: '' })).id;
  });
  const slackItem = async () => (await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0SYSENG:1.1', title: '#sys-eng', data: { messages: [] }, streamId })).item;

  it('creates a pending blank draft, and reuses your own open Quick Reply draft for the same destination', async () => {
    const item = await slackItem();
    const s = settings({ slack: { ...defaultSettings().slack, mode: 'api' } });
    const a = await startQuickReply(repo, item, s);
    expect(a.existing).toBe(false);
    expect(a.proposal.status).toBe('pending');
    const b = await startQuickReply(repo, item, s);
    expect(b.existing).toBe(true);
    expect(b.proposal.id).toBe(a.proposal.id);
    expect(await repo.listProposals({ streamId, status: ['pending'] })).toHaveLength(1);
  });
  it("sits next to Claude's draft for the same place: neither replaces the other", async () => {
    const item = await slackItem();
    const s = settings({ slack: { ...defaultSettings().slack, mode: 'api' } });
    const claude = await repo.createProposal({ streamId, runId: 'run1', kind: 'slack_post', system: 'slack', title: 'Slack: post in #sys-eng', rationale: '', payload: { recipient: '#sys-eng', channel: 'C0SYSENG', text: 'Claude text' }, editable: [] });
    const mine = (await startQuickReply(repo, item, s)).proposal;
    expect(mine.id).not.toBe(claude.id);
    expect((await repo.getProposal(claude.id))!.status).toBe('pending'); // not replaced by mine
    await repo.createProposal({ streamId, runId: 'run2', kind: 'slack_post', system: 'slack', title: 'Slack: post in #sys-eng', rationale: '', payload: { recipient: '#sys-eng', channel: 'C0SYSENG', text: 'Claude again' }, editable: [] });
    expect((await repo.getProposal(claude.id))!.status).toBe('withdrawn'); // Claude's own older draft is still replaced by Claude's newer one
    expect((await repo.getProposal(mine.id))!.status).toBe('pending'); // yours is never discarded
  });
  it("leaves Claude's own pending close suggestion alone", async () => {
    const item = await slackItem();
    const close = await repo.createProposal({ streamId, runId: 'r', kind: 'stream_close', system: 'internal', title: 'Close', rationale: '', payload: {}, editable: [] });
    await startQuickReply(repo, item, settings({ slack: { ...defaultSettings().slack, mode: 'api' } }));
    expect((await repo.getProposal(close.id))!.status).toBe('pending');
  });
  it('needs the item to be in a work stream', async () => {
    const loose = (await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0X:1.1', title: '#x', data: { messages: [] } })).item;
    await expect(startQuickReply(repo, loose, settings())).rejects.toThrow(/work stream/);
  });
});

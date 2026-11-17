import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { matchRule } from '../src/core/rules.js';
import type { Settings, TriageRule } from '@wc/shared';

const msg = (id: string, from: { name: string; email?: string }, text = 'hello') => ({ id, author: from, text, at: new Date().toISOString() });

describe('rules before triage', () => {
  let repo: Repo;
  let s: Settings;
  let triage: TriagePipeline;
  let calls: number;

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    s = defaultSettings();
    s.pu = { ...s.pu, name: 'Scott', email: 'scott@x.com' };
    calls = 0;
    const answer = { relevant: true, reason: 'asks', stream: { action: 'new', streamId: null, title: 'From Claude', summary: '', labels: [] }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    triage = new TriagePipeline(repo, { structured: async () => (calls++, answer) } as any, { run: async () => undefined } as any, async () => s);
  });

  const mail = (n: string, from: { name: string; email?: string }, title = 'Hello', text = 'hello') =>
    triage.handle({ source: 'gmail', kind: 'email_thread', externalId: n, title, eventId: `${n}-e`, data: { messages: [msg(`${n}-m`, from, text)] } });

  it('an Ignore rule skips the update without asking Claude', async () => {
    s.rules = [{ id: 'r1', source: 'gmail', from: '@news.example.com', action: 'ignore' }];
    await mail('a', { name: 'Weekly', email: 'digest@news.example.com' });
    expect(calls).toBe(0);
    expect((await repo.findItem('gmail', 'a'))!.streamId).toBeNull();
    expect((await repo.listStreams(false)).length).toBe(0);
    // something else still goes to Claude
    await mail('b', { name: 'Dana', email: 'dana@x.com' });
    expect(calls).toBe(1);
  });

  it('a "File into" rule puts the update in its work stream (reopening it) without asking Claude', async () => {
    const st = await repo.createStream({ title: 'Invoices', summary: '' });
    await repo.updateStream(st.id, { status: 'closed' }, 'you');
    s.rules = [{ id: 'r2', source: 'any', subject: 'invoice', action: 'stream', streamId: st.id }];
    await mail('c', { name: 'Billing', email: 'billing@vendor.com' }, 'Your INVOICE #42');
    expect(calls).toBe(0);
    expect((await repo.findItem('gmail', 'c'))!.streamId).toBe(st.id);
    expect((await repo.getStream(st.id))!).toMatchObject({ status: 'open', unread: true });
  });

  it('a rule pointing at a deleted stream falls through to triage', async () => {
    s.rules = [{ id: 'r3', source: 'any', subject: 'hello', action: 'stream', streamId: 'gone' }];
    await mail('d', { name: 'Dana', email: 'dana@x.com' });
    expect(calls).toBe(1);
  });

  it('matching: every filled-in condition must match; empty and disabled rules never match; first match wins', () => {
    const item = { source: 'jsm' as const, title: 'VPN down' };
    const fresh = [msg('1', { name: 'Lee Park', email: 'lee@x.com' }, 'the vpn is DOWN again')];
    const rules: TriageRule[] = [
      { id: 'empty', source: 'any', action: 'ignore' },
      { id: 'off', source: 'any', subject: 'vpn', action: 'ignore', enabled: false },
      { id: 'slack', source: 'slack', subject: 'vpn', action: 'ignore' },
      { id: 'both', source: 'jira', from: 'lee', text: 'nope', action: 'ignore' },
      { id: 'hit', source: 'jira', from: 'Lee P', text: 'down again', action: 'ignore' },
      { id: 'later', source: 'any', subject: 'vpn', action: 'ignore' },
    ];
    expect(matchRule(rules, item, fresh)?.id).toBe('hit');
  });
});

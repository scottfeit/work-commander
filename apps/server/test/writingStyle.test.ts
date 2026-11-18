import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { collectSamples, copyHabits, learnStyle, styleBlock, type Sample } from '../src/core/writingStyle.js';

const me = 'scott@x.com';
const m = (id: string, from: string, to: string[], cc: string[] = [], text = 'hi', k = 0) => ({ id, author: { name: from, email: from }, to, cc, text, at: new Date(Date.UTC(2026, 10, 1, 9, k)).toISOString(), isFromPU: from === me });

describe('writing style', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('copying habits are counted from sent mail: reply-all share, and who is usually copied for whom', () => {
    const samples: Sample[] = [];
    for (let i = 0; i < 4; i++) {
      const prev = m(`p${i}`, 'dana@x.com', [me, 'lee@x.com']);
      samples.push({ channel: 'email', prev, msg: m(`r${i}`, me, ['dana@x.com'], i < 3 ? ['lee@x.com'] : []) });
    }
    samples.push({ channel: 'email', msg: m('n1', me, ['pat@x.com'], ['boss@x.com']) });
    const lines = copyHabits(samples, me);
    expect(lines).toContain('You usually reply-all on group threads (3 of 4).');
    expect(lines).toContain('Writing to dana@x.com, you usually copy lee@x.com (3 of 4).');
    expect(lines.join('\n')).not.toContain('pat@x.com'); // once is not a habit
  });

  it('collects only the PU\'s own messages, email and Slack, from what is stored', async () => {
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'T', data: { messages: [m('a', 'dana@x.com', [me], [], 'question?', 1), m('b', me, ['dana@x.com'], [], 'Sure, done.\nThanks,\nScott', 2)] } });
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C1:1', title: 'S', data: { messages: [{ ...m('c', me, []), text: 'on it 👍' }] } });
    const got = await collectSamples(repo, null);
    expect(got.map((x) => [x.channel, x.msg.id, x.prev?.id])).toEqual([
      ['email', 'b', 'a'],
      ['slack', 'c', undefined],
    ]);
  });

  it('learning makes one call (on its own model) and builds an editable guide; drafting gets it only when on', async () => {
    for (let i = 0; i < 4; i++) await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: `t${i}`, title: 'T', data: { messages: [m(`a${i}`, 'dana@x.com', [me, 'lee@x.com'], [], 'q', 1), m(`b${i}`, me, ['dana@x.com', 'lee@x.com'], [], 'Done.', 2)] } });
    const s = defaultSettings();
    s.pu = { ...s.pu, name: 'Scott', email: me };
    const kinds: string[] = [];
    const backend = { structured: async (i: any) => (kinds.push(i.usage.kind), { email: ['Short and direct.'], slack: [], signoffs: ['Thanks,\nScott'] }) };
    const r = await learnStyle({ repo, backend: backend as any, email: null }, s);
    expect(kinds).toEqual(['writingStyle']);
    expect(r.sample).toEqual({ email: 4, slack: 0, skippedClaude: 0 });
    expect(r.guide).toBe('Email\n- Short and direct.\n\nSign-offs (" / " = new line)\n- Thanks, / Scott\n\nCopying people\n- You usually reply-all on group threads (4 of 4).');
    expect(styleBlock({ enabled: true, guide: r.guide })).toContain('must sound like them');
    expect(styleBlock({ enabled: false, guide: r.guide })).toBe('');
    expect(styleBlock({ enabled: true, guide: '  ' })).toBe('');
  });

  it('too few messages: says so instead of guessing', async () => {
    await expect(learnStyle({ repo, backend: { structured: async () => ({}) } as any, email: null }, defaultSettings())).rejects.toThrow(/Not enough/);
  });
});

describe('writing style: what counts as your writing', () => {
  it('leaves out Claude drafts sent unchanged; keeps edited drafts, Quick Replies and messages written directly', async () => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const sent = async (kind: string, original: object, final: object, result: object) => {
      const p = await repo.createProposal({ streamId: null, runId: 'r', kind, system: kind.startsWith('slack') ? 'slack' : 'gmail', title: 't', rationale: '', payload: original, editable: [], dependsOn: [] } as any);
      await repo.db.updateTable('proposals').set({ status: 'executed', payload: JSON.stringify(final), result: JSON.stringify(result) }).where('id', '=', p.id).execute();
    };
    const claudeText = 'Thanks Dana, I have opened the access request and will follow up once Security approves it.';
    await sent('email_reply', { body: claudeText }, { body: claudeText }, { messageId: 'm-claude', threadId: 't' }); // unchanged
    await sent('email_reply', { body: 'Claude wording here.' }, { body: 'Done, ticket is OPS-12. Scott' }, { messageId: 'm-edited', threadId: 't' }); // edited
    await sent('email_reply', { body: '', quick: true }, { body: 'On it.', quick: true }, { messageId: 'm-quick', threadId: 't' }); // Quick Reply
    const slackText = 'Heads up: the deploy window moved to Thursday at 3pm, I will post here when it starts.';
    await sent('slack_post', { text: slackText }, { text: slackText }, {}); // unchanged, no id recorded: matched by text
    const mine = (id: string, text: string) => ({ ...m(id, me, ['dana@x.com'], [], text), isFromPU: true });
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'g1', title: 'T', data: { messages: [m('q', 'dana@x.com', [me], [], 'question?'), mine('m-claude', claudeText), mine('m-edited', 'Done, ticket is OPS-12. Scott'), mine('m-quick', 'On it.'), mine('m-direct', 'Written in Gmail myself.')] } });
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C1:1', title: 'S', data: { messages: [mine('1.1', slackText + '\n'), mine('1.2', 'ok will do')] } });
    const skipped = { n: 0 };
    const got = (await collectSamples(repo, null, 60, skipped)).map((x) => x.msg.id).sort();
    expect(got).toEqual(['1.2', 'm-direct', 'm-edited', 'm-quick']);
    expect(skipped.n).toBe(2);
  });
});

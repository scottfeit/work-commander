import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';

const msg = (id: string, text: string, name = 'Dana') => ({ id, author: { name, email: `${name.toLowerCase()}@x.com` }, text, at: new Date().toISOString() });

describe('search everything', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('finds streams (closed too), messages in items (in or out of a stream) and chat; every word must match', async () => {
    const open = await repo.createStream({ title: 'Acme invoice dispute', summary: 'Vendor billed twice for March' });
    const closed = await repo.createStream({ title: 'Old VPN outage', summary: 'Resolved by restarting the Acme gateway' });
    await repo.updateStream(closed.id, { status: 'closed' }, 'you');
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Re: billing', streamId: open.id, data: { messages: [msg('m1', 'The Acme credit note is attached.'), msg('m2', 'Thanks!', 'Scott')] } });
    await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C1:1', title: 'random', data: { messages: [msg('m3', 'acme lunch on friday?', 'Pat')] } });
    await repo.addChat({ streamId: open.id, role: 'assistant', content: 'I drafted a reply asking Acme for the credit note.' });

    const hits = await repo.searchAll('acme');
    expect(hits.filter((h) => h.kind === 'stream').map((h) => [h.streamTitle, h.streamStatus])).toEqual(
      expect.arrayContaining([
        ['Acme invoice dispute', 'open'],
        ['Old VPN outage', 'closed'],
      ]),
    );
    const msgs = hits.filter((h) => h.kind === 'message');
    expect(msgs.map((h) => [h.itemTitle, h.streamTitle, h.who])).toEqual(
      expect.arrayContaining([
        ['Re: billing', 'Acme invoice dispute', 'Dana'],
        ['random', null, 'Pat'],
      ]),
    );
    expect(hits.find((h) => h.kind === 'chat')).toMatchObject({ streamId: open.id, who: 'Claude' });

    // all words; a "phrase" as written
    expect((await repo.searchAll('acme credit')).map((h) => h.kind).sort()).toEqual(['chat', 'message']);
    expect((await repo.searchAll('"note is attached"')).map((h) => h.itemTitle)).toEqual(['Re: billing']);
    expect(await repo.searchAll('"attached note"')).toEqual([]);
  });

  it("doesn't match markup or ids in the stored data, and % or _ are taken literally", async () => {
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 'zzthread', title: 'Hello', data: { messages: [{ ...msg('m1', 'plain words'), html: '<div class="signature">x</div>' }], gmail: { threadId: 'zzthread' } } });
    expect(await repo.searchAll('signature')).toEqual([]);
    expect(await repo.searchAll('zzthread')).toEqual([]);
    expect(await repo.searchAll('pl%n')).toEqual([]);
    expect((await repo.searchAll('plain')).length).toBe(1);
  });

  it('snippets centre on the match', async () => {
    const long = `${'filler words here. '.repeat(30)}The budget number is 42k. ${'more filler. '.repeat(30)}`;
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't9', title: 'Long', data: { messages: [msg('m9', long)] } });
    const [h] = await repo.searchAll('budget');
    expect(h.snippet.startsWith('…')).toBe(true);
    expect(h.snippet).toContain('The budget number is 42k.');
    expect(h.snippet.length).toBeLessThan(240);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';

describe('the pending flag on a work stream', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('is off by default, can be set and cleared, and closing the stream clears it', async () => {
    const id = (await repo.createStream({ title: 's', summary: '' })).id;
    expect((await repo.getStream(id))!.pending).toBe(false);
    await repo.updateStream(id, { pending: true });
    expect((await repo.getStream(id))!.pending).toBe(true);
    expect((await repo.getStream(id))!.status).toBe('open'); // still open
    await repo.updateStream(id, { pending: false });
    expect((await repo.getStream(id))!.pending).toBe(false);
    await repo.updateStream(id, { pending: true });
    await repo.updateStream(id, { status: 'closed' });
    expect((await repo.getStream(id))!.pending).toBe(false);
  });
  it('marking pending does not change the stream\'s place in the order', async () => {
    const id = (await repo.createStream({ title: 's', summary: '' })).id;
    const before = (await repo.getStream(id))!.lastActivityAt;
    await repo.updateStream(id, { pending: true });
    expect((await repo.getStream(id))!.lastActivityAt).toBe(before);
  });
  it('an existing database without the column is upgraded in place', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mig-')), 'old.sqlite');
    const first = await openDatabase(`sqlite:${file}`);
    const r1 = new Repo(first.db);
    const id = (await r1.createStream({ title: 'kept', summary: '' })).id;
    const { sql } = await import('kysely');
    await sql`ALTER TABLE streams DROP COLUMN pending`.execute(first.db); // what a database from before this feature looks like
    await first.db.destroy();
    const again = await openDatabase(`sqlite:${file}`);
    const s = (await new Repo(again.db).getStream(id))!;
    expect(s.title).toBe('kept');
    expect(s.pending).toBe(false);
    await again.db.destroy();
  });
});

describe('what takes a pending stream out of Pending', () => {
  const setup = async (silencing = { skipPolling: false, mentionsOverride: false }) => {
    const repo = new Repo((await openDatabase('sqlite::memory:')).db);
    const streamId = (await repo.createStream({ title: 'Stream', summary: '' })).id;
    const msg = (id: string, text: string, pu = false) => ({ id, author: { name: pu ? 'Me' : 'Other' }, text, at: `2026-11-11T00:00:${id.padStart(2, '0')}Z`, isFromPU: pu });
    const { item } = await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C1ABCDEF:1.1', title: 'Thread', data: { messages: [msg('1', 'first')] }, streamId });
    const decision = { relevant: true, reason: 'x', stream: { action: 'existing', streamId, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    const t = new TriagePipeline(repo, { structured: async () => decision } as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, name: 'Scott Feit', email: 's@x.com' }, silencing }));
    await repo.updateStream(streamId, { pending: true });
    const lastBefore = (await repo.getStream(streamId))!.lastActivityAt;
    const arrive = (messages: any[], eventId: string) => t.handle({ source: 'slack', kind: 'slack_thread', externalId: 'C1ABCDEF:1.1', title: 'Thread', eventId, data: { messages } });
    return { repo, streamId, item, msg, arrive, lastBefore };
  };

  it('a new message from someone else: back in Open, at the top', async () => {
    const { repo, streamId, msg, arrive, lastBefore } = await setup();
    await new Promise((r) => setTimeout(r, 5));
    await arrive([msg('1', 'first'), msg('2', 'they answered')], 'e1');
    const s = (await repo.getStream(streamId))!;
    expect(s.pending).toBe(false);
    expect(s.lastActivityAt > lastBefore).toBe(true);
  });
  it('your own message does not (you are still waiting)', async () => {
    const { repo, streamId, msg, arrive } = await setup();
    await arrive([msg('1', 'first'), msg('2', 'I followed up', true)], 'e1');
    expect((await repo.getStream(streamId))!.pending).toBe(true);
  });
  it('an update to a silenced work item does not, unless a direct reference breaks through', async () => {
    const quiet = await setup();
    await quiet.repo.setItemMuted(quiet.item.id, true);
    await quiet.arrive([quiet.msg('1', 'first'), quiet.msg('2', 'chatter')], 'e1');
    expect((await quiet.repo.getStream(quiet.streamId))!.pending).toBe(true);

    const loud = await setup({ skipPolling: false, mentionsOverride: true });
    await loud.repo.setItemMuted(loud.item.id, true);
    await loud.arrive([loud.msg('1', 'first'), loud.msg('2', 'hey Scott Feit, can you look?')], 'e2');
    expect((await loud.repo.getStream(loud.streamId))!.pending).toBe(false);
  });
});

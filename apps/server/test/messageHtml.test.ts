import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';

const email = (id: string, html?: string) => ({ id, author: { email: 'a@b.c' }, text: `plain ${id}`, html, at: new Date().toISOString() });

describe('email HTML storage', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
  });

  it('keeps the HTML out of the item and serves it by message id', async () => {
    const { item } = await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Hi', data: { messages: [email('m1', '<b>one</b>'), email('m2')] } });
    expect(JSON.stringify(item.data)).not.toContain('<b>');
    expect((await repo.getItem(item.id))!.data.messages![0].html).toBeUndefined();
    expect(await repo.getMessageHtml(item.id)).toEqual({ m1: '<b>one</b>' });
  });
  it('adds HTML for later messages and backfills one that arrives again', async () => {
    const { item } = await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Hi', data: { messages: [email('m1')] } });
    await repo.upsertItem({ source: 'gmail', kind: 'email_thread', externalId: 't1', title: 'Hi', data: { messages: [email('m1', '<i>one</i>'), email('m2', '<u>two</u>')] } });
    expect(await repo.getMessageHtml(item.id)).toEqual({ m1: '<i>one</i>', m2: '<u>two</u>' });
  });
});

import { bodyOf } from '../src/integrations/google.js';
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('reading an email body from Gmail parts', () => {
  it('keeps both versions of a multipart/alternative message', () => {
    const r = bodyOf({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('plain version') } },
        { mimeType: 'text/html', body: { data: b64('<p>html version</p>') } },
      ],
    });
    expect(r.text).toBe('plain version');
    expect(r.html).toBe('<p>html version</p>');
  });
  it('finds HTML nested inside multipart/mixed, and builds text from HTML-only mail', () => {
    const r = bodyOf({
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'multipart/related', parts: [{ mimeType: 'text/html', body: { data: b64('<p>only html</p>') } }] }, { mimeType: 'application/pdf', body: {} }],
    });
    expect(r.html).toBe('<p>only html</p>');
    expect(r.text).toContain('only html');
  });
  it('has no HTML for a plain-text message', () => {
    expect(bodyOf({ mimeType: 'text/plain', body: { data: b64('hi') } })).toEqual({ text: 'hi', html: undefined });
  });
});

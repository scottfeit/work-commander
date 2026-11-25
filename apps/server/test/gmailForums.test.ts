import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { GmailIngestor } from '../src/integrations/google.js';

const run = async (labelIds: string[]) => {
  const repo = new Repo((await openDatabase('sqlite::memory:')).db);
  await repo.setSync('gmail.historyId', '100');
  const got: string[] = [];
  const g: any = {
    gmail: { users: { history: { list: async () => ({ data: { historyId: '120', history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1', labelIds } }] }] } }) } } },
    getThread: async (id: string) => ({ source: 'gmail', kind: 'email_thread', externalId: id, title: 'The Atlassian Admin Security Guide', eventId: id, data: { messages: [{ id: 'm1', author: { email: 'jiraadmin@x.com' }, text: 'hi', at: new Date().toISOString() }] } }),
  };
  const ing = new GmailIngestor(g, { oauth: { gmailQuery: 'in:inbox -category:promotions -category:social' }, ingestion: 'polling', pollSeconds: 30 } as any, repo, async (i) => void got.push(i.externalId), () => undefined);
  await ing.pollOnce();
  return got;
};

describe('which mail the Gmail poll hands on', () => {
  it('mail sent to a group address (Gmail files it under Forums) is read', async () => {
    expect(await run(['INBOX', 'UNREAD', 'CATEGORY_FORUMS'])).toEqual(['t1']);
  });
  it('promotions, social, spam and trash are still left out; so is mail outside the inbox', async () => {
    for (const l of ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM', 'TRASH']) expect(await run(['INBOX', l])).toEqual([]);
    expect(await run(['CATEGORY_UPDATES'])).toEqual([]);
  });
});

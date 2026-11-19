import { describe, expect, it } from 'vitest';
import { AtlassianCloud, textToAdf } from '../src/integrations/atlassian.js';
import { slackMentions } from '../src/core/executor.js';

describe('@-mentions in drafts become real mentions when sent', () => {
  it('Jira: "@Name" becomes an ADF mention node', () => {
    const doc = textToAdf('Hi @Dana Lee, can you check?\nThanks', [{ text: '@Dana Lee', accountId: 'acc-1' }]);
    expect(doc.content[0].content).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'mention', attrs: { id: 'acc-1', text: '@Dana Lee' } },
      { type: 'text', text: ', can you check?' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Thanks' },
    ]);
    expect(textToAdf('plain').content[0].content).toEqual([{ type: 'text', text: 'plain' }]);
  });

  it('JSM uses [~accountid:…]; Jira sends ADF; someone Jira doesn\'t know stays as text', async () => {
    const sent: { url: string; body: any }[] = [];
    const fake = (async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      sent.push({ url, body });
      if (url.includes('/user/search')) return new Response(JSON.stringify(url.includes('dana') ? [{ accountId: 'acc-dana', emailAddress: 'dana@x.com' }] : []));
      return new Response(JSON.stringify({ id: '9' }));
    }) as any;
    const at = new AtlassianCloud('https://acme.atlassian.net', 'me@x.com', 't', fake);
    await at.comment({ key: 'OPS-1', body: 'Hi @Dana Lee and @Pat Q', public: true, flavor: 'jsm', mentions: [{ name: 'Dana Lee', email: 'dana@x.com' }, { name: 'Pat Q', email: 'pat@x.com' }] });
    expect(sent.find((s) => s.url.endsWith('/request/OPS-1/comment'))!.body.body).toBe('Hi [~accountid:acc-dana] and @Pat Q');
    await at.comment({ key: 'OPS-2', body: 'Hi @Dana Lee', public: true, flavor: 'jira', mentions: [{ name: 'Dana Lee', email: 'dana@x.com' }] });
    const adf = sent.find((s) => s.url.endsWith('/issue/OPS-2/comment'))!.body.body;
    expect(adf.content[0].content[1]).toEqual({ type: 'mention', attrs: { id: 'acc-dana', text: '@Dana Lee' } });
  });

  it('Slack: "@Name" becomes <@U…> from the known id, or a lookup by email', async () => {
    const chat = { lookupUserByEmail: async (e: string) => (e === 'lee@x.com' ? { id: 'ULEE' } : null) };
    expect(await slackMentions(chat, 'cc @Dana Lee and @Lee Wong and @Nobody', [{ name: 'Dana Lee', slackUserId: 'UDANA' }, { name: 'Lee Wong', email: 'lee@x.com' }, { name: 'Nobody', email: 'no@x.com' }])).toBe('cc <@UDANA> and <@ULEE> and @Nobody');
    expect(await slackMentions(chat, 'no mentions', undefined)).toBe('no mentions');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { addOfferedChat, findCandidateChats, mentionsAddedToChat, offerAddedChat, type HintDeps } from '../src/core/chatHint.js';
import { parseSlackSearch } from '../src/integrations/slackMcp.js';

const GROUP = 'C0CJ63830BW';
const PEOPLE = 'Scott Feit (ID: UGFL1PCCC), Peter Hollywood (ID: U02DVEUHV25), Juozas Misius (ID: U02QXHF4URM)';
const hit = (channel: string, label: string, parts: string, ts: string, from = 'U02DVEUHV25') =>
  `### Result 1 of 9\nChannel: ${label} (ID: ${channel})\nParticipants: ${parts}\nFrom: Someone <s@x.com> (ID: ${from}) \nTime: 2026-11-16 08:19:27 PST\nMessage_ts: ${ts}\nPermalink: [link](https://x.slack.com/archives/${channel}/p${ts.replace('.', '')})\nText: \nhello\n\n---\n`;
const search = (...hits: string[]) => JSON.stringify({ results: `# Search Results\n\n## Messages\n${hits.join('\n')}` });
const read = (...msgs: [string, string, string][]) =>
  JSON.stringify({ messages: `=== CHANNEL ===\nChannel: Group DM (${GROUP})\n` + msgs.map(([ts, who, text]) => `=== Message from ${who} <${who.toLowerCase().replace(' ', '.')}@x.com> (U${who.length}) at 2026-11-16 08:00:00 PST ===\nMessage TS: ${ts}\n${text}`).join('\n') });

describe('"I added you to the chat" hint', () => {
  it('is recognised in the ways people say it', () => {
    for (const t of ['I have added you to the chat about this', "I've added you to the Okta channel", 'just invited you to a group chat', 'looped you into the conversation']) expect(mentionsAddedToChat(t), t).toBe(true);
    for (const t of ['I added the ticket to the board', 'Please add you to the list', 'He added a comment to the chat']) expect(mentionsAddedToChat(t), t).toBe(false);
  });

  it('the search parser reads a group DM’s participants', () => {
    const [h] = parseSlackSearch(search(hit(GROUP, 'Group DM', PEOPLE, '1794845967.032669'))).hits;
    expect(h.participants!.map((p) => p.name)).toEqual(['Scott Feit', 'Peter Hollywood', 'Juozas Misius']);
  });

  describe('finding and offering the chat', () => {
    let repo: Repo;
    let streamId: string;
    let calls: { tool: string; args: any }[];
    let deps: HintDeps;
    const mk = (structured?: HintDeps['structured'], searchText = search(hit(GROUP, 'Group DM', PEOPLE, '1794845967.032669'), hit('C0OTHER111', 'Group DM', 'Scott Feit (ID: UGFL1PCCC), Zed (ID: UZED)', '1794845000.000001', 'UZED'))) => {
      deps = {
        repo,
        settings: async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, email: 'me@x.com' } }),
        secret: async () => '',
        structured,
        call: async (tool, args) => {
          calls.push({ tool, args });
          if (tool === 'slack_search_public_and_private') return searchText;
          return read(['1794845000.000100', 'Peter Hollywood', 'Case Administrator needs to be on the main cell'], ['1794845100.000100', 'Barry McKenna', 'Lunch?'], ['1794845200.000100', 'Juozas Misius', 'Done, Portal Okta tile granted']);
        },
      };
    };
    const juozas = { id: '1794863128.057749', author: { name: 'Juozas Misius', slackUserId: 'U02QXHF4URM' }, text: 'I have added you to the chat about this', at: new Date().toISOString() };
    beforeEach(async () => {
      repo = new Repo((await openDatabase('sqlite::memory:')).db);
      streamId = (await repo.createStream({ title: 'Okta Case Administrator access request', summary: '9 users want Case Administrator' })).id;
      calls = [];
    });

    it('finds only group chats the sender is in, and skips ones Work Commander already holds', async () => {
      mk();
      await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'C0OTHER111:dm', title: 'x', data: { messages: [{ id: '1.1', author: { name: 'a' }, text: 't', at: new Date().toISOString() }] } });
      const found = await findCandidateChats(deps, { id: 'U02QXHF4URM' });
      expect(found.map((c) => c.channel)).toEqual([GROUP]);
      expect(found[0].label).toBe('Group DM with Scott Feit, Peter Hollywood, Juozas Misius');
      expect(calls[0].args.channel_types).toBe('mpim');
    });

    it('offers the chat the model picks, once, and does not offer when the model says none', async () => {
      mk(async (a) => ({ channel: GROUP, reason: 'about Case Administrator' }));
      const item = (await repo.upsertItem({ source: 'slack', kind: 'slack_thread', externalId: 'D1:dm', title: 'DM with Juozas', data: { messages: [juozas] }, streamId })).item;
      expect(await offerAddedChat(deps, { streamId, item, message: juozas })).toBe(true);
      const offer = (await repo.listChat(streamId)).find((m) => m.meta.chatOffer)!;
      expect(offer.meta.chatOffer).toMatchObject({ channel: GROUP, state: 'open' });
      expect(await offerAddedChat(deps, { streamId, item, message: juozas })).toBe(false); // same message: once
      mk(async () => ({ channel: null, reason: 'none fits' }));
      expect(await offerAddedChat(deps, { streamId, item, message: { ...juozas, id: 'other' } })).toBe(false);
      expect((await repo.listChat(streamId)).filter((m) => m.meta.chatOffer)).toHaveLength(1);
    });

    it('adding it brings in only the messages the model says belong to the stream', async () => {
      mk(async (a) => ({ related: ['1794845000.000100', '1794845200.000100'] }));
      const added = await addOfferedChat(deps, streamId, { channel: GROUP, label: 'Group DM with Peter' });
      expect(added).toBe(2);
      const it = (await repo.listItems(streamId)).find((i) => i.source === 'slack')!;
      expect(it.data.messages!.map((m) => m.id)).toEqual(['1794845000.000100', '1794845200.000100']);
    });

    it('a triage run on a message that says it asks for the chat; one that does not, does not', async () => {
      const asked: string[] = [];
      const backend = { structured: async () => ({ relevant: true, reason: 'r', stream: { action: 'existing', streamId, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } }) };
      const t = new TriagePipeline(repo, backend as any, { run: async () => undefined } as any, async () => ({ ...defaultSettings(), pu: { ...defaultSettings().pu, email: 'me@x.com' }, claude: { ...defaultSettings().claude, splitSlackByTopic: false } }));
      t.onAddedToChat = async (a) => void asked.push(a.message.text);
      const base = { source: 'slack' as const, kind: 'slack_thread' as const, externalId: 'D1:dm', title: 'DM with Juozas', data: { messages: [] as any[] } };
      await repo.upsertItem({ ...base, data: { messages: [{ id: '1.1', author: { name: 'Juozas' }, text: 'hello', at: new Date(Date.now() - 1000).toISOString() }] }, streamId });
      await t.handle({ ...base, eventId: 'e1', data: { messages: [{ id: '1.1', author: { name: 'Juozas' }, text: 'hello', at: new Date(Date.now() - 1000).toISOString() }, { id: '2.2', author: { name: 'Juozas' }, text: 'ok will do', at: new Date().toISOString() }] } });
      expect(asked).toEqual([]);
      await t.handle({ ...base, eventId: 'e2', data: { messages: [{ id: '1.1', author: { name: 'Juozas' }, text: 'hello', at: new Date(Date.now() - 1000).toISOString() }, { id: '2.2', author: { name: 'Juozas' }, text: 'ok will do', at: new Date().toISOString() }, { id: '3.3', author: { name: 'Juozas' }, text: 'I have added you to the chat about this', at: new Date().toISOString() }] } });
      expect(asked).toEqual(['I have added you to the chat about this']);
    });
  });
});

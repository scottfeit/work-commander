import type { ThreadMessage } from '@wc/shared';
import type { App, AppOverrides } from '../app.js';
import type { Repo } from '../core/repo.js';
import type { InboundItem, InboundSink } from '../integrations/types.js';
import type { OnePasswordClient } from '../onepassword/client.js';
import { ScriptedBackend } from './scripted.js';

type DemoFile = { filename: string; data: Buffer };
/** The demo has no real mailbox, so attachments show as a line under the message. */
const withFiles = (text: string, files?: DemoFile[]) => (files?.length ? `${text}\n\n[Attached: ${files.map((f) => `${f.filename} (${f.data.length} bytes)`).join(', ')}]`.trim() : text);

/**
 * DEMO_MODE: in-memory stand-ins for Gmail, Slack, JSM and 1Password plus a scripted agent, so the
 * whole dashboard flow can be clicked through (and tested) without credentials. Nothing leaves
 * the process. The scenario mirrors the example work stream in the README.
 */
export const PU = { name: 'Alex Rivera', email: 'alex.rivera@example.com', orgFunction: 'IT Systems Administration' };
export const PEOPLE = [
  { name: 'Alex Rivera', email: PU.email, title: 'Senior Systems Administrator', department: 'IT', managerEmail: 'jordan.lee@example.com' },
  { name: 'Jordan Lee', email: 'jordan.lee@example.com', title: 'Director of IT', department: 'IT' },
  { name: 'Priya Shah', email: 'priya.shah@example.com', title: 'Operations Manager', department: 'Operations', managerEmail: 'sam.ortiz@example.com' },
  { name: 'Lee Wong', email: 'lee.wong@example.com', title: 'Security Analyst', department: 'Security' },
  { name: 'Marco Diaz', email: 'marco.diaz@example.com', title: 'Contractor Program Lead', department: 'Operations', slackUserId: 'UMARCO' },
];

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const msg = (id: string, from: { name: string; email: string }, text: string, at: string, to: string[] = [], cc: string[] = [], subject?: string): ThreadMessage => ({
  id,
  author: from,
  to,
  cc,
  subject,
  text,
  at,
  isFromPU: from.email === PU.email,
});

export class DemoWorld {
  threads = new Map<string, InboundItem>();
  slackThreads = new Map<string, InboundItem>();
  tickets = new Map<string, InboundItem>();
  private seq = 100;
  sink: InboundSink = async () => undefined;
  constructor(private repo: Repo) {}

  // ----- email -----
  email = {
    getThread: async (id: string) => structuredClone(this.threads.get(id)!),
    search: async (q: string) =>
      [...this.threads.values()]
        .filter((t) => t.title.toLowerCase().includes(q.toLowerCase()) || q === 'in:inbox')
        .map((t) => ({ threadId: t.externalId, subject: t.title, from: t.data.messages![0].author.email!, snippet: t.data.messages![0].text.slice(0, 80), at: t.data.messages![0].at })),
    reply: async (i: { threadId: string; to: string[]; cc: string[]; subject: string; body: string; files?: DemoFile[] }) => {
      const t = this.threads.get(i.threadId)!;
      const id = `m${this.seq++}`;
      t.data.messages!.push(msg(id, PU, withFiles(i.body, i.files), new Date().toISOString(), i.to, i.cc, `Re: ${t.title}`));
      return { messageId: id, threadId: i.threadId };
    },
    send: async (i: { to: string[]; cc: string[]; subject: string; body: string; files?: DemoFile[] }) => {
      const tid = `t${this.seq++}`;
      this.threads.set(tid, { source: 'gmail', kind: 'email_thread', externalId: tid, title: i.subject, data: { messages: [msg(`m${this.seq++}`, PU, withFiles(i.body, i.files), new Date().toISOString(), i.to, i.cc, i.subject)], gmail: { threadId: tid } }, eventId: tid });
      return { messageId: tid, threadId: tid };
    },
  };

  // ----- Slack -----
  chat = {
    selfUserId: async () => 'UALEX',
    getThread: async (channel: string, ts: string) => structuredClone(this.slackThreads.get(`${channel}:${ts}`)!),
    search: async () => [],
    lookupUserByEmail: async (email: string) => {
      const p = PEOPLE.find((x) => x.email === email);
      return p ? { id: p.slackUserId ?? `U${p.name.split(' ')[0].toUpperCase()}`, name: p.name } : null;
    },
    postMessage: async (i: { channel?: string; userEmail?: string; text: string; threadTs?: string; files?: DemoFile[] }) => {
      const person = PEOPLE.find((p) => p.email === i.userEmail);
      const channel = i.channel ?? `D${(person?.name ?? 'X').split(' ')[0].toUpperCase()}`;
      const ts = i.threadTs ?? `${Math.floor(Date.now() / 1000)}.000${this.seq++}`;
      const key = `${channel}:${ts}`;
      const existing = this.slackThreads.get(key);
      const m = msg(`${Date.now() / 1000}`, PU, withFiles(i.text, i.files), new Date().toISOString());
      m.author.slackUserId = 'UALEX';
      if (existing) existing.data.messages!.push(m);
      else
        this.slackThreads.set(key, {
          source: 'slack',
          kind: 'slack_thread',
          externalId: key,
          title: `DM with ${person?.name ?? channel}: ${i.text.slice(0, 60)}`,
          url: undefined,
          data: { messages: [m], slack: { channel, channelName: `DM with ${person?.name}`, threadTs: ts } },
          eventId: key,
        });
      if (person?.email === 'marco.diaz@example.com') this.later(Number(process.env.DEMO_REPLY_DELAY_MS ?? 4000), () => this.marcoReplies(key));
      return { channel, ts };
    },
  };

  // ----- JSM / Jira -----
  tickets_ = {
    myself: async () => ({ accountId: 'acc-alex', email: PU.email, displayName: PU.name }),
    getIssue: async (key: string) => structuredClone(this.tickets.get(key)!),
    search: async () => [...this.tickets.values()].map((t) => ({ key: t.externalId, summary: t.data.ticket!.summary, status: t.data.ticket!.status, updated: '' })),
    createJsmRequest: async (i: { summary: string; description: string; requesterEmail: string }) => this.newTicket('jsm', i.summary, i.description, i.requesterEmail),
    createJiraIssue: async (i: { summary: string; description: string; requesterEmail?: string }) => this.newTicket('jira', i.summary, i.description, i.requesterEmail ?? PU.email),
    attach: async (i: { key: string; files: DemoFile[] }) => {
      const t = this.tickets.get(i.key)!;
      t.data.ticket!.comments.push(msg(`c${this.seq++}`, PU, withFiles('', i.files), new Date().toISOString()));
      return { count: i.files.length };
    },
    comment: async (i: { key: string; body: string; public: boolean; files?: DemoFile[] }) => {
      const t = this.tickets.get(i.key)!;
      const id = `c${this.seq++}`;
      t.data.ticket!.comments.push(msg(id, PU, withFiles(`${i.public ? '' : '[internal] '}${i.body}`, i.files), new Date().toISOString()));
      return { id };
    },
    transition: async (i: { key: string; to: string }) => {
      this.tickets.get(i.key)!.data.ticket!.status = i.to;
      return { status: i.to };
    },
    assign: async (i: { key: string; assignee: string | null }) => {
      this.tickets.get(i.key)!.data.ticket!.assignee = i.assignee === 'me' ? PU.name : (i.assignee ?? undefined);
      return { assignee: i.assignee };
    },
    confluenceSearch: async () => [{ id: '42', title: 'Acme admin console: contractor access policy', url: 'https://wiki.example.com/42', excerpt: 'Contractors receive read-only role "auditor"; group must be approved by Security.' }],
    confluenceRead: async () => ({ title: 'Acme admin console: contractor access policy', url: 'https://wiki.example.com/42', text: 'Contractors receive the read-only "auditor" role via a named group. Security must approve the group.' }),
    listServiceDesks: async () => [{ id: '1', projectKey: 'OPS', name: 'IT Operations' }],
    listRequestTypes: async () => [{ id: '10', name: 'Access request' }],
  };

  private newTicket(flavor: 'jsm' | 'jira', summary: string, description: string, requester: string) {
    const key = `OPS-${this.seq++}`;
    this.tickets.set(key, {
      source: flavor,
      kind: 'ticket',
      externalId: key,
      title: `${key}: ${summary}`,
      url: `https://example.atlassian.net/browse/${key}`,
      data: { ticket: { key, summary, status: 'Open', assignee: PU.name, requester, reporter: requester, description, flavor, comments: [] } },
      eventId: key,
    });
    return { key, url: `https://example.atlassian.net/browse/${key}` };
  }

  private later(ms: number, fn: () => Promise<void> | void) {
    const t = setTimeout(() => void fn(), ms);
    t.unref?.();
  }

  private async marcoReplies(key: string) {
    const t = this.slackThreads.get(key)!;
    const m = msg(`${Date.now() / 1000}`, { name: 'Marco Diaz', email: 'marco.diaz@example.com' }, "It's the Northwind QA group — 6 people, read-only is fine. They start Monday.", new Date().toISOString());
    m.author.slackUserId = 'UMARCO';
    t.data.messages!.push(m);
    await this.sink({ ...structuredClone(t), eventId: `${key}:${m.id}` });
  }

  async seed() {
    if (await this.repo.getSync('demo.seeded')) return;
    await this.repo.setSync('demo.seeded', '1');
    const priya = { name: 'Priya Shah', email: 'priya.shah@example.com' };
    const lee = { name: 'Lee Wong', email: 'lee.wong@example.com' };
    this.threads.set('t1', {
      source: 'gmail',
      kind: 'email_thread',
      externalId: 't1',
      title: 'Contractor access to the Acme admin console',
      url: undefined,
      data: {
        gmail: { threadId: 't1' },
        messages: [
          msg('m1', priya, "Hi Alex,\n\nThe Northwind contractors start next week and need to see order status in the Acme admin console. Can we get them access?\n\nThanks,\nPriya", iso(3600_000), [PU.email], ['lee.wong@example.com', 'marco.diaz@example.com'], 'Contractor access to the Acme admin console'),
          msg('m2', lee, "Alex — before Security signs off, can you confirm what access level they'd get and open a request so we have a record?\n\nLee", iso(600_000), [PU.email], ['priya.shah@example.com', 'marco.diaz@example.com'], 'Re: Contractor access to the Acme admin console'),
        ],
      },
      eventId: 'm2',
    });
    this.threads.set('t2', {
      source: 'gmail',
      kind: 'email_thread',
      externalId: 't2',
      title: 'This week in SaaS: 10 tools you need',
      data: {
        gmail: { threadId: 't2' },
        messages: [
          {
            ...msg('n1', { name: 'SaaS Weekly', email: 'news@saasweekly.example' }, 'Our top picks this week…', iso(120_000), [PU.email]),
            html: '<html><body><h1 style="color:#c00">Our top picks this week</h1><p>Read <a href="https://example.com/picks">the full list</a>.</p><img alt="pixel" src="https://tracker.example/p.gif"><script>document.title="pwned"</script></body></html>',
          },
        ],
      },
      eventId: 'n1',
    });
    this.later(Number(process.env.DEMO_SEED_DELAY_MS ?? 1500), async () => {
      await this.sink(structuredClone(this.threads.get('t2')!));
      await this.sink(structuredClone(this.threads.get('t1')!));
    });
  }
}

export const demoOnePassword = (): OnePasswordClient => ({
  listItems: async () => [{ id: 'op1', title: 'Acme Admin Console API', vault: 'Agent Access', urls: ['https://admin.acme.example'], category: 'ApiCredentials' }],
  getItem: async () => ({ title: 'Acme Admin Console API', urls: ['https://admin.acme.example'], credential: 'demo-secret-token', fields: { credential: 'demo-secret-token' } }),
  read: async () => 'demo-secret-token',
  upsertSecret: async (_v, title) => `op://demo/${title}/password`,
});

const demoFetch: typeof fetch = async (input) => {
  const url = String(input);
  const body = url.includes('/groups')
    ? { group: 'northwind-qa', members: 6, roles: [], available_roles: ['auditor (read-only)', 'operator', 'admin'] }
    : { ok: true };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

let world: DemoWorld | null = null;

export function demoOverrides(): AppOverrides {
  return {
    world: (repo) => {
      world = new DemoWorld(repo);
      const w = world;
      return {
        apis: { email: w.email, chat: w.chat as any, tickets: w.tickets_ as any, docs: { search: async () => [], read: async () => ({ title: '', text: '', url: '' }) }, calendar: { list: async () => [] } },
        ingestors: (sink) => {
          w.sink = sink;
          return [{ start: () => w.seed(), stop: async () => undefined }];
        },
      };
    },
    backend: (app) => new ScriptedBackend(app.repo),
    onePassword: async () => demoOnePassword(),
    grantFetch: demoFetch,
  };
}

export async function seedDemo(app: App) {
  const s = await app.settings.get();
  if (!s.setupComplete) {
    await app.settings.update({
      pu: { ...s.pu, ...PU, aliases: ['Alex', 'arivera'], relevanceNotes: 'I own access requests and integrations for internal tools. Newsletters are noise.' },
      onepassword: { ...s.onepassword, enabled: true, accessVault: 'Agent Access', secretsVault: 'Work Commander' },
      atlassian: { ...s.atlassian, defaultTicketTarget: { flavor: 'jsm', projectKey: 'OPS', typeId: '10', serviceDeskId: '1' } },
      setupComplete: true,
    });
    await app.repo.replacePeople('manual', PEOPLE);
  }
}

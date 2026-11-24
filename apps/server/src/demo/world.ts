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
const DEMO_STATUSES = ['Open', 'In Progress', 'Waiting for customer', 'Resolved'];
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
  /** Where each demo thread is "in Gmail" (unread and in the Inbox until changed). */
  gmailState = new Map<string, { unread: boolean; inbox: boolean; trash: boolean }>();
  email = {
    getThread: async (id: string) => {
      const t = structuredClone(this.threads.get(id)!);
      if (t.data.gmail) t.data.gmail.state = await this.email.threadState(id);
      return t;
    },
    signature: async () => ({ html: '<div><b>Alex Rivera</b><br>IT Operations, Acme · <a href="https://acme.example">acme.example</a></div>', text: 'Alex Rivera\nIT Operations, Acme · acme.example' }),
    threadState: async (id: string) => ({ ...(this.gmailState.get(id) ?? { unread: true, inbox: true, trash: false }) }),
    /** Demo attachments: a small PNG for images, a line of text for anything else. */
    attachment: async (_messageId: string, a: { mimeType: string; name: string }) =>
      /^image\//.test(a.mimeType)
        ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHRwSACXQD/G6p0GcAAAAAElFTkSuQmCC', 'base64')
        : Buffer.from(`Demo attachment: ${a.name}\n`),
    modifyThread: async (id: string, action: 'read' | 'unread' | 'archive' | 'unarchive' | 'trash' | 'untrash', opts: { toInbox?: boolean } = {}) => {
      const s = await this.email.threadState(id);
      if (action === 'read' || action === 'unread') s.unread = action === 'unread';
      if (action === 'archive' || action === 'unarchive') s.inbox = action === 'unarchive';
      if (action === 'trash') s.trash = true;
      if (action === 'untrash') {
        s.trash = false;
        if (opts.toInbox) s.inbox = true;
      }
      this.gmailState.set(id, s);
    },
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
    /** Demo reactions are remembered here, as Slack would. */
    reactions: [] as { channel: string; ts: string; name: string; add: boolean }[],
    react: async (channel: string, ts: string, name: string, add: boolean) => void this.chat.reactions.push({ channel, ts, name, add }),
    /** Demo read markers: channels marked read in "Slack" (anything else counts as unread). */
    readMarks: new Map<string, boolean>(),
    readState: async (channel: string) => ({ unread: !this.chat.readMarks.get(channel), kind: (channel.startsWith('D') ? 'im' : channel.startsWith('G') ? 'mpim' : 'channel') as 'im' | 'mpim' | 'channel' }),
    markConversation: async (channel: string, read: boolean) => (this.chat.readMarks.set(channel, read), { unread: !read }),
    profile: async (id: string) => {
      const p = PEOPLE.find((x) => (x.slackUserId ?? `U${x.name.split(' ')[0].toUpperCase()}`) === id);
      return p ? { handle: `@${p.name.toLowerCase().replace(/\s+/g, '.')}`, email: p.email } : null;
    },
    customEmoji: async () => ({ partyparrot: 'https://emoji.slack-edge.com/T0/partyparrot/abc.gif' }),
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
    /** A small demo workflow: any status to any other; "Resolved" needs a Resolution. */
    transitionOptions: async (key: string) => {
      const cur = this.tickets.get(key)!.data.ticket!.status;
      const resolution = { key: 'resolution', name: 'Resolution', allowed: [{ id: '1', name: 'Done' }, { id: '2', name: "Won't Do" }] };
      return DEMO_STATUSES.filter((st) => st !== cur).map((st) => ({ id: `t-${st}`, name: st, to: st, fields: st === 'Resolved' ? [resolution] : [] }));
    },
    transition: async (i: { key: string; to: string; id?: string; fields?: Record<string, unknown> }) => {
      const to = i.id ? i.id.replace(/^t-/, '') : i.to;
      if (to === 'Resolved' && i.id && !i.fields?.resolution) throw new Error('Resolution is required');
      this.tickets.get(i.key)!.data.ticket!.status = to;
      return { status: to };
    },
    /** Demo account ids are the person's name. */
    assigneeOf: async (key: string) => this.tickets.get(key)!.data.ticket!.assignee ?? null,
    assign: async (i: { key: string; assignee: string | null }) => {
      this.tickets.get(i.key)!.data.ticket!.assignee = i.assignee === 'me' ? PU.name : i.assignee?.startsWith('accountId:') ? i.assignee.slice(10) : (i.assignee ?? undefined);
      return { assignee: i.assignee };
    },
    /** Demo issue links, remembered as Jira would. */
    links: [] as { keys: string[]; to: string; relation: string }[],
    linkIssues: async (i: { keys: string[]; to: string; relation: string }) => (this.tickets_.links.push(i), { type: 'Relates', linked: i.keys.map((k) => `${k} ${i.relation} ${i.to}`) }),
    /** Demo epics and sprints, remembered as Jira would. */
    epics: new Map<string, string | null>(),
    sprints: new Map<string, string>(),
    setEpic: async (i: { keys: string[]; epic: string }) => {
      const epic = /^none$/i.test(i.epic.trim()) ? null : i.epic.trim().toUpperCase();
      for (const k of i.keys) this.tickets_.epics.set(k, epic);
      return { epic };
    },
    setSprint: async (i: { keys: string[]; sprint: string }) => {
      const sprint = /^backlog$/i.test(i.sprint.trim()) ? 'Backlog' : /^(active|current)$/i.test(i.sprint.trim()) ? 'OPS Sprint 12' : i.sprint.trim();
      for (const k of i.keys) this.tickets_.sprints.set(k, sprint);
      return { sprint };
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
      data: {
        ticket: {
          key, summary, status: 'Open', assignee: PU.name, requester, reporter: requester, description, flavor, comments: [], created: new Date().toISOString(), updated: new Date().toISOString(),
          // a JSM request comes with its request form, as a real service desk's would
          ...(flavor === 'jsm' ? { forms: [{ id: 'form-1', name: 'Access request', submitted: true, answers: [{ label: 'What do you need?', answer: summary }, { label: 'Requested for', answer: requester }, { label: 'Needed by', answer: '' }] }] } : {}),
        },
      },
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
    // Claude Code inside WC, scripted: it asks to run one command, then reports (or carries on without it).
    claudeCodeQuery: ({ prompt, options }) =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'demo-cc-session' };
        yield { type: 'assistant', session_id: 'demo-cc-session', message: { content: [{ type: 'text', text: `Looking at the task: ${String(prompt).split('\n')[0].slice(0, 80)}` }] } };
        const ok = await options.canUseTool('Bash', { command: 'ls -la' }, { signal: options.abortController.signal });
        const read = await options.canUseTool('Read', { file_path: 'BRIEF.md' }, { signal: options.abortController.signal });
        const report = ok.behavior === 'allow' ? `Listed the folder (sandboxed: writes ${options.sandbox.filesystem.allowWrite[0] === options.cwd ? 'only here' : 'elsewhere?!'}). Read BRIEF.md: ${read.behavior}. Done.` : 'You declined the command, so I stopped there.';
        yield { type: 'assistant', session_id: 'demo-cc-session', message: { content: [{ type: 'text', text: report }] } };
        yield { type: 'result', subtype: 'success', session_id: 'demo-cc-session', result: report, modelUsage: { 'claude-opus-5-5': { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 5000, cacheCreationInputTokens: 0, costUSD: 0.0128 } } };
      })(),
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
      // The demo shows the whole flow, drafts included, without stopping to ask first.
      claude: { ...s.claude, autoDraft: true },
      setupComplete: true,
    });
    await app.repo.replacePeople('manual', PEOPLE);
  }
}

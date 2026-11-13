import type { z } from 'zod';
import type { Repo } from '../core/repo.js';
import type { AgentBackend, ToolDef, TurnInput, TurnOutput } from '../agent/backend.js';
import type { TriageDecision } from '../agent/triage.js';

/**
 * Deterministic stand-in for Claude used in DEMO_MODE and tests. It calls the same tools the real
 * agent would, so drafts, approvals, execution, placeholders and resumption all run for real.
 */
export class ScriptedBackend implements AgentBackend {
  constructor(private repo: Repo) {}

  async test() {
    return 'ok (demo mode: scripted agent, no Claude calls)';
  }

  async structured<T>(i: { prompt: string; schema: z.ZodType<T> }): Promise<T> {
    // Match on the incoming message only, not on the list of recently skipped items.
    // Splitting a conversation by topic: the demo keeps every message where it is.
    if (/Answer with one assignment per NEW message id/.test(i.prompt)) return { assignments: [] } as T;
    const p = i.prompt.replace(/Recently skipped messages[\s\S]*?\n\n/, '');
    const existing = p.match(/ALREADY attached to stream (\S+);/)?.[1] ?? null;
    let d: TriageDecision;
    if (/SaaS Weekly/.test(p)) {
      d = { relevant: false, reason: 'Newsletter', stream: { action: 'none', streamId: null, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    } else if (/Contractor access/i.test(p) && !existing) {
      d = {
        relevant: true,
        reason: 'Lee (Security) asks Alex directly to confirm the access level and open a request.',
        stream: { action: 'new', streamId: null, title: 'Northwind contractor access to Acme console', summary: 'Priya asked for Northwind contractors to get Acme admin console access; Security (Lee) wants the access level confirmed and a request opened.', labels: ['access-request', 'acme'] },
        relatedItemIds: null,
        updatedSummary: null,
        notify: { title: 'Needs you', body: 'Lee asked you to confirm access level and open a request for the Northwind contractors.' },
        next: { type: 'draft', instruction: 'Create an access-request ticket (requester Priya) and reply-all saying the ticket was created, with the ticket number.', offerLabel: null },
      };
    } else if (existing && /Northwind QA/.test(p)) {
      d = {
        relevant: true,
        reason: 'Marco answered the question needed for OPS ticket research.',
        stream: { action: 'existing', streamId: existing, title: null, summary: null, labels: null },
        relatedItemIds: null,
        updatedSummary: null,
        notify: { title: 'Marco replied', body: 'Northwind QA group, 6 people, read-only.' },
        next: { type: 'draft', instruction: "Use Marco's answer to continue researching the ticket.", offerLabel: null },
      };
    } else {
      d = { relevant: !!existing, reason: 'Follow-up activity', stream: { action: existing ? 'existing' : 'none', streamId: existing, title: null, summary: null, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } };
    }
    return i.schema.parse(d);
  }

  async turn(i: TurnInput): Promise<TurnOutput> {
    const call = async (name: string, args: any) => {
      const t = i.tools.find((x: ToolDef) => x.name === name);
      if (!t) throw new Error(`demo: tool ${name} missing`);
      i.onToolCall?.(name, args);
      return t.handler(args);
    };
    const idOf = (s: string) => s.match(/p_[A-Za-z0-9_-]{8}/)?.[0];
    const say = async (text: string) => {
      for (const chunk of text.match(/.{1,24}/gs) ?? []) {
        i.onText?.(chunk);
        await new Promise((r) => setTimeout(r, 15));
      }
      return text;
    };
    const p = i.prompt;
    const sys = i.systemPrompt;
    const streamId = sys.match(/working on stream \[(\S+)\]/)?.[1] ?? null;
    const items = streamId ? await this.repo.listItems(streamId) : [];
    const email = items.find((x) => x.source === 'gmail');
    const ticket = items.find((x) => x.kind === 'ticket');
    const slack = items.find((x) => x.source === 'slack');
    const key = ticket?.data.ticket?.key;
    let text: string;

    if (p.includes('HANDOFF-OFFER-TEST')) {
      await call('offer_handoff', { question: 'Priya wants this changed in a Google Sheet, which is work for Claude Code. Send an "I\'m looking into it" reply, or hand it off?', task: 'Set row 12 to Approved in the linked sheet. Touch nothing else.' });
      text = await say('I asked how you want to handle it.');
    } else if (p.includes('chose to send a short acknowledgement') && email) {
      await call('propose_email_reply', {
        thread_id: email.data.gmail!.threadId,
        to: ['priya.shah@example.com'],
        subject: 'Contractor access to the Acme admin console',
        body: "Hi Priya,\n\nI'm looking into it and will follow up shortly.\n\nThanks,\nAlex",
        rationale: 'Acknowledge the request.',
      });
      text = await say('Drafted a short "I\'m looking into it" reply.');
    } else if (p.includes('Prepare drafts') && /Marco's answer/.test(p) && key) {
      await call('request_credential_access', { item: 'Acme Admin Console API', reason: `Check the Northwind QA group and available roles in the Acme admin console for ${key}.`, auth_scheme: 'bearer' });
      text = await say(`Marco confirmed: Northwind QA, 6 people, read-only. To check the group in the Acme console I need access, so I've requested the "Acme Admin Console API" item from 1Password.`);
    } else if (p.includes('Prepare drafts') && email) {
      const r1 = await call('propose_ticket_create', {
        summary: 'Read-only Acme admin console access for Northwind contractors',
        description: 'Priya Shah requested Acme admin console access so the Northwind contractors can view order status. Security (Lee Wong) needs the access level confirmed before approval.',
        requester_email: 'priya.shah@example.com',
        rationale: 'Lee asked for a request on record.',
      });
      const pid = idOf(r1)!;
      await call('propose_email_reply', {
        thread_id: email.data.gmail!.threadId,
        to: ['lee.wong@example.com'],
        cc: ['priya.shah@example.com', 'marco.diaz@example.com'],
        subject: 'Contractor access to the Acme admin console',
        body: "Hi Lee,\n\nI've opened {{ticket.key}} to track this ({{ticket.url}}). I'll confirm the exact access level there once I've checked the contractor group. The plan is read-only.\n\nThanks,\nAlex",
        rationale: 'Let the thread know a request exists.',
        after: [pid],
      });
      text = await say('Lee asked you to open a request. I drafted an access-request ticket (requester: Priya, assigned to you) and a reply-all with the ticket number. Review both in the draft pane.');
    } else if (p.startsWith('[Dashboard event]')) {
      if (/rejected by the PU|\) failed/.test(p)) text = await say('Understood. I left those undone. Tell me how you want to handle it.');
      else if (/stream_close/.test(p)) text = await say('Work stream closed. Nice work.');
      else if (/ticket_comment|ticket_transition/.test(p)) {
        await call('propose_close_stream', { reason: `${key} resolved and the email thread was updated.` });
        text = await say(`${key} is resolved and the thread is updated. I've proposed closing this work stream.`);
      } else if (/credential_request/.test(p)) {
        const grant = p.match(/g_[A-Za-z0-9_-]{8}/)?.[0];
        const res = await call('http_request', { grant_id: grant, method: 'GET', url: 'https://admin.acme.example/api/groups/northwind-qa' });
        const policy = await call('confluence_search', { query: 'Acme contractor access' });
        void policy;
        await call('propose_ticket_comment', {
          key,
          visibility: 'public',
          body: 'Hi Priya, the Northwind QA group (6 people) now maps to the read-only "auditor" role in the Acme admin console, per the contractor access policy. They will be able to view order status but not change anything. Resolving this request.',
          rationale: 'Resolution for the requester.',
        });
        await call('propose_ticket_transition', { key, to_status: 'Resolved', resolution: 'Done', rationale: 'Work complete.' });
        await call('propose_email_reply', {
          thread_id: email!.data.gmail!.threadId,
          to: ['lee.wong@example.com', 'priya.shah@example.com'],
          cc: ['marco.diaz@example.com'],
          subject: 'Contractor access to the Acme admin console',
          body: `Hi all,\n\n${key} is resolved: the Northwind QA contractors (6) have read-only "auditor" access in the Acme admin console, in line with the contractor access policy.\n\nThanks,\nAlex`,
          rationale: 'Close the loop on the original thread.',
        });
        text = await say(`Done researching. ${res.split('\n')[0]} from the Acme API; the group exists with the read-only "auditor" role available. I drafted the ticket resolution, the status change, and a reply to the original email.`);
      } else if (/slack_post/.test(p)) text = await say('Message sent to Marco. I will pick up his reply automatically.');
      else if (/ticket_create/.test(p)) {
        await call('ask_primary_user', { question: `${key ?? 'The ticket'} is assigned to you and waiting. Want me to work on it now?`, options: ['Yes, work on it', 'Not now'] });
        text = await say(`Ticket ${key} created and the reply was sent.`);
      } else text = await say('Noted.');
    } else if (/yes|work on it|go ahead/i.test(p) && key && !slack) {
      await call('propose_slack_message', {
        recipient_email: 'marco.diaz@example.com',
        text: `Hi Marco, for ${key} (Acme console access): which contractor group are the Northwind folks in, and how many people? Read-only OK?`,
        rationale: 'Marco runs the contractor program and answers fastest on Slack.',
      });
      text = await say(`To scope ${key} I need the contractor group and headcount from Marco. Slack is quickest, so I drafted a DM for your review.`);
    } else {
      text = await say(
        streamId
          ? `(Demo mode, scripted agent.) This stream has ${items.length} item(s). In a real deployment Claude answers here with full context of the stream and all open streams.`
          : '(Demo mode, scripted agent.) Select a work stream on the left to see the example flow.',
      );
    }
    return { sessionId: `demo-${streamId ?? 'general'}`, text };
  }
}

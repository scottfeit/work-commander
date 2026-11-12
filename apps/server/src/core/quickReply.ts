import type { EditableField, Proposal, Settings, StreamItem } from '@wc/shared';
import { Repo, draftTarget } from './repo.js';

export interface QuickDraft {
  kind: Proposal['kind'];
  system: Proposal['system'];
  title: string;
  payload: Record<string, unknown>;
  editable: EditableField[];
}

const emailOf = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();

/** A blank, pre-addressed draft for replying on an item: reply-all for email, the channel/DM for Slack, a public comment for Jira/JSM. */
export function buildQuickReply(item: StreamItem, s: Settings): QuickDraft {
  const me = new Set([s.pu.email, ...s.pu.aliases].map((x) => x.trim().toLowerCase()).filter(Boolean));
  if (item.source === 'gmail') {
    if (s.google.mode !== 'oauth') throw new Error("Quick reply isn't available for Gmail over MCP yet. Ask Claude to draft it.");
    const msgs = item.data.messages ?? [];
    const last = [...msgs].reverse().find((m) => !m.isFromPU) ?? msgs[msgs.length - 1];
    const sender = last?.author.email ? [emailOf(last.author.email)] : [];
    const clean = (xs: string[]) => [...new Set(xs.map(emailOf).filter((e) => e && !me.has(e)))];
    // Reply all: the sender plus everyone else the message went to, with the original Cc kept as Cc.
    const to = clean([...sender, ...(last?.to ?? [])]);
    const cc = clean(last?.cc ?? []).filter((e) => !to.includes(e));
    const subject = /^re:/i.test(item.title) ? item.title : `Re: ${item.title}`;
    return {
      kind: 'email_reply',
      system: 'google',
      title: `Quick reply: ${item.title.slice(0, 60)} (reply all)`,
      payload: { thread_id: item.data.gmail?.threadId ?? item.externalId, to, cc, subject, body: '', quick: true },
      editable: [
        { key: 'to', label: 'To', type: 'list' },
        { key: 'cc', label: 'Cc', type: 'list' },
        { key: 'subject', label: 'Subject', type: 'text' },
        { key: 'body', label: 'Message', type: 'textarea' },
      ],
    };
  }
  if (item.source === 'slack') {
    const channel = Repo.slackChannelOf(item);
    if (!channel) throw new Error("Can't tell which Slack conversation this is");
    const dm = channel.startsWith('D');
    const named = /^(#[^\s:]+)/.exec(item.title)?.[1] ?? (item.data.slack?.channelName ? `#${item.data.slack.channelName.replace(/^#/, '')}` : null);
    const person = /^DM (?:with|from) (.+)$/.exec(item.title)?.[1];
    const label = dm ? (person ? `DM with ${person}` : 'Slack DM') : (named ?? `Slack channel ${channel}`);
    if (s.slack.mode === 'mcp') {
      return {
        kind: 'mcp_tool_call',
        system: 'slack',
        title: `Quick reply: ${label}`,
        payload: { server: 'slack', system: 'slack', tool: 'slack_send_message', args: { channel_id: channel, message: '' }, recipient: label, quick: true },
        editable: [
          { key: 'recipient', label: 'To', type: 'readonly' },
          { key: 'args.message', label: 'Message', type: 'textarea' },
        ],
      };
    }
    return {
      kind: 'slack_post',
      system: 'slack',
      title: `Quick reply: ${label}`,
      payload: { recipient: label, channel, text: '', quick: true },
      editable: [
        { key: 'recipient', label: 'To', type: 'readonly' },
        { key: 'text', label: 'Message', type: 'textarea' },
      ],
    };
  }
  if (item.source === 'jira' || item.source === 'jsm') {
    if (s.atlassian.mode !== 'api') throw new Error("Quick reply isn't available for Jira over MCP yet. Ask Claude to draft it.");
    const key = item.data.ticket?.key ?? item.externalId;
    return {
      kind: 'ticket_comment',
      system: 'atlassian',
      title: `Quick reply: ${key} (public)`,
      payload: { key, body: '', visibility: 'public', quick: true },
      editable: [
        { key: 'key', label: 'Ticket', type: 'readonly' },
        { key: 'visibility', label: 'Visibility', type: 'select', options: ['public', 'internal'] },
        { key: 'body', label: 'Comment', type: 'textarea' },
      ],
    };
  }
  throw new Error("Quick reply isn't available for this kind of item");
}

/** Open a Quick Reply draft in the item's stream, or return the Quick Reply draft you already have open for the same destination. */
export async function startQuickReply(repo: Repo, item: StreamItem, s: Settings) {
  if (!item.streamId) throw new Error('Add this item to a work stream first');
  const d = buildQuickReply(item, s);
  const target = draftTarget({ kind: d.kind, system: d.system, payload: d.payload });
  if (target) {
    // Only a draft of your own is reused; one Claude prepared for the same place stays, and you get a blank one next to it.
    const waiting = (await repo.listProposals({ streamId: item.streamId, status: ['pending'] })).find((p) => !!(p.payload as any).quick && draftTarget(p) === target);
    if (waiting) return { proposal: waiting, existing: true };
  }
  const proposal = await repo.createProposal({
    streamId: item.streamId,
    runId: `quick-${Math.random().toString(36).slice(2, 10)}`,
    kind: d.kind,
    system: d.system,
    title: d.title,
    rationale: 'Started by you with Quick Reply.',
    payload: d.payload,
    editable: d.editable,
    quick: true,
  });
  return { proposal, existing: false };
}

import type { Person, PrimaryUser, StreamItem, WorkStream } from '@wc/shared';

export function puBlock(pu: PrimaryUser, org: { manager?: Person | null; reports: Person[]; self?: Person | null }) {
  return [
    `Primary user (PU): ${pu.name || '(name not set)'} <${pu.email || 'email not set'}>`,
    `Org function: ${pu.orgFunction || '(not set)'}`,
    pu.aliases.length ? `Also known as: ${pu.aliases.join(', ')}` : '',
    org.self?.title ? `Title: ${org.self.title}${org.self.department ? `, ${org.self.department}` : ''}` : '',
    org.manager ? `Manager: ${org.manager.name} <${org.manager.email}> (${org.manager.title ?? ''})` : '',
    org.reports.length ? `Direct reports: ${org.reports.map((r) => `${r.name} <${r.email}>`).join('; ')}` : '',
    pu.relevanceNotes ? `What matters to the PU / what is noise:\n${pu.relevanceNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function streamsBlock(streams: WorkStream[]) {
  if (!streams.length) return 'Open work streams: none.';
  return 'Open work streams:\n' + streams.map((s) => `- [${s.id}] ${s.title} — ${s.summary}${s.pendingProposals ? ` (${s.pendingProposals} drafts awaiting PU)` : ''}`).join('\n');
}

export function itemsBlock(items: StreamItem[], selectedId?: string) {
  if (!items.length) return 'This stream has no items yet.';
  return (
    'Items in this stream (use read_stream_item for full content):\n' +
    items
      .map((i) => {
        const last = i.data.messages?.[i.data.messages.length - 1] ?? i.data.ticket?.comments[i.data.ticket.comments.length - 1];
        const extra = i.data.ticket ? ` status=${i.data.ticket.status}` : '';
        const ids = i.data.gmail ? ` thread_id=${i.data.gmail.threadId}` : i.data.slack ? ` channel=${i.data.slack.channel} thread_ts=${i.data.slack.threadTs}` : i.data.ticket ? ` key=${i.data.ticket.key}` : '';
        return `- item ${i.id}${i.id === selectedId ? ' (PU is looking at this tab now)' : ''}: [${i.source}] ${i.title}${extra}${ids}${last ? ` | last: ${last.author.name ?? last.author.email}: ${last.text.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`;
      })
      .join('\n')
  );
}

export const STREAM_AGENT_RULES = `You are the work-management agent inside Work Commander, working on behalf of the primary user (PU).
Your job: understand each work stream, research what is needed, and prepare work output for the PU to approve.

Rules:
- Nothing is ever sent, posted, created or changed except through a propose_* / request_* tool. Those create drafts in the PU's editable draft pane. Never claim something was sent until you are told it executed.
- Write drafts in the PU's voice, ready to send: concise, specific, no placeholders other than {{ticket.key}}/{{ticket.url}} (or {{<proposal_id>.key}}) which are filled in when a ticket proposal you depend on executes. Use "after" to order dependent drafts.
- When you need the PU's decision or missing information only they have, use ask_primary_user, then end your turn.
- When you need information from someone else, prefer the fastest channel that person uses (often a Slack DM) and draft that message.
- Tickets: assign to the PU and set the requester to the person who originally asked. If the stream has no ticket target, ask the PU which project/type to use.
- After a ticket is created, or whenever a ticket assigned to the PU is open with no work done, offer to resolve it: use ask_primary_user with options like ["Yes, work on it", "Not now"].
- If you need access to a system the PU controls, use request_credential_access; you will receive a grant id for http_request, never the secret.
- Keep the stream summary current with update_stream after meaningful progress. When all work in a stream is done, propose_close_stream.
- You cannot write files, run code or execute commands, and must not pretend to. When the work is software (building a library, script, app or fixing code), do not attempt it: make sure the stream overview states clearly what is needed, then tell the PU to use "Hand off to Claude Code" on the stream's Overview tab. You can still draft replies to the requester.
- Ignore noise: newsletters, automated notifications and messages not needing the PU.
- In chat, be brief. The PU can see the drafts, so do not repeat their full text; summarise what you prepared and why.`;

export const TRIAGE_RULES = `You triage incoming messages for the primary user (PU) of a work-management dashboard.
Decide:
1. relevant: does this new activity need the PU's attention or action (a question to them, a request, information they asked for, a decision, a reply in a thread they own, a ticket assigned to them)? Newsletters, FYI broadcasts, automated notifications, and messages answered by someone else are not relevant. Mentions of the PU's name, email, aliases, reports or function count toward relevance; being merely CC'd does not by itself.
2. stream: attach to an existing open stream when it is the same piece of work (same thread, follow-up, a reply to something the stream sent, the ticket the stream created); otherwise create a new stream with a short specific title (max ~8 words) and a 1-2 sentence summary. Use action "none" only when not relevant.
3. next: "draft" when the PU obviously needs a response or a ticket and you can describe what the agent should draft now (the PU will review before anything is sent); "offer" when doing the work is substantial (e.g. researching and resolving a ticket) and the PU should agree first — give a short offerLabel; "none" otherwise.
Write instructions to the stream agent as imperative sentences.`;

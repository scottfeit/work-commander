import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { demoOverrides, seedDemo } from '../src/demo/world.js';
import type { App } from '../src/app.js';
import type { Proposal } from '@wc/shared';

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function boot(): Promise<App> {
  const app = await createApp(
    { port: 0, host: '127.0.0.1', hosting: 'local', dataDir: `/tmp/wc-test-${Math.random()}`, databaseUrl: 'sqlite::memory:', publicUrl: 'http://localhost', webUrl: '', authMode: 'local', demoMode: true, webDist: '', version: 'test' },
    demoOverrides(),
  );
  await seedDemo(app);
  await app.hub.start(app.triage.sink);
  return app;
}

describe('example work stream, end to end (scripted agent, in-memory systems)', () => {
  it('runs email → ticket + reply → offer → Slack → 1Password → resolution → close', async () => {
    const app = await boot();
    const { repo, executor } = app;
    const pending = (sid: string) => repo.listProposals({ streamId: sid, status: ['pending'] });

    // Triage ignores the newsletter and opens one stream for the access request.
    const stream = await until(async () => (await repo.listStreams(false))[0]);
    expect(stream.title).toMatch(/Northwind/);
    let drafts = await until(async () => ((await pending(stream.id)).length === 2 ? pending(stream.id) : null));
    const ticket = drafts.find((d) => d.kind === 'ticket_create')!;
    const email = drafts.find((d) => d.kind === 'email_reply')!;
    expect(email.dependsOn).toEqual([ticket.id]);
    expect(ticket.payload.requester_email).toBe('priya.shah@example.com');

    // PU tweaks the email wording, then approves both (email first: it waits for the ticket).
    const edited = { ...email.payload, body: String(email.payload.body).replace('read-only.', 'read-only access only.') };
    await executor.approve(email.id, edited);
    expect((await repo.getProposal(email.id))!.status).toBe('approved');
    await executor.approve(ticket.id);
    const sent = await until(async () => {
      const p = await repo.getProposal(email.id);
      return p!.status === 'executed' ? p : null;
    });
    expect(sent.payload.body).toContain('OPS-100');
    expect(sent.payload.body).toContain('read-only access only.');
    const items = await repo.listItems(stream.id);
    const t = items.find((i) => i.kind === 'ticket')!.data.ticket!;
    expect(t).toMatchObject({ assignee: 'Alex Rivera', requester: 'priya.shah@example.com' });

    // The agent offers to work the ticket; PU agrees.
    const q = await until(async () => (await repo.listChat(stream.id)).find((m) => m.role === 'question'));
    await app.runner.run({ streamId: stream.id, prompt: 'Yes, work on it', origin: 'user' });
    const slack = await until(async () => (await pending(stream.id)).find((p) => p.kind === 'slack_post'));
    expect(q.meta.question?.options).toContain('Yes, work on it');
    await executor.approve(slack.id);

    // Marco replies on Slack → triage routes it to the same stream → access request via 1Password.
    const cred = await until(async () => (await pending(stream.id)).find((p) => p.kind === 'credential_request'));
    await executor.approve(cred.id);
    const grants = await app.grants.list(stream.id);
    expect(grants[0]).toMatchObject({ status: 'active', allowed_hosts: ['admin.acme.example'] });

    // Resolution drafts: ticket reply (PU edits), transition, email.
    drafts = await until(async () => {
      const p = await pending(stream.id);
      return p.length >= 3 ? p : null;
    });
    expect(drafts.map((d) => d.kind).sort()).toEqual(['email_reply', 'ticket_comment', 'ticket_transition']);
    for (const d of drafts) {
      const payload = d.kind === 'ticket_comment' ? { ...d.payload, body: `${d.payload.body} Shout if anything looks off.` } : undefined;
      await executor.approve(d.id, payload);
    }
    const close = await until(async () => (await pending(stream.id)).find((p) => p.kind === 'stream_close'));
    await executor.approve(close.id);

    const final = await until(async () => {
      const s = await repo.getStream(stream.id);
      return s?.status === 'closed' ? s : null;
    });
    expect(final.status).toBe('closed');
    const ticketItem = (await repo.listItems(stream.id)).find((i) => i.kind === 'ticket')!;
    expect(ticketItem.data.ticket!.status).toBe('Resolved');
    expect(ticketItem.data.ticket!.comments.at(-1)!.text).toContain('Shout if anything looks off.');
    expect((await repo.listStreams(false)).length).toBe(0); // closed streams hidden by default
    const all: Proposal[] = await repo.listProposals({ streamId: stream.id });
    expect(all.every((p) => ['executed'].includes(p.status))).toBe(true);
    await app.hub.stop();
  });

  it('a rejected dependency stops the dependent draft', async () => {
    const app = await boot();
    const stream = await until(async () => (await app.repo.listStreams(false))[0]);
    const drafts = await until(async () => {
      const p = await app.repo.listProposals({ streamId: stream.id, status: ['pending'] });
      return p.length === 2 ? p : null;
    });
    const ticket = drafts.find((d) => d.kind === 'ticket_create')!;
    const email = drafts.find((d) => d.kind === 'email_reply')!;
    await app.executor.approve(email.id);
    await app.executor.reject(ticket.id, 'Not yet');
    const e = await until(async () => {
      const p = await app.repo.getProposal(email.id);
      return p!.status === 'failed' ? p : null;
    });
    expect(e.error).toMatch(/depends on was rejected/);
    await app.hub.stop();
  });
});

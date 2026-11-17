import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { UsageLog } from '../src/core/usage.js';
import { StreamAgentRunner } from '../src/agent/runner.js';
import { handoffResultPrompt, reportHasDraft } from '../src/core/handoff.js';

const withDraft = `**Outcome:** Partly done.\n\n## Findings\n1. Okta shows the sandbox app assigned.\n\n## Draft reply for IT-75652 (for Scott to approve; not posted)\n\nHi Kathy,\n\nYou are set up.\n\n- BV IT\n\n## Open items\n- Scott: approve the draft.`;
const without = '**Outcome:** Done.\n\n## Findings\nAll good.\n\n## Open items\nNone.';

describe('a draft Claude Code wrote comes back as a draft', () => {
  it('is recognised by a heading that says "draft"', () => {
    expect(reportHasDraft(withDraft)).toBe(true);
    expect(reportHasDraft('### Draft comment\nx')).toBe(true);
    expect(reportHasDraft(without)).toBe(false);
    expect(reportHasDraft('We should draft something later.')).toBe(false); // body text, not a heading
  });

  it('tells Claude to file that draft as written, not to write or offer another', () => {
    const p = handoffResultPrompt('/f', withDraft);
    expect(p).toContain('already wrote');
    expect(p).toContain('as written');
    expect(p).toMatch(/do not offer a draft instead/);
    expect(p).toContain('Hi Kathy');
    const plain = handoffResultPrompt('/f', without);
    expect(plain).toContain('draft a reply reporting the result');
    expect(plain).not.toContain('already wrote');
  });

  describe('with automatic drafts off (the default)', () => {
    let repo: Repo;
    let runner: StreamAgentRunner;
    let streamId: string;
    beforeEach(async () => {
      const { db } = await openDatabase('sqlite::memory:');
      repo = new Repo(db);
      const s = defaultSettings();
      expect(s.claude.autoDraft).toBe(false);
      const usage = new UsageLog(db, { settings: async () => s, sync: { get: (k) => repo.getSync(k), set: (k, v) => repo.setSync(k, v) } });
      streamId = (await repo.createStream({ title: 'Kathy sandbox', summary: '' })).id;
      const backend = {
        async turn(i: any) {
          const reply = i.tools.find((t: any) => t.name === 'propose_ticket_comment');
          await reply.handler({ key: 'IT-75652', body: 'Hi Kathy', visibility: 'public', rationale: 'Claude Code drafted it' });
          return { text: 'done', sessionId: null };
        },
      } as any;
      const hub = { systemMode: async () => 'api', api: async () => ({}) } as any;
      runner = new StreamAgentRunner(repo, backend, hub, { onRunSettled: null } as any, {} as any, async () => s, { repo, hub, grants: {} as any, executor: {} as any, settings: async () => s } as any, usage);
    });

    it('an automatic turn cannot draft...', async () => {
      await runner.run({ streamId, prompt: '[result]', origin: 'system', purpose: 'handoff' });
      expect(await repo.listProposals({ streamId })).toHaveLength(0);
    });
    it('...unless it is filing a draft Claude Code already wrote', async () => {
      await runner.run({ streamId, prompt: '[result]', origin: 'system', purpose: 'handoff', allowDrafts: true });
      const drafts = await repo.listProposals({ streamId });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].status).toBe('pending');
    });
  });
});

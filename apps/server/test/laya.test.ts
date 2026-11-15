import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { TriagePipeline } from '../src/agent/triage.js';
import { LayaService } from '../src/laya/service.js';
import { bus } from '../src/core/bus.js';
import type { Settings } from '@wc/shared';

/** Stands in for the local helper: answers are whatever the test says. */
function fakeManager() {
  const m = {
    install: { state: 'installed' as const },
    running: true,
    serverMessage: undefined,
    fits: [] as any[],
    predicts: 0,
    /** (question id, state) -> answer */
    answer: (_q: string, _state: string): any => ({ noul: 0.1, route: 'auto' }),
    headsDir: (p: string, v: number) => `/tmp/heads/${p}/v${v}`,
    async call(route: string, body: any) {
      if (route === '/min_rows') return { rows: 4 };
      if (route === '/fit') {
        m.fits.push(body);
        return { report: { heads: { [Object.keys(body.questions)[0]]: { fitted: true, cv_accuracy: 0.9, used_by_auto: true } } } };
      }
      m.predicts++;
      const q = Object.keys(body.questions)[0];
      return { answers: { [q]: m.answer(q, body.state) } };
    },
    async ensure() {},
    async stop() {},
  };
  return m;
}

const decision = (relevant: boolean, extra: any = {}) => ({
  relevant,
  reason: relevant ? 'asks' : 'newsletter',
  stream: relevant ? { action: 'new', streamId: null, title: 'Budget review', summary: 'Dana asks for a review', labels: [] } : { action: 'none', streamId: null, title: null, summary: null, labels: null },
  relatedItemIds: null,
  updatedSummary: null,
  notify: null,
  next: { type: relevant ? 'offer' : 'none', instruction: 'look', offerLabel: null },
  ...extra,
});

describe('Laya for triage', () => {
  let repo: Repo;
  let s: Settings;
  let mgr: ReturnType<typeof fakeManager>;
  let laya: LayaService;
  let claudeCalls: any[];
  let claude: (i: any) => any;
  let n = 0;
  const pipeline = () =>
    new TriagePipeline(repo, { structured: async (i: any) => (claudeCalls.push(i), claude(i)) } as any, { run: async () => undefined } as any, async () => s, true, undefined, laya);
  const message = (text: string, from = 'news@x.com') => {
    n++;
    return { source: 'gmail' as const, kind: 'email_thread' as const, externalId: `t${n}`, title: `Subject ${n}`, eventId: `e${n}`, data: { messages: [{ id: `m${n}`, author: { name: 'Someone', email: from }, text, at: new Date().toISOString() }] } };
  };
  const part = async (p: string) => (await laya.status()).parts.find((x) => x.part === p)!;

  beforeEach(async () => {
    const { db } = await openDatabase('sqlite::memory:');
    repo = new Repo(db);
    s = defaultSettings();
    s.pu = { ...s.pu, name: 'Scott', email: 'scott@x.com' };
    s.triage = { engine: 'laya', agreeThreshold: 0.75, minMessages: 4 };
    mgr = fakeManager();
    laya = new LayaService(db, repo, mgr as any, async () => s, true);
    claudeCalls = [];
    claude = (i) => decision(/please/i.test(i.prompt));
  });

  it('does nothing while Claude is the triage engine', async () => {
    s.triage.engine = 'claude';
    await pipeline().handle(message('Weekly digest'));
    expect(claudeCalls).toHaveLength(1);
    expect((await part('relevance')).examples).toBe(0);
  });

  it("collects examples from Claude's decisions, then trains once there are enough", async () => {
    const t = pipeline();
    for (const text of ['Weekly digest', 'Please review the budget', 'Newsletter', 'Please approve this']) await t.handle(message(text));
    expect(claudeCalls).toHaveLength(4);
    const rel = await part('relevance');
    expect(rel.examples).toBe(4);
    await laya.trainWhenReady();
    expect(mgr.fits.map((f) => Object.keys(f.questions)[0])).toContain('needs_pu');
    const fitted = mgr.fits.find((f) => f.questions.needs_pu);
    expect(fitted.rows.map((r: any) => r.gold.needs_pu).sort()).toEqual([false, false, true, true]);
    expect((await part('relevance')).state).toBe('shadowing');
  });

  it('shadows Claude, asks before switching, and then skips messages without calling Claude', async () => {
    const t = pipeline();
    for (const text of ['Digest', 'Please review', 'News', 'Please approve']) await t.handle(message(text));
    await laya.trainWhenReady();
    const notes: any[] = [];
    const off = bus.subscribe((e) => e.type === 'notify' && notes.push(e));
    // Laya now answers like Claude does.
    mgr.answer = (q, state) => (q === 'needs_pu' ? { noul: /please/i.test(state) ? 0.95 : 0.05, route: 'auto' } : { noul: 0.1, choice: 'offer', answer_confidence: 0.9, route: 'auto' });
    for (const text of ['Digest 2', 'Please check', 'News 2', 'Please sign']) await t.handle(message(text));
    off();
    expect(claudeCalls).toHaveLength(8); // still Claude deciding while shadowing
    const rel = await part('relevance');
    expect(rel.state).toBe('proposed');
    expect(rel.agreed).toBe(4);
    expect(notes.some((x) => x.title === 'Laya is ready')).toBe(true);

    await laya.accept('relevance');
    await t.handle(message('Another digest'));
    expect(claudeCalls).toHaveLength(8); // Laya was sure it needs nothing: no Claude call
    const skipped = await repo.listSkipped();
    expect(skipped[0].reason).toMatch(/^Laya: no action needed/);

    // Laya says it needs you, but "which stream" and "next step" aren't live: Claude decides.
    await t.handle(message('Please look at this'));
    expect(claudeCalls).toHaveLength(9);
  });

  it('defers to Claude whenever Laya is unsure, even for a live part', async () => {
    const t = pipeline();
    for (const text of ['Digest', 'Please review', 'News', 'Please approve']) await t.handle(message(text));
    await laya.trainWhenReady();
    mgr.answer = (q, state) => ({ noul: /please/i.test(state) ? 0.95 : 0.05, choice: 'offer', route: 'auto' });
    for (const text of ['Digest 2', 'Please check', 'News 2', 'Please sign']) await t.handle(message(text));
    await laya.accept('relevance');
    mgr.answer = () => ({ noul: 0.4, route: 'review' });
    const before = claudeCalls.length;
    await t.handle(message('Hmm, odd one'));
    expect(claudeCalls.length).toBe(before + 1);
  });

  it('decides everything itself once all three parts are live, and Claude only names a new stream', async () => {
    const t = pipeline();
    for (const text of ['Digest', 'Please review', 'News', 'Please approve', 'Please sign', 'Bulletin', 'Please send']) await t.handle(message(text));
    await laya.trainWhenReady();
    for (const p of ['relevance', 'stream', 'next'] as const) {
      if ((await part(p)).state === 'collecting') await laya.train(p);
    }
    // Agree with Claude: relevant for "please", which Claude files as new streams, next step "offer".
    mgr.answer = (q, state) =>
      q === 'needs_pu' ? { noul: /please/i.test(state) ? 0.95 : 0.05, route: 'auto' } : q === 'same_work' ? { noul: 0.05, route: 'auto' } : { choice: 'offer', answer_confidence: 0.9, route: 'auto' };
    for (const text of ['Please one', 'Digest x', 'Please two', 'Please three', 'Please four', 'News y']) await t.handle(message(text));
    for (const p of ['relevance', 'stream', 'next'] as const) {
      expect((await part(p)).state).toBe('proposed');
      await laya.accept(p);
    }
    claude = (i) => {
      expect(i.usage.kind).toBe('newStream');
      return { title: 'Contract signature', summary: 'Lee needs a signature', labels: null };
    };
    const before = claudeCalls.length;
    await t.handle(message('Please sign the contract', 'lee@x.com'));
    expect(claudeCalls.length).toBe(before + 1);
    expect(claudeCalls.at(-1).usage.kind).toBe('newStream');
    const streams = await repo.listStreams(false);
    expect(streams.some((st) => st.title === 'Contract signature')).toBe(true);
  });

  it("counts the PU's corrections against live decisions and suggests retraining", async () => {
    const t = pipeline();
    for (const text of ['Digest', 'Please review', 'News', 'Please approve']) await t.handle(message(text));
    await laya.trainWhenReady();
    mgr.answer = (q, state) => ({ noul: /please/i.test(state) ? 0.95 : 0.05, route: 'auto' });
    for (const text of ['Digest 2', 'Please check', 'News 2', 'Please sign']) await t.handle(message(text));
    await laya.accept('relevance');
    mgr.answer = () => ({ noul: 0.05, route: 'auto' }); // now wrongly says "nothing needed"
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const m = message(`Real request ${i}`);
      await t.handle(m);
      ids.push((await repo.findItem('gmail', m.externalId))!.id);
    }
    const notes: any[] = [];
    const off = bus.subscribe((e) => e.type === 'notify' && notes.push(e));
    for (const id of ids.slice(0, 6)) await laya.correction(id, { kind: 'relevant' });
    off();
    const rel = await part('relevance');
    expect(rel.compared).toBe(4); // window = minMessages
    expect(rel.suggestRetrain).toBe(false); // too few live decisions in the window to judge (needs 20)
    s.triage.minMessages = 20;
    const rel20 = await part('relevance');
    expect(rel20.compared).toBe(20);
    expect(rel20.agreed).toBe(14); // 70%, below the 75% threshold
    expect(rel20.suggestRetrain).toBe(true);
    // The corrections became training examples that override Claude.
    const ex = await repo.db.selectFrom('laya_examples').selectAll().where('item_id', '=', ids[0]).where('part', '=', 'relevance').executeTakeFirst();
    expect(ex).toMatchObject({ source: 'pu' });
    expect(JSON.parse(ex!.gold)).toEqual({ needs_pu: true });
    void notes;

    // Retraining sends the live part back to shadowing; Claude decides again.
    await laya.train('relevance');
    expect(await part('relevance')).toMatchObject({ state: 'shadowing', version: 2 });
  });

  it('records a move to another stream as the right stream for that message', async () => {
    const other = await repo.createStream({ title: 'Budget work', summary: 'Q3 budget' });
    const t = pipeline();
    const m = message('Please review the numbers');
    await t.handle(m);
    const it = (await repo.findItem('gmail', m.externalId))!;
    await repo.moveItem(it.id, other.id);
    await laya.correction(it.id, { kind: 'moved', toStreamId: other.id });
    const rows = await repo.db.selectFrom('laya_examples').selectAll().where('part', '=', 'stream').where('item_id', '=', it.id).execute();
    const gold = Object.fromEntries(rows.map((r) => [r.candidate, JSON.parse(r.gold).same_work]));
    expect(gold[other.id]).toBe(true);
    expect(rows.every((r) => r.source === 'pu')).toBe(true);
  });
});

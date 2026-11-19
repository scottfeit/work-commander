import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCodeUsage, transcriptDir } from '../src/core/claudeCodeUsage.js';

describe("Claude Code's token usage on a hand-off", () => {
  it('sums each response once, across sessions and subagents, inside the time window, by model, with an estimated cost', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cc-'));
    const folder = '/Users/me/.wc-handoffs/budget.fix';
    const dir = transcriptDir(folder, home);
    expect(path.basename(dir)).toBe('-Users-me--wc-handoffs-budget-fix');
    fs.mkdirSync(path.join(dir, 'sess1', 'subagents'), { recursive: true });
    const line = (id: string, at: string, model: string, u: object) => JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model, usage: u } });
    const u1 = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 2000 } };
    fs.writeFileSync(
      path.join(dir, 'sess1.jsonl'),
      [
        line('m0', '2026-11-18T09:00:00.000Z', 'claude-opus-5-5', u1), // before the hand-off
        line('m1', '2026-11-18T10:01:00.000Z', 'claude-opus-5-5', u1),
        line('m1', '2026-11-18T10:01:00.500Z', 'claude-opus-5-5', u1), // same response, another content block
        JSON.stringify({ type: 'user', timestamp: '2026-11-18T10:02:00.000Z', message: { content: 'hi' } }),
        line('m2', '2026-11-18T10:03:00.000Z', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 5 }),
        'not json',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'sess1', 'subagents', 'agent-1.jsonl'), [line('s1', '2026-11-18T10:05:00.000Z', 'claude-haiku-5-5', { input_tokens: 4000, output_tokens: 1000 }), line('s2', '2026-11-18T10:06:00.000Z', 'some-future-model', { input_tokens: 7, output_tokens: 3 })].join('\n'));

    const got = await claudeCodeUsage(folder, '2026-11-18T10:00:00.000Z', '2026-11-18T11:00:00.000Z', home);
    const opus = got.find((g) => g.model === 'claude-opus-5-5')!;
    expect(opus).toMatchObject({ inputTokens: 1010, outputTokens: 205, cacheReadTokens: 10_000, cacheWriteTokens: 3000, turns: 2 });
    // $4 in, $20 out, $0.20 read, 5m write 1.25x, 1h write 2x
    expect(opus.costUsd).toBeCloseTo((1010 * 4 + 205 * 20 + 10_000 * 0.2 + 2000 * 5 + 1000 * 8) / 1e6, 10);
    expect(got.find((g) => g.model === 'claude-haiku-5-5')!.costUsd).toBeCloseTo((4000 * 0.1 + 1000 * 0.5) / 1e6, 12);
    expect(got.find((g) => g.model === 'some-future-model')).toMatchObject({ inputTokens: 7, costUsd: 0 });
    // nothing there: nothing counted
    expect(await claudeCodeUsage('/nowhere/at/all', '2026-01-01T00:00:00.000Z', undefined, home)).toEqual([]);
  });
});

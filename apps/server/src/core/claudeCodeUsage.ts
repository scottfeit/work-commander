import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** List prices per million tokens (input, output, cache read). Cache writes are 1.25x input (5 minutes) or 2x input (1 hour). */
const PRICES: [RegExp, { in: number; out: number; read?: number }][] = [
  [/fable-5-2|mythos-5-2/, { in: 8, out: 40, read: 0.2 }],
  [/fable-5|mythos-5/, { in: 10, out: 50 }],
  [/opus-5-5/, { in: 4, out: 20, read: 0.2 }],
  [/opus-(5|4-[5-8])/, { in: 5, out: 25 }],
  [/sonnet-5-5/, { in: 2, out: 10, read: 0.1 }],
  [/sonnet-5/, { in: 2, out: 10 }],
  [/sonnet-4/, { in: 3, out: 15 }],
  [/haiku-5-5/, { in: 0.1, out: 0.5 }],
  [/haiku-4/, { in: 1, out: 5 }],
];

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated at list prices; 0 for a model not in the table (the tokens still count). */
  costUsd: number;
  turns: number;
}

/** Where Claude Code keeps the session transcripts for work done in `folder`. */
export const transcriptDir = (folder: string, home = os.homedir()) => path.join(home, '.claude', 'projects', path.resolve(folder).replace(/[^a-zA-Z0-9]/g, '-'));

async function jsonlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jsonlFiles(p))); // subagent transcripts live in <session>/subagents/
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Claude Code's token usage for work in `folder` between two moments, by model, from its own transcripts. Each API response is
 * counted once (a transcript repeats a response's usage on every content block it writes).
 */
export async function claudeCodeUsage(folder: string, since: string, until = new Date().toISOString(), home?: string): Promise<ModelUsage[]> {
  const byId = new Map<string, { model: string; u: any }>();
  for (const file of await jsonlFiles(transcriptDir(folder, home))) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const m = d?.message;
      if (d?.type !== 'assistant' || !m?.usage || typeof d.timestamp !== 'string') continue;
      if (d.timestamp <= since || d.timestamp > until) continue;
      if (m.model === '<synthetic>') continue;
      byId.set(m.id ?? d.requestId ?? d.uuid, { model: String(m.model ?? 'unknown'), u: m.usage });
    }
  }
  const out = new Map<string, ModelUsage>();
  for (const { model, u } of byId.values()) {
    const e = out.get(model) ?? { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };
    const w1h = Number(u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    const wAll = Number(u.cache_creation_input_tokens ?? 0);
    const w5m = Math.max(0, wAll - w1h);
    const input = Number(u.input_tokens ?? 0);
    const output = Number(u.output_tokens ?? 0);
    const read = Number(u.cache_read_input_tokens ?? 0);
    e.inputTokens += input;
    e.outputTokens += output;
    e.cacheReadTokens += read;
    e.cacheWriteTokens += wAll;
    e.turns++;
    const p = PRICES.find(([re]) => re.test(model))?.[1];
    if (p) e.costUsd += (input * p.in + output * p.out + read * (p.read ?? p.in * 0.1) + w5m * p.in * 1.25 + w1h * p.in * 2) / 1_000_000;
    out.set(model, e);
  }
  return [...out.values()];
}

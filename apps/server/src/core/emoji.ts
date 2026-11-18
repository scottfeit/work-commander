import { createRequire } from 'node:module';

/** One standard emoji, as Slack names it. */
export interface StdEmoji {
  /** Slack's main short name ("+1"). */
  n: string;
  /** Other names it answers to ("thumbsup"). */
  a?: string[];
  /** The character. */
  c: string;
  /** Category ("People & Body"). */
  cat: string;
}

let cache: StdEmoji[] | null = null;
let byName: Map<string, string> | null = null;

/** Slack's standard emoji (from emoji-datasource, the data Slack's names come from), in picker order; skin-tone swatches left out. */
export function standardEmoji(): StdEmoji[] {
  if (cache) return cache;
  const raw = createRequire(import.meta.url)('emoji-datasource/emoji.json') as { short_name: string; short_names: string[]; unified: string; category: string; sort_order: number }[];
  cache = raw
    .filter((e) => e.category !== 'Component')
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((e) => {
      const alt = e.short_names.filter((x) => x !== e.short_name);
      return { n: e.short_name, ...(alt.length ? { a: alt } : {}), c: String.fromCodePoint(...e.unified.split('-').map((h) => parseInt(h, 16))), cat: e.category };
    });
  return cache;
}

/** The character for a Slack emoji name (any of its names; a "::skin-tone-N" suffix is shown as the plain emoji). */
export function emojiChar(name: string): string | null {
  if (!byName) {
    byName = new Map();
    for (const e of standardEmoji()) for (const k of [e.n, ...(e.a ?? [])]) byName.set(k, e.c);
  }
  return byName.get(name.replace(/::skin-tone-\d$/, '')) ?? null;
}

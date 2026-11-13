import { describe, expect, it } from 'vitest';
import { page } from '../src/agent/tools.js';

describe('page (long reads are paged, never silently cut)', () => {
  const text = Array.from({ length: 30_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

  it('returns short text untouched', () => {
    expect(page('hello')).toBe('hello');
  });

  it('tells the reader how to continue, and the pages rebuild the whole text', () => {
    let offset = 0;
    let out = '';
    let calls = 0;
    for (;;) {
      const r = page(text, offset);
      calls++;
      const m = r.match(/call again with offset=(\d+) to read the rest\]$/);
      out += r.replace(/^\[characters [^\n]*\]\n/, '').replace(/\n…\[characters [^\]]*\]$/, '');
      if (!m) break;
      offset = Number(m[1]);
    }
    expect(calls).toBe(3);
    expect(out).toBe(text);
  });

  it('reports an offset past the end', () => {
    expect(page(text, 99_999)).toContain('past the end');
  });
});

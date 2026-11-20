import { describe, expect, it } from 'vitest';
import { splitQuoted } from '../../web/src/components/quoted.js';

// The old "closing run of > lines" regex backtracked exponentially on a long quoted chain ending in an unquoted signature
// (a newsletter reply chain froze the browser tab). These must finish at once.
describe('quoted-email folding stays fast', () => {
  it('a long nested quote chain that ends in an unquoted signature', () => {
    const chain = Array.from({ length: 300 }, (_, i) => `> > line ${i}\r`).join('\n');
    const t = `Hello\r\n${chain}\r\n\r\n • Rhett\r\n • Google Cloud\r\n`;
    const start = Date.now();
    const r = splitQuoted(t);
    expect(Date.now() - start).toBeLessThan(200);
    expect(r.quoted === null || r.visible.length > 0).toBe(true);
  });
  it('a very long line of > characters', () => {
    const start = Date.now();
    splitQuoted(`Hi\n${'> '.repeat(500)}\nthanks`);
    expect(Date.now() - start).toBeLessThan(200);
  });
  it('still folds a closing run of quoted lines, blank lines between and after, and nothing else', () => {
    expect(splitQuoted('Yes.\n\n> a\n\n> b\n\n')).toEqual({ visible: 'Yes.', quoted: '> a\n\n> b\n\n' });
    expect(splitQuoted('Yes.\n> a\nunquoted\n').quoted).toBeNull();
    expect(splitQuoted('> only quote')).toEqual({ visible: '> only quote', quoted: null });
    expect(splitQuoted('\n> only quote')).toEqual({ visible: '\n> only quote', quoted: null });
  });
});

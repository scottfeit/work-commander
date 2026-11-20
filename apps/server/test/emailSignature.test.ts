import { describe, expect, it } from 'vitest';
import { emailHtml, signDraft, signatureFromHtml, withoutSignature } from '../src/core/emailSignature.js';
import { buildMime } from '../src/integrations/google.js';

const sig = signatureFromHtml('<div><b>Alex Rivera</b><br>IT Ops · <a href="https://acme.example">acme.example</a></div>')!;

describe('Gmail signature', () => {
  it('reads the text of the HTML signature; none when empty', () => {
    expect(sig.text).toBe('Alex Rivera\nIT Ops · acme.example');
    expect(signatureFromHtml('')).toBeNull();
    expect(signatureFromHtml('<div><br></div>')).toBeNull();
  });

  it('a draft ends with the signature text, once', () => {
    const p = signDraft({ body: 'Hi Priya,\n\nDone.\n\nThanks,\nAlex\n' }, sig);
    expect(p.body).toBe(`Hi Priya,\n\nDone.\n\nThanks,\nAlex\n\n${sig.text}`);
    expect(signDraft(p, sig)).toBe(p);
    expect(signDraft({ body: '' }, sig).body).toBe(`\n\n${sig.text}`);
    expect(signDraft({ body: 'x' }, null)).toEqual({ body: 'x' });
  });

  it('a blank Quick Reply with only the signature still counts as blank', () => {
    expect(withoutSignature(signDraft({ body: '' }, sig).body, sig.text).trim()).toBe('');
  });

  it('the HTML version carries the real signature; an edited signature sends as written', () => {
    const p = signDraft({ body: 'See <this> & https://x.example/a.\nBye' }, sig);
    const html = emailHtml(p.body, p)!;
    expect(html).toContain('See &lt;this&gt; &amp; <a href="https://x.example/a">https://x.example/a</a>.<br>');
    expect(html).toContain('<div class="gmail_signature" data-smartmail="gmail_signature"><div><b>Alex Rivera</b>');
    const edited = emailHtml(p.body.replace('IT Ops', 'Ops'), p)!;
    expect(edited).not.toContain('gmail_signature');
    expect(edited).toContain('Ops · acme.example');
    expect(emailHtml('plain', {})).toBeNull();
  });

  it('the email goes out as text and HTML alternatives (inside mixed when there are files)', () => {
    const base = { from: 'a@x.com', to: ['b@x.com'], cc: [], subject: 'S', body: 'hello', html: '<b>hello</b>' };
    const m = buildMime(base);
    expect(m).toMatch(/Content-Type: multipart\/alternative; boundary="wca_/);
    expect(m.indexOf('text/plain')).toBeLessThan(m.indexOf('text/html'));
    const withFile = buildMime({ ...base, files: [{ filename: 'a.txt', mimeType: 'text/plain', data: Buffer.from('x') }] });
    expect(withFile.indexOf('multipart/mixed')).toBeLessThan(withFile.indexOf('multipart/alternative'));
    expect(buildMime({ ...base, html: undefined })).not.toContain('multipart/alternative');
  });
});

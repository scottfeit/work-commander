import { htmlToText } from '../integrations/types.js';
import type { IntegrationHub } from '../integrations/hub.js';

/** The PU's Gmail signature: the HTML Gmail keeps, and its text (what the draft shows). */
export interface EmailSignature {
  html: string;
  text: string;
}

export function signatureFromHtml(html: string | null | undefined): EmailSignature | null {
  const h = (html ?? '').trim();
  if (!h) return null;
  const text = htmlToText(h).trim();
  return text ? { html: h, text } : null;
}

/** The signature, or null when Gmail isn't connected directly or has none (never fails a draft). */
export async function currentSignature(hub: Pick<IntegrationHub, 'api' | 'systemMode'>): Promise<EmailSignature | null> {
  try {
    if ((await hub.systemMode('google')) !== 'api') return null;
    const email = await hub.api('email');
    return (await email.signature?.()) ?? null;
  } catch {
    return null;
  }
}

/** An email draft's payload with the signature's text at the end of the body (kept, hidden, as HTML for sending). */
export function signDraft<T extends Record<string, any>>(payload: T, sig: EmailSignature | null): T {
  if (!sig || payload.signature_text) return payload;
  const body = String(payload.body ?? '').replace(/\s+$/, '');
  if (body.includes(sig.text)) return payload; // already signed
  return { ...payload, body: `${body}\n\n${sig.text}`, signature_text: sig.text, signature_html: sig.html };
}

/** The body without its (unchanged) signature: what the PU actually wrote. */
export function withoutSignature(body: string, sigText?: string) {
  const b = (body ?? '').replace(/\s+$/, '');
  return sigText && b.endsWith(sigText) ? b.slice(0, b.length - sigText.length) : b;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const linkify = (s: string) => s.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, (u) => `<a href="${u}">${u}</a>`);
const textHtml = (s: string) => linkify(esc(s)).replace(/\r?\n/g, '<br>\n');

/**
 * The HTML version of an email whose draft carried the signature: what the PU wrote, then the signature as Gmail has it. If the PU
 * edited or removed the signature's text, the HTML is just their text as written. null = no HTML version (send plain text only).
 */
export function emailHtml(body: string, sig: { signature_text?: string; signature_html?: string }): string | null {
  if (!sig.signature_html || !sig.signature_text) return null;
  const b = (body ?? '').replace(/\s+$/, '');
  if (!b.endsWith(sig.signature_text)) return `<div dir="ltr">${textHtml(b)}</div>`;
  const mine = b.slice(0, b.length - sig.signature_text.length).replace(/\s+$/, '');
  return `<div dir="ltr">${textHtml(mine)}<br>\n<br>\n<div class="gmail_signature" data-smartmail="gmail_signature">${sig.signature_html}</div></div>`;
}

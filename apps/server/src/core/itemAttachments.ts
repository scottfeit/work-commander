import type { MessageAttachment, StreamItem } from '@wc/shared';
import type { IntegrationHub } from '../integrations/hub.js';

/** Image types shown inline. (SVG can carry scripts, so it's always a download.) */
export const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

/** Find an attachment on an item: on one of its messages or comments, or on the ticket itself. */
export function findAttachment(item: StreamItem, id: string): { a: MessageAttachment; messageId?: string } | null {
  for (const m of [...(item.data.messages ?? []), ...(item.data.ticket?.comments ?? [])]) {
    const a = [...(m.attachments ?? []), ...(m.forwarded ?? []).flatMap((f) => f.attachments ?? [])].find((x) => x.id === id);
    if (a) return { a, messageId: m.id };
  }
  const t = item.data.ticket?.attachments?.find((x) => x.id === id);
  return t ? { a: t } : null;
}

/** The attachment's bytes, from its source. */
export async function fetchAttachment(hub: IntegrationHub, item: StreamItem, found: { a: MessageAttachment; messageId?: string }): Promise<Buffer> {
  if (item.source === 'gmail') {
    const email = await hub.api('email');
    if (!email.attachment || !found.messageId) throw new Error('Attachments need Gmail connected directly');
    return email.attachment(found.messageId, found.a);
  }
  if (item.source === 'slack') {
    const chat = await hub.api('chat');
    if (!chat.download) throw new Error('Files need Slack connected directly');
    return chat.download(found.a.ref);
  }
  if (item.source === 'jira' || item.source === 'jsm') {
    const t = await hub.api('tickets');
    if (!t.download) throw new Error('Attachments need Atlassian connected directly');
    return t.download(found.a.ref);
  }
  throw new Error('No attachments for this kind of item');
}

import { describe, expect, it } from 'vitest';
import { attachmentsOf } from '../src/integrations/google.js';
import { filesOf } from '../src/integrations/slack.js';
import { AtlassianCloud } from '../src/integrations/atlassian.js';
import { INLINE_IMAGE, findAttachment } from '../src/core/itemAttachments.js';

describe('attachments on work items', () => {
  it('Gmail: every named part held as an attachment, at any depth', () => {
    const payload: any = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: 'aGk' } }, { mimeType: 'text/html', body: { data: 'aGk' } }] },
        { partId: '1', filename: 'Q3 report.pdf', mimeType: 'application/pdf', body: { attachmentId: 'ATT1', size: 2048 } },
        { partId: '2', mimeType: 'multipart/related', parts: [{ partId: '2.1', filename: 'chart.png', mimeType: 'image/png', body: { attachmentId: 'ATT2', size: 99 } }] },
        { partId: '3', filename: '', mimeType: 'text/plain', body: { attachmentId: 'X' } },
      ],
    };
    expect(attachmentsOf(payload)).toEqual([
      { id: '1', name: 'Q3 report.pdf', mimeType: 'application/pdf', size: 2048, ref: 'ATT1' },
      { id: '2.1', name: 'chart.png', mimeType: 'image/png', size: 99, ref: 'ATT2' },
    ]);
  });

  it('Slack: files on a message (deleted ones skipped)', () => {
    expect(filesOf({ files: [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', size: 10, url_private_download: 'https://files.slack.com/a/shot.png' }, { id: 'F2', mode: 'tombstone' }] })).toEqual({
      attachments: [{ id: 'F1', name: 'shot.png', mimeType: 'image/png', size: 10, ref: 'https://files.slack.com/a/shot.png' }],
    });
    expect(filesOf({})).toEqual({});
  });

  it('Jira: the issue\'s attachments, and downloads only from this site', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => (calls.push(url), new Response('bytes'))) as any;
    const at = new AtlassianCloud('https://acme.atlassian.net', 'me@x.com', 'tok', fake);
    const inb = at.toInbound({ key: 'OPS-1', fields: { summary: 's', attachment: [{ id: 10, filename: 'log.txt', mimeType: 'text/plain', size: 5, content: 'https://acme.atlassian.net/rest/api/3/attachment/content/10' }] } });
    expect(inb.data.ticket!.attachments).toEqual([{ id: '10', name: 'log.txt', mimeType: 'text/plain', size: 5, ref: 'https://acme.atlassian.net/rest/api/3/attachment/content/10' }]);
    expect((await at.download(inb.data.ticket!.attachments![0].ref)).toString()).toBe('bytes');
    await expect(at.download('https://evil.example.com/x')).rejects.toThrow(/Not an attachment/);
    expect(calls).toEqual(['https://acme.atlassian.net/rest/api/3/attachment/content/10']);
  });

  it('finding an attachment on a message, a comment or the ticket; only safe image types inline', () => {
    const item: any = { data: { messages: [{ id: 'm1', attachments: [{ id: 'a', name: 'a.png', mimeType: 'image/png', ref: 'r' }] }], ticket: { comments: [], attachments: [{ id: 't', name: 'x', mimeType: 'text/plain', ref: 'u' }] } } };
    expect(findAttachment(item, 'a')).toMatchObject({ messageId: 'm1', a: { name: 'a.png' } });
    expect(findAttachment(item, 't')).toMatchObject({ a: { name: 'x' } });
    expect(findAttachment(item, 'nope')).toBeNull();
    expect(INLINE_IMAGE.test('image/png')).toBe(true);
    expect(INLINE_IMAGE.test('image/svg+xml')).toBe(false);
  });
});

import type { Repo } from './repo.js';
import type { DocsApi } from '../integrations/types.js';

export interface GoogleFileLink {
  id: string;
  url: string;
}

const GFILE = /https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{10,})[^\s)>\]"']*/g;

/** Google Docs, Sheets and Slides links in some text, one per file. */
export function googleFileLinks(text: string): GoogleFileLink[] {
  const seen = new Map<string, GoogleFileLink>();
  for (const m of text.matchAll(GFILE)) if (!seen.has(m[2])) seen.set(m[2], { id: m[2], url: `https://docs.google.com/${m[1]}/d/${m[2]}/edit` });
  return [...seen.values()];
}

/**
 * Put a Google file (Doc, Sheet, Slides) in a work stream as a work item. The same file may sit in several streams,
 * so each stream gets its own item (the id includes the stream). Calling it again refreshes the item's content.
 */
export async function attachDriveFile(repo: Repo, docs: Pick<DocsApi, 'read'> | null, streamId: string, file: { id: string; url?: string }, opts: { quiet?: boolean } = {}) {
  let title = `Google file ${file.id.slice(0, 8)}…`;
  let url = file.url ?? `https://drive.google.com/open?id=${file.id}`;
  let body = '(Open it in Drive to see the current version.)';
  try {
    const f = await docs?.read(file.id);
    if (f) {
      title = f.title || title;
      url = f.url || url;
      body = f.text || body;
    }
  } catch {
    /* no read access: the item still links to the file */
  }
  const { item } = await repo.upsertItem({ source: 'drive', kind: 'doc', externalId: `${file.id}@${streamId}`, title, url, data: { body }, streamId });
  if (item.streamId !== streamId) await repo.attachItem(item.id, streamId);
  if (!opts.quiet) await repo.markItemUnread(item.id); // quiet: the PU added it themselves, so no dot
  return (await repo.getItem(item.id)) ?? item;
}

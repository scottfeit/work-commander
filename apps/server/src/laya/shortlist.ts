/**
 * Picks the few open work streams a new message most likely belongs to, so Laya only has to answer
 * "same work as this stream?" for a handful of candidates. Cheap signals only: shared people, shared words, recency.
 */
import type { ThreadMessage, WorkStream } from '@wc/shared';
import type { Repo } from '../core/repo.js';

const MAX = 5;
const STOP = new Set('the a an and or but to of in on for with at by from is are was were be been it this that these those you your we our i me my re fw fwd hi hello thanks thank please can could would will just about as if so not no yes do does did have has had get got any some all one up out new'.split(' '));

export const words = (t: string) => new Set((t.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));
const people = (msgs: ThreadMessage[]) => {
  const out = new Set<string>();
  for (const m of msgs) for (const x of [m.author.email, m.author.slackUserId, m.author.accountId, ...(m.to ?? []), ...(m.cc ?? [])]) if (x) out.add(x.toLowerCase());
  return out;
};

export async function shortlistStreams(repo: Repo, input: { title: string; messages: ThreadMessage[]; puIds: string[]; exclude: string[] }): Promise<WorkStream[]> {
  const open = (await repo.listStreams(false)).filter((s) => s.status === 'open' && !input.exclude.includes(s.id));
  if (!open.length) return [];
  const pu = new Set(input.puIds.map((x) => x.toLowerCase()));
  const mine = people(input.messages);
  for (const x of pu) mine.delete(x);
  const text = words(`${input.title} ${input.messages.map((m) => m.text.slice(0, 2000)).join(' ')}`);
  const scored = [];
  for (const s of open) {
    const items = await repo.listItems(s.id);
    const theirs = people(items.flatMap((i) => i.data.messages ?? i.data.ticket?.comments ?? []));
    const sharedPeople = [...mine].filter((x) => theirs.has(x)).length;
    const sw = words(`${s.title} ${s.summary} ${items.map((i) => i.title).join(' ')}`);
    const shared = [...text].filter((w) => sw.has(w)).length;
    const overlap = shared / Math.max(1, Math.min(text.size, sw.size));
    const ageDays = (Date.now() - Date.parse(s.lastActivityAt)) / 86_400_000;
    scored.push({ s, score: 3 * Math.min(sharedPeople, 3) + 6 * overlap + Math.max(0, 1 - ageDays / 30) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX).map((x) => x.s);
}

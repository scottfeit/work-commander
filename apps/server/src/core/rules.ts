import type { ItemSource, ThreadMessage, TriageRule } from '@wc/shared';

const has = (hay: string | undefined, needle: string | undefined) => !needle?.trim() || (hay ?? '').toLowerCase().includes(needle.trim().toLowerCase());
const sourceOk = (rule: TriageRule, source: ItemSource) => rule.source === 'any' || rule.source === source || (rule.source === 'jira' && source === 'jsm');

/** A rule with nothing filled in would match everything; it is never applied. */
export const ruleIsEmpty = (r: TriageRule) => !r.from?.trim() && !r.subject?.trim() && !r.text?.trim();

/** The first enabled rule that matches an update (its new messages from others), or null. */
export function matchRule(rules: TriageRule[], item: { source: ItemSource; title: string }, fresh: ThreadMessage[]): TriageRule | null {
  for (const r of rules) {
    if (r.enabled === false || ruleIsEmpty(r) || !sourceOk(r, item.source)) continue;
    if (r.action === 'stream' && !r.streamId) continue;
    if (!has(item.title, r.subject)) continue;
    if (r.from?.trim() && !fresh.some((m) => has(m.author.email, r.from) || has(m.author.name, r.from))) continue;
    if (r.text?.trim() && !fresh.some((m) => has(m.text, r.text))) continue;
    return r;
  }
  return null;
}

/** "from @news.example.com, subject has "digest"" */
export function describeRule(r: TriageRule) {
  const parts = [r.source !== 'any' ? r.source : '', r.from ? `from "${r.from}"` : '', r.subject ? `subject has "${r.subject}"` : '', r.text ? `text has "${r.text}"` : ''].filter(Boolean);
  return parts.join(', ');
}

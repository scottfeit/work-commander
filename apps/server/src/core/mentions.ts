import type { PrimaryUser, ThreadMessage } from '@wc/shared';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does any message directly refer to the PU: a Slack mention of their id, "@Their Name", their full name, an alias handle or their email?
 * (First names alone are deliberately not enough: they match far too many people.)
 */
export function referencesPU(msgs: ThreadMessage[], pu: Pick<PrimaryUser, 'name' | 'email' | 'aliases' | 'slackUserId'>): boolean {
  const words = [pu.name, ...(pu.aliases ?? [])].map((x) => x.trim()).filter((x) => x.length >= 3);
  const patterns = words.map((w) => new RegExp(`(^|[^\\p{L}\\p{N}])@?${esc(w)}($|[^\\p{L}\\p{N}])`, 'iu'));
  for (const m of msgs) {
    const t = m.text ?? '';
    if (pu.slackUserId && t.includes(`<@${pu.slackUserId}`)) return true;
    if (pu.email && t.toLowerCase().includes(pu.email.trim().toLowerCase())) return true;
    if (patterns.some((p) => p.test(t))) return true;
  }
  return false;
}

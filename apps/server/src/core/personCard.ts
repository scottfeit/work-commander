import type { IntegrationHub } from '../integrations/hub.js';
import type { Repo } from './repo.js';

/** What a people card shows: role and team from the org chart, and how to reach them (email, Slack handle). */
export interface PersonCard {
  name: string;
  email?: string;
  title?: string;
  department?: string;
  manager?: string;
  slackHandle?: string;
}

export async function personCard(d: { repo: Repo; hub: Pick<IntegrationHub, 'api' | 'systemMode'> }, q: { name?: string; email?: string; slackUserId?: string }): Promise<PersonCard> {
  const people = await d.repo.listPeople();
  const email = q.email?.trim().toLowerCase();
  const p =
    (email && people.find((x) => x.email === email)) ||
    (q.slackUserId && people.find((x) => x.slackUserId === q.slackUserId)) ||
    (q.name && people.find((x) => x.name.toLowerCase() === q.name!.trim().toLowerCase())) ||
    null;
  const out: PersonCard = { name: p?.name ?? q.name ?? email ?? 'Unknown', email: p?.email ?? email, title: p?.title, department: p?.department };
  if (p?.managerEmail) out.manager = people.find((x) => x.email === p.managerEmail)?.name ?? p.managerEmail;
  // Slack handle: only when Slack is connected directly (one lookup, cached by the Slack client)
  try {
    if ((await d.hub.systemMode('slack')) === 'api') {
      const chat = await d.hub.api('chat');
      const id = q.slackUserId ?? p?.slackUserId ?? (out.email ? (await chat.lookupUserByEmail(out.email))?.id : undefined);
      const prof = id && chat.profile ? await chat.profile(id) : null;
      if (prof?.handle) out.slackHandle = prof.handle;
      if (!out.email && prof?.email) out.email = prof.email;
    }
  } catch {
    /* no Slack: the card shows what the org chart knows */
  }
  return out;
}

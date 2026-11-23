import { describe, expect, it } from 'vitest';
import { buildBrief } from '../src/core/handoff.js';

const st: any = { id: 's', title: 'IT-1 thing', summary: 'S', labels: [], status: 'open' };
const ticket: any = { id: 'i', source: 'jsm', kind: 'ticket', title: 'IT-75731', data: { ticket: { key: 'IT-75731', flavor: 'jsm', status: 'Open', summary: 's', comments: [] } } };
const mail: any = { id: 'm', source: 'gmail', kind: 'email_thread', title: 'x', data: { messages: [] } };

describe('the hand-off brief points Claude Code at the ticket skill', () => {
  it('when the stream has a ticket and you have a resolve-ticket skill', () => {
    const b = buildBrief(st, [ticket], [], 'Fix it', ['resolve-ticket', 'docx']);
    expect(b).toContain('## Skill');
    expect(b).toContain('/resolve-ticket IT-75731');
  });
  it('not without a ticket, and not without the skill', () => {
    expect(buildBrief(st, [mail], [], 'Fix it', ['resolve-ticket'])).not.toContain('## Skill');
    expect(buildBrief(st, [ticket], [], 'Fix it', ['docx'])).not.toContain('## Skill');
    expect(buildBrief(st, [ticket], [], 'Fix it')).not.toContain('## Skill');
  });
});

import { describe, expect, it } from 'vitest';
import { AtlassianCloud } from '../src/integrations/atlassian.js';

const TRANSITIONS = {
  transitions: [
    { id: '11', name: 'Start work', to: { name: 'In Progress' }, fields: {} },
    {
      id: '31',
      name: 'Resolve',
      to: { name: 'Resolved' },
      fields: {
        resolution: { required: true, name: 'Resolution', allowedValues: [{ id: '1', name: 'Done' }, { id: '2', name: "Won't Do" }] },
        comment: { required: false, name: 'Comment' },
        priority: { required: true, hasDefaultValue: true, name: 'Priority' },
      },
    },
  ],
};

describe('Jira status changes', () => {
  it('lists where the ticket can go, with only the fields Jira insists on', async () => {
    const at = new AtlassianCloud('https://acme.atlassian.net', 'me@x.com', 't', (async () => new Response(JSON.stringify(TRANSITIONS))) as any);
    expect(await at.transitionOptions('IT-1')).toEqual([
      { id: '11', name: 'Start work', to: 'In Progress', fields: [] },
      { id: '31', name: 'Resolve', to: 'Resolved', fields: [{ key: 'resolution', name: 'Resolution', allowed: [{ id: '1', name: 'Done' }, { id: '2', name: "Won't Do" }] }] },
    ]);
  });

  it('moves by transition id, with the required fields', async () => {
    const sent: any[] = [];
    const f = (async (_u: string, init: any) => (init?.method === 'POST' ? (sent.push(JSON.parse(init.body)), new Response(null, { status: 204 })) : new Response(JSON.stringify(TRANSITIONS)))) as any;
    const at = new AtlassianCloud('https://acme.atlassian.net', 'me@x.com', 't', f);
    expect(await at.transition({ key: 'IT-1', to: '', id: '31', fields: { resolution: { id: '2' } } })).toEqual({ status: 'Resolved' });
    expect(sent).toEqual([{ transition: { id: '31' }, fields: { resolution: { id: '2' } } }]);
    await expect(at.transition({ key: 'IT-1', to: '', id: '99' })).rejects.toThrow(/No transition "99"/);
  });
});

import { describe, expect, it } from 'vitest';
import { AtlassianCloud } from '../src/integrations/atlassian.js';

function site(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const f = (async (url: string, init: any) => {
    const path = url.replace('https://acme.atlassian.net', '');
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body) : undefined });
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
    return hit ? new Response(JSON.stringify(hit[1])) : new Response(null, { status: 204 });
  }) as any;
  return { at: new AtlassianCloud('https://acme.atlassian.net', 'me@x.com', 't', f), calls };
}

const BOARDS = {
  '/rest/agile/1.0/board?': { values: [{ id: 7 }] },
  '/rest/agile/1.0/board/7/sprint': {
    values: [
      { id: 41, name: 'IT Sprint 41', state: 'active' },
      { id: 43, name: 'IT Sprint 43', state: 'future', startDate: '2026-12-14' },
      { id: 42, name: 'IT Sprint 42', state: 'future', startDate: '2026-11-30' },
    ],
  },
};

describe('epic and sprint', () => {
  it('puts issues under an epic, or takes them out', async () => {
    const { at, calls } = site({});
    expect(await at.setEpic({ keys: ['IT-1', 'IT-2'], epic: 'it-500' })).toEqual({ epic: 'IT-500' });
    expect(await at.setEpic({ keys: ['IT-3'], epic: 'none' })).toEqual({ epic: null });
    expect(calls).toEqual([
      { method: 'POST', path: '/rest/agile/1.0/epic/IT-500/issue', body: { issues: ['IT-1', 'IT-2'] } },
      { method: 'POST', path: '/rest/agile/1.0/epic/none/issue', body: { issues: ['IT-3'] } },
    ]);
  });

  it('finds the sprint by name, "active" or "next", or sends issues to the backlog', async () => {
    const { at, calls } = site(BOARDS);
    expect(await at.setSprint({ keys: ['IT-1'], sprint: 'it sprint 43' })).toEqual({ sprint: 'IT Sprint 43' });
    expect(await at.setSprint({ keys: ['IT-1'], sprint: 'active' })).toEqual({ sprint: 'IT Sprint 41' });
    expect(await at.setSprint({ keys: ['IT-1'], sprint: 'next' })).toEqual({ sprint: 'IT Sprint 42' });
    expect(await at.setSprint({ keys: ['IT-1', 'IT-2'], sprint: 'backlog' })).toEqual({ sprint: 'Backlog' });
    const posts = calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]);
    expect(posts).toEqual([
      ['/rest/agile/1.0/sprint/43/issue', { issues: ['IT-1'] }],
      ['/rest/agile/1.0/sprint/41/issue', { issues: ['IT-1'] }],
      ['/rest/agile/1.0/sprint/42/issue', { issues: ['IT-1'] }],
      ['/rest/agile/1.0/backlog/issue', { issues: ['IT-1', 'IT-2'] }],
    ]);
    expect(calls.find((c) => c.path.startsWith('/rest/agile/1.0/board?'))!.path).toContain('projectKeyOrId=IT');
    await expect(at.setSprint({ keys: ['IT-1'], sprint: 'Sprint 99' })).rejects.toThrow(/Open sprints: IT Sprint 41, IT Sprint 43, IT Sprint 42/);
  });
});

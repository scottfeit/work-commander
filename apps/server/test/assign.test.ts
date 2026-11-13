import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlassianCloud } from '../src/integrations/atlassian.js';

afterEach(() => vi.restoreAllMocks());
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe('AtlassianCloud.assign', () => {
  it('looks the assignee up by email and sets the issue assignee', async () => {
    const calls: [string, string, any][] = [];
    const f = vi.fn(async (url: any, init: any) => {
      calls.push([init.method, String(url), init.body ? JSON.parse(init.body) : undefined]);
      return String(url).includes('/user/search') ? json([{ accountId: 'acc-1', emailAddress: 'Pat@x.com' }]) : new Response(null, { status: 204 });
    });
    const at = new AtlassianCloud('https://s.atlassian.net', 'me@x.com', 'tok', f as any);
    expect(await at.assign({ key: 'IT-1', assignee: 'pat@x.com' })).toEqual({ assignee: 'pat@x.com' });
    expect(calls.at(-1)).toEqual(['PUT', 'https://s.atlassian.net/rest/api/3/issue/IT-1/assignee', { accountId: 'acc-1' }]);
  });
  it('supports "me" and unassigning, and fails clearly for an unknown user', async () => {
    const f = vi.fn(async (url: any, init: any) => (String(url).endsWith('/myself') ? json({ accountId: 'me-1', displayName: 'Me' }) : String(url).includes('/user/search') ? json([]) : new Response(null, { status: 204 })));
    const at = new AtlassianCloud('https://s.atlassian.net', 'me@x.com', 'tok', f as any);
    expect((await at.assign({ key: 'IT-1', assignee: 'me' })).assignee).toBe('Me');
    expect((await at.assign({ key: 'IT-1', assignee: null })).assignee).toBeNull();
    await expect(at.assign({ key: 'IT-1', assignee: 'nobody@x.com' })).rejects.toThrow(/No Jira user/);
  });
});

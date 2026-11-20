import { describe, expect, it } from 'vitest';
import { AtlassianCloud, resolveLinkType } from '../src/integrations/atlassian.js';

const TYPES = [
  { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  { name: 'Relates', inward: 'relates to', outward: 'relates to' },
  { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
];

describe('linking Jira issues', () => {
  it('a relation picks the link type and direction', () => {
    expect(resolveLinkType(TYPES, 'blocks')).toMatchObject({ type: { name: 'Blocks' }, reverse: false });
    expect(resolveLinkType(TYPES, 'Is  Blocked By')).toMatchObject({ type: { name: 'Blocks' }, reverse: true });
    expect(resolveLinkType(TYPES, 'relates to')).toMatchObject({ type: { name: 'Relates' } });
    expect(resolveLinkType(TYPES, 'related')).toMatchObject({ type: { name: 'Relates' } });
    expect(resolveLinkType(TYPES, 'Duplicate')).toMatchObject({ type: { name: 'Duplicate' }, reverse: false });
    expect(resolveLinkType(TYPES, 'causes')).toBeNull();
  });

  it('links each issue to the target, in the right direction', async () => {
    const posts: any[] = [];
    const f = (async (url: string, init: any) => {
      if (url.endsWith('/issueLinkType')) return new Response(JSON.stringify({ issueLinkTypes: TYPES }));
      posts.push(JSON.parse(init.body));
      return new Response(null, { status: 201 });
    }) as any;
    const at = new AtlassianCloud('https://acme.atlassian.net', 'me@x.com', 't', f);
    expect(await at.linkIssues({ keys: ['IT-123', 'IT-124'], to: 'IT-999', relation: 'relates to' })).toEqual({ type: 'Relates', linked: ['IT-123 relates to IT-999', 'IT-124 relates to IT-999'] });
    await at.linkIssues({ keys: ['IT-1'], to: 'IT-9', relation: 'blocks' });
    await at.linkIssues({ keys: ['IT-2'], to: 'IT-9', relation: 'is blocked by' });
    expect(posts.slice(2)).toEqual([
      { type: { name: 'Blocks' }, inwardIssue: { key: 'IT-1' }, outwardIssue: { key: 'IT-9' } }, // IT-1 blocks IT-9
      { type: { name: 'Blocks' }, inwardIssue: { key: 'IT-9' }, outwardIssue: { key: 'IT-2' } }, // IT-9 blocks IT-2
    ]);
    await expect(at.linkIssues({ keys: ['IT-1'], to: 'IT-9', relation: 'causes' })).rejects.toThrow(/This site has: blocks/);
  });
});

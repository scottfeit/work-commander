import { describe, expect, it } from 'vitest';
import { ticketFormsText } from '@wc/shared';
import { AtlassianCloud } from '../src/integrations/atlassian.js';

const issue = (key: string, type: string) => ({ key, fields: { summary: 'Laptop', status: { name: 'Open' }, project: { projectTypeKey: type }, comment: { comments: [] }, updated: '2026-11-20T10:00:00Z' } });

function site(opts: { forms?: any[]; failForms?: boolean } = {}) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/_edge/tenant_info')) return new Response(JSON.stringify({ cloudId: 'cloud-1' }));
    if (url.includes('/rest/api/3/myself')) return new Response(JSON.stringify({ accountId: 'me' }));
    if (url.includes('/rest/api/3/issue/')) return new Response(JSON.stringify(issue(url.includes('IT-') ? 'IT-7' : 'HR-1', url.includes('IT-') ? 'software' : 'service_desk')));
    if (opts.failForms) return new Response('nope', { status: 403 });
    if (url.endsWith('/issue/HR-1/form')) return new Response(JSON.stringify(opts.forms ?? [{ id: 'f1', name: 'New hire', submitted: true, updated: 'u1' }]));
    if (url.endsWith('/form/f1/format/answers'))
      return new Response(JSON.stringify([{ label: 'Start date', answer: '2026-12-01', fieldKey: 'a' }, { label: 'Equipment', answer: 'Laptop, Monitor' }, { label: 'Notes', answer: '' }]));
    return new Response('?', { status: 404 });
  }) as any;
  return { at: new AtlassianCloud('https://acme.atlassian.net', 'me@x.com', 't', f), calls };
}

describe('JSM forms', () => {
  it('a JSM request comes with its forms and answers', async () => {
    const { at, calls } = site();
    const item = await at.getIssue('HR-1');
    expect(item.data.ticket!.forms).toEqual([
      { id: 'f1', name: 'New hire', submitted: true, answers: [{ label: 'Start date', answer: '2026-12-01' }, { label: 'Equipment', answer: 'Laptop, Monitor' }, { label: 'Notes', answer: '' }] },
    ]);
    expect(calls).toContain('https://api.atlassian.com/jira/forms/cloud/cloud-1/issue/HR-1/form');
  });

  it("answers are fetched again only when the form changes; Jira issues aren't asked", async () => {
    const { at, calls } = site();
    await at.getIssue('HR-1');
    await at.getIssue('HR-1');
    expect(calls.filter((c) => c.endsWith('/format/answers'))).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith('/tenant_info'))).toHaveLength(1);
    const jira = await at.getIssue('IT-7');
    expect(jira.data.ticket!.forms).toBeUndefined();
    expect(calls.some((c) => c.includes('IT-7/form'))).toBe(false);
  });

  it('no Forms access leaves the ticket as it was', async () => {
    const { at } = site({ failForms: true });
    const item = await at.getIssue('HR-1');
    expect(item.data.ticket!.forms).toBeUndefined();
    expect(item.data.ticket!.summary).toBe('Laptop');
  });

  it('Claude reads forms as question/answer lines', () => {
    expect(ticketFormsText([{ id: 'f', name: 'New hire', submitted: false, answers: [{ label: 'Start date', answer: 'Mon' }, { label: 'Notes', answer: '' }] }])).toBe(
      'Form: New hire (not submitted)\n- Start date: Mon\n- Notes: (blank)',
    );
  });
});

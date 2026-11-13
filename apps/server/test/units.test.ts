import { describe, expect, it } from 'vitest';
import { fillPlaceholders } from '../src/core/executor.js';
import { mapRecords, pick } from '../src/orgchart/import.js';
import { encodeEmail, parseAddressList } from '../src/integrations/google.js';
import { adfToText, textToAdf } from '../src/integrations/atlassian.js';
import { slackMessageInvolvesPU } from '../src/integrations/slack.js';
import { isReadOnlyTool, extractRefs } from '../src/integrations/mcp.js';
import { stripQuoted } from '../src/integrations/types.js';
import type { Proposal } from '@wc/shared';

const dep = (id: string, result: Record<string, unknown>) => ({ id, result, status: 'executed' }) as unknown as Proposal;

describe('placeholders', () => {
  it('fills {{ticket.key}} and {{p_id.url}} from executed dependencies, recursively', () => {
    const out = fillPlaceholders({ body: 'Opened {{ticket.key}} ({{p_abc.url}})', to: ['{{ticket.key}}'] }, [dep('p_abc', { key: 'OPS-7', url: 'https://x/OPS-7' })]);
    expect(out).toEqual({ body: 'Opened OPS-7 (https://x/OPS-7)', to: ['OPS-7'] });
  });
  it('leaves unknown placeholders intact so execution can refuse them', () => {
    expect(fillPlaceholders({ b: '{{ticket.key}}' }, [])).toEqual({ b: '{{ticket.key}}' });
  });
});

describe('org chart mapping', () => {
  it('reads dot paths, Workday descriptors and column names', () => {
    const rec = { descriptor: 'Ann Lee', primaryWorkEmail: 'ANN@X.COM', businessTitle: 'Eng', primarySupervisoryOrganization: { descriptor: 'Platform' }, 'Manager Email': 'boss@x.com' };
    expect(pick(rec, 'primarySupervisoryOrganization.descriptor')).toBe('Platform');
    const [p] = mapRecords([rec], { name: 'descriptor', email: 'primaryWorkEmail', title: 'businessTitle', department: 'primarySupervisoryOrganization', managerEmail: 'Manager Email' });
    expect(p).toMatchObject({ name: 'Ann Lee', email: 'ann@x.com', department: 'Platform', managerEmail: 'boss@x.com' });
  });
  it('links managers by employee ID, resolving to the manager email', () => {
    const recs = [
      { N: 'Boss', E: 'boss@x.com', ID: '100', MID: '' },
      { N: 'Ann', E: 'ANN@x.com', ID: '101', MID: '100' },
      { N: 'Orphan', E: 'o@x.com', ID: '102', MID: '999' },
    ];
    const out = mapRecords(recs, { name: 'N', email: 'E', managerLink: 'employeeId', employeeId: 'ID', managerEmployeeId: 'MID' });
    expect(out.map((p) => p.managerEmail)).toEqual([undefined, 'boss@x.com', undefined]);
  });
  it('skips records without name or email', () => {
    expect(mapRecords([{ Name: 'x' }, { Email: 'y@z' }], { name: 'Name', email: 'Email' })).toHaveLength(0);
  });
});

describe('email', () => {
  it('parses address lists', () => {
    expect(parseAddressList('"Lee, W" <Lee@X.com>, b@y.org')).toEqual(['lee@x.com', 'b@y.org']);
  });
  it('encodes threaded replies with In-Reply-To and References', () => {
    const raw = encodeEmail({ from: 'A <a@x>', to: ['b@x'], cc: [], subject: 'Re: hi', body: 'hello', inReplyTo: '<m2@x>', references: '<m1@x>' });
    const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    expect(text).toContain('In-Reply-To: <m2@x>');
    expect(text).toContain('References: <m1@x> <m2@x>');
  });
  it('strips quoted history', () => {
    expect(stripQuoted('New text\n\nOn Mon, Bob wrote:\n> old')).toBe('New text');
  });
});

describe('atlassian ADF', () => {
  it('round-trips paragraphs and line breaks', () => {
    expect(adfToText(textToAdf('a\nb\n\nc')).trim()).toBe('a\nb\nc');
  });
});

describe('slack relevance', () => {
  const tracked = new Set(['C1:111.1']);
  it('accepts DMs, mentions and tracked-thread replies; ignores the rest', () => {
    expect(slackMessageInvolvesPU({ channel_type: 'im', user: 'U2' }, 'UPU', tracked, 'D1')).toBe(true);
    expect(slackMessageInvolvesPU({ channel_type: 'channel', user: 'U2', text: 'hey <@UPU>' }, 'UPU', tracked, 'C9')).toBe(true);
    expect(slackMessageInvolvesPU({ channel_type: 'channel', user: 'U2', thread_ts: '111.1' }, 'UPU', tracked, 'C1')).toBe(true);
    expect(slackMessageInvolvesPU({ channel_type: 'channel', user: 'U2', text: 'lunch?' }, 'UPU', tracked, 'C9')).toBe(false);
  });
});

describe('MCP tool classification', () => {
  const s = { transport: 'http' as const, readOnlyToolPatterns: ['(^|_)(get|search|list)'] };
  it('prefers annotations, then patterns', () => {
    expect(isReadOnlyTool('createJiraIssue', s)).toBe(false);
    expect(isReadOnlyTool('searchJiraIssuesUsingJql', s)).toBe(true);
    expect(isReadOnlyTool('get_thing', s, { readOnlyHint: false })).toBe(false);
    expect(isReadOnlyTool('do_it', s, { readOnlyHint: true })).toBe(true);
  });
  it('extracts ticket keys and URLs from tool output', () => {
    expect(extractRefs('Created issue OPS-42 at https://x.atlassian.net/browse/OPS-42.')).toEqual({ key: 'OPS-42', url: 'https://x.atlassian.net/browse/OPS-42' });
  });
});

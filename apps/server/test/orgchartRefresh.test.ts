import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { getOrgChartSync, refreshOrgChart } from '../src/orgchart/refresh.js';
import { missingMappedFields } from '../src/orgchart/import.js';

const mapping = { name: 'Worker', email: 'Email', title: 'Title', department: 'Org', managerEmail: 'Manager_Email' };
const settings = async () => ({ orgChart: { type: 'workday-raas', url: 'https://wd.example/report', username: 'u', passwordId: 'p', mapping } }) as any;
const secrets = { get: async () => 'pw' };
const report = (entries: any[]) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ Report_Entry: entries }), { status: 200 }));
const row = (n: string, extra: any = {}) => ({ Worker: n, Email: `${n}@x.com`, Title: 'T', Org: 'O', ...extra });

describe('org chart refresh', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    await repo.replacePeople('workday-raas', [{ name: 'Old', email: 'old@x.com' }]);
  });
  afterEach(() => vi.restoreAllMocks());
  const names = async () => (await repo.listPeople()).map((p) => p.name);

  it('replaces the org chart from the report', async () => {
    report([row('ann', { Manager_Email: 'bob@x.com' }), row('bob')]);
    const st = await refreshOrgChart({ repo, secrets, settings });
    expect(st.lastError).toBeUndefined();
    expect(await names()).toEqual(['ann', 'bob']);
    expect((await getOrgChartSync(repo)).lastCount).toBe(2);
  });
  it('keeps the existing org chart when the report is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const st = await refreshOrgChart({ repo, secrets, settings });
    expect(st.lastError).toMatch(/unreachable/);
    expect(await names()).toEqual(['Old']);
  });
  it('keeps the existing org chart on an HTTP error or empty report', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    expect((await refreshOrgChart({ repo, secrets, settings })).lastError).toMatch(/503/);
    vi.restoreAllMocks();
    report([]);
    expect((await refreshOrgChart({ repo, secrets, settings })).lastError).toMatch(/no records/);
    expect(await names()).toEqual(['Old']);
  });
  it('keeps the existing org chart when a mapped field is missing from the report', async () => {
    report([row('ann'), row('bob')]); // no Manager_Email anywhere
    const st = await refreshOrgChart({ repo, secrets, settings });
    expect(st.lastError).toMatch(/managerEmail \(Manager_Email\)/);
    expect(await names()).toEqual(['Old']);
  });
  it('does not treat a blank manager on some rows as a missing field', () => {
    expect(missingMappedFields([row('ann', { Manager_Email: 'b@x.com' }), row('bob')], mapping)).toEqual([]);
  });
});

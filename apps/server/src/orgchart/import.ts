import Papa from 'papaparse';
import type { FieldMapping, OrgChartSourceSettings, Person } from '@wc/shared';

export type PersonRow = Omit<Person, 'id' | 'source'>;

/** Read a value from a record by a mapping expression: a dot path ("manager.email") or a column name. */
export function pick(rec: any, expr?: string): string | undefined {
  if (!expr) return undefined;
  if (rec && Object.prototype.hasOwnProperty.call(rec, expr)) return str(rec[expr]);
  let cur = rec;
  for (const part of expr.split('.')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[0]?.[part] : cur[part];
  }
  return str(Array.isArray(cur) ? cur[0] : cur);
}
const str = (v: unknown) => (v == null ? undefined : typeof v === 'object' ? ((v as any).descriptor ?? (v as any).text ?? JSON.stringify(v)) : String(v).trim() || undefined);

export function mapRecords(records: any[], m: FieldMapping): PersonRow[] {
  const byId = m.managerLink === 'employeeId';
  const out: PersonRow[] = [];
  const ids: (string | undefined)[] = [];
  const managerIds: (string | undefined)[] = [];
  const emailById = new Map<string, string>();
  for (const r of records) {
    const email = pick(r, m.email)?.toLowerCase();
    const name = pick(r, m.name);
    if (!email || !name) continue;
    const id = byId ? pick(r, m.employeeId) : undefined;
    if (id) emailById.set(id, email);
    ids.push(id);
    managerIds.push(byId ? pick(r, m.managerEmployeeId) : undefined);
    out.push({ name, email, title: pick(r, m.title), department: pick(r, m.department), managerEmail: byId ? undefined : pick(r, m.managerEmail)?.toLowerCase() });
  }
  // Linking by employee ID: resolve the manager's ID to their email so the rest of the app can keep using emails.
  if (byId) out.forEach((p, i) => { const mid = managerIds[i]; if (mid) p.managerEmail = emailById.get(mid); });
  return out;
}

/**
 * Mapped columns that appear in none of the records. Workday omits empty values, so a column that is
 * absent everywhere means the report changed (renamed/removed field) rather than just being blank.
 */
export function missingMappedFields(records: any[], m: FieldMapping): string[] {
  const byId = m.managerLink === 'employeeId';
  const wanted: [string, string | undefined][] = [
    ['name', m.name], ['email', m.email], ['title', m.title], ['department', m.department],
    ...(byId ? ([['employeeId', m.employeeId], ['managerEmployeeId', m.managerEmployeeId]] as [string, string | undefined][]) : [['managerEmail', m.managerEmail] as [string, string | undefined]]),
  ];
  return wanted.filter(([, expr]) => expr && !records.some((r) => pick(r, expr) !== undefined)).map(([k, expr]) => `${k} (${expr})`);
}

export async function parseFile(filename: string, buf: Buffer): Promise<any[]> {
  if (/\.xlsx$/i.test(filename)) {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.worksheets[0];
    const headers: string[] = [];
    ws.getRow(1).eachCell((c, i) => (headers[i] = String(c.text).trim()));
    const rows: any[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const rec: Record<string, string> = {};
      row.eachCell((c, i) => headers[i] && (rec[headers[i]] = c.text));
      rows.push(rec);
    });
    return rows;
  }
  const r = Papa.parse<Record<string, string>>(buf.toString('utf8'), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  return r.data;
}

/** Workday REST (Workers API) via an API client + refresh token registered in the tenant. */
export async function fetchWorkdayRest(s: Extract<OrgChartSourceSettings, { type: 'workday-rest' }>, secret: (id: string) => Promise<string>) {
  if (!s.clientSecretId || !s.refreshTokenId) throw new Error('Workday client secret and refresh token are required');
  const host = s.host.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const tokenRes = await fetch(`https://${host}/ccx/oauth2/${s.tenant}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${s.clientId}:${await secret(s.clientSecretId)}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: await secret(s.refreshTokenId) }),
  });
  if (!tokenRes.ok) throw new Error(`Workday token: ${tokenRes.status} ${await tokenRes.text()}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const all: any[] = [];
  for (let offset = 0; offset < 50_000; offset += 100) {
    const r = await fetch(`https://${host}/ccx/api/v1/${s.tenant}/workers?limit=100&offset=${offset}`, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!r.ok) throw new Error(`Workday workers: ${r.status} ${await r.text()}`);
    const page = (await r.json()) as { data: any[]; total: number };
    all.push(...page.data);
    if (all.length >= page.total || page.data.length === 0) break;
  }
  return all;
}

/** Workday Report-as-a-Service: a custom report exposed as a web service, read with format=json. */
export async function fetchWorkdayRaas(s: Extract<OrgChartSourceSettings, { type: 'workday-raas' }>, secret: (id: string) => Promise<string>) {
  if (!s.passwordId) throw new Error('Workday RaaS password is required');
  const url = new URL(s.url);
  url.searchParams.set('format', 'json');
  let r: Response;
  try {
    r = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(`${s.username}:${await secret(s.passwordId)}`).toString('base64') }, signal: AbortSignal.timeout(60_000) });
  } catch (e: any) {
    throw new Error(`Workday report unreachable: ${e.cause?.code ?? e.message}`);
  }
  if (!r.ok) throw new Error(`Workday RaaS: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { Report_Entry?: any[] };
  return j.Report_Entry ?? [];
}

/**
 * Jira Assets (JSM) via AQL. Attribute values are returned by attribute id, so we resolve the
 * object type's attribute names and flatten each object into { "Attribute Name": value }.
 */
export async function fetchJiraAssets(
  s: Extract<OrgChartSourceSettings, { type: 'jira-assets' }>,
  auth: { email: string; token: string },
) {
  const base = `https://api.atlassian.com/jsm/assets/workspace/${s.workspaceId}/v1`;
  const headers = { Authorization: 'Basic ' + Buffer.from(`${auth.email}:${auth.token}`).toString('base64'), Accept: 'application/json', 'Content-Type': 'application/json' };
  const out: any[] = [];
  const attrNames = new Map<string, string>();
  for (let startAt = 0; startAt < 50_000; startAt += 100) {
    const r = await fetch(`${base}/object/aql?startAt=${startAt}&maxResults=100&includeAttributes=true`, { method: 'POST', headers, body: JSON.stringify({ qlQuery: s.aql }) });
    if (!r.ok) throw new Error(`Jira Assets AQL: ${r.status} ${await r.text()}`);
    const page = (await r.json()) as { values: any[]; isLast?: boolean };
    for (const o of page.values) {
      const typeId = o.objectType?.id;
      if (typeId && ![...attrNames.keys()].some((k) => k.startsWith(`${typeId}:`))) {
        const a = await fetch(`${base}/objecttype/${typeId}/attributes`, { headers });
        if (a.ok) for (const at of (await a.json()) as any[]) attrNames.set(`${typeId}:${at.id}`, at.name);
      }
      const rec: Record<string, string> = { Name: o.label };
      for (const at of o.attributes ?? []) {
        const name = attrNames.get(`${typeId}:${at.objectTypeAttributeId}`) ?? at.objectTypeAttributeId;
        const v = at.objectAttributeValues?.[0];
        rec[name] = v?.referencedObject?.label ?? v?.user?.emailAddress ?? v?.displayValue ?? v?.value ?? '';
        // A manager reference often points to another person object; capture its email too.
        if (v?.referencedObject?.attributes) {
          for (const ra of v.referencedObject.attributes) {
            const rv = ra.objectAttributeValues?.[0]?.value;
            if (typeof rv === 'string' && rv.includes('@')) rec[`${name}.email`] = rv;
          }
        }
        if (v?.user?.emailAddress) rec[`${name}.email`] = v.user.emailAddress;
      }
      out.push(rec);
    }
    if (page.isLast !== false || page.values.length === 0) break;
  }
  return out;
}

export const DEFAULT_MAPPINGS: Record<Exclude<OrgChartSourceSettings['type'], 'none'>, FieldMapping> = {
  'workday-rest': { name: 'descriptor', email: 'primaryWorkEmail', title: 'businessTitle', department: 'primarySupervisoryOrganization.descriptor', managerEmail: 'manager.primaryWorkEmail' },
  'workday-raas': { name: 'Worker', email: 'Email_-_Primary_Work', title: 'businessTitle', department: 'Supervisory_Organization', managerEmail: 'Manager_Email', employeeId: 'Employee_ID', managerEmployeeId: 'Manager_Employee_ID', managerLink: 'email' },
  file: { name: 'Name', email: 'Email', title: 'Title', department: 'Department', managerEmail: 'Manager Email' },
  'jira-assets': { name: 'Name', email: 'Email', title: 'Title', department: 'Department', managerEmail: 'Manager.email' },
};

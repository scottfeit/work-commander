import type { OrgChartSyncStatus, Settings } from '@wc/shared';
import type { Repo } from '../core/repo.js';
import type { SecretStore } from '../secrets/store.js';
import { fetchWorkdayRaas, mapRecords, missingMappedFields } from './import.js';

export const SYNC_KEY = 'orgchart.sync';
const DEFAULT_HOURS = 24;
const RETRY_AFTER_FAILURE_MS = 3600_000;

export async function getOrgChartSync(repo: Repo): Promise<OrgChartSyncStatus> {
  try {
    return JSON.parse((await repo.getSync(SYNC_KEY)) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Re-pull the Workday report and replace the Workday people. Everything is fetched, mapped and validated
 * first; the stored org chart is only touched once the new data is known to be good, so any failure
 * leaves it exactly as it was.
 */
export async function refreshOrgChart(deps: { repo: Repo; secrets: Pick<SecretStore, 'get'>; settings: () => Promise<Settings> }): Promise<OrgChartSyncStatus> {
  const oc = (await deps.settings()).orgChart;
  if (oc.type !== 'workday-raas') throw new Error('The org chart source is not a Workday report');
  const prev = await getOrgChartSync(deps.repo);
  const status: OrgChartSyncStatus = { ...prev, lastAttemptAt: new Date().toISOString() };
  try {
    const records = await fetchWorkdayRaas(oc, (id) => deps.secrets.get(id));
    if (records.length === 0) throw new Error('The report returned no records');
    const missing = missingMappedFields(records, oc.mapping);
    if (missing.length) throw new Error(`The report has no values for mapped field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    const people = mapRecords(records, oc.mapping);
    if (people.length === 0) throw new Error('No report records have both a name and an email');
    await deps.repo.replacePeople('workday-raas', people);
    delete status.lastError;
    status.lastSuccessAt = status.lastAttemptAt;
    status.lastCount = people.length;
  } catch (e: any) {
    status.lastError = e.message;
  }
  await deps.repo.setSync(SYNC_KEY, JSON.stringify(status));
  return status;
}

/** Periodically refreshes the org chart while a Workday report is the configured source. */
export class OrgChartRefresher {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private deps: { repo: Repo; secrets: Pick<SecretStore, 'get'>; settings: () => Promise<Settings> },
    private log: (msg: string) => void = () => undefined,
  ) {}
  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const oc = (await this.deps.settings()).orgChart;
      if (oc.type !== 'workday-raas' || !oc.url || !oc.passwordId) return;
      const hours = Math.max(1, Number(oc.updateEveryHours) || DEFAULT_HOURS);
      const st = await getOrgChartSync(this.deps.repo);
      const every = st.lastError ? Math.min(hours * 3600_000, RETRY_AFTER_FAILURE_MS) : hours * 3600_000;
      if (st.lastAttemptAt && Date.now() - Date.parse(st.lastAttemptAt) < every) return;
      const r = await refreshOrgChart(this.deps);
      if (r.lastError) this.log(`org chart refresh failed (existing org chart kept): ${r.lastError}`);
    } catch (e: any) {
      this.log(`org chart refresh: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}

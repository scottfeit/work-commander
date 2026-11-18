import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { McpPollIngestor } from '../src/agent/mcpIngest.js';

const KEY = 'mcp.slack.since';
const OLD = '2026-11-17T22:40:00.000Z';

describe('the Slack "since" bookmark', () => {
  let repo: Repo;
  let asked: string[];
  let statuses: string[];
  const make = (mcpDirect: boolean) => {
    // An MCP server that cannot be reached: the direct read fails at once, and Claude (a stand-in) is asked instead.
    const s = { ...defaultSettings() };
    s.slack = { ...s.slack, enabled: true, mode: 'mcp', mcpDirect, mcp: { transport: 'http', url: 'http://127.0.0.1:1/mcp' } } as any;
    const backend = { structured: async (a: any) => (asked.push(a.prompt), { items: [] }) } as any;
    return new McpPollIngestor('slack', backend, async () => s, { get: async () => '' } as any, repo, async () => undefined, (ok, msg) => statuses.push(`${ok}:${msg}`));
  };
  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    await repo.setSync(KEY, OLD);
    asked = [];
    statuses = [];
  });

  it('stays where it was when the direct read fails and Claude does the check instead', async () => {
    await make(true).pollOnce();
    expect(asked).toHaveLength(1); // Claude was asked
    expect(await repo.getSync(KEY)).toBe(OLD); // ...but the window is still open
    expect(statuses[0]).toMatch(/read again next time/);
  });

  it('moves forward when Claude is the only way to read (direct reads turned off)', async () => {
    await make(false).pollOnce();
    expect(asked).toHaveLength(1);
    expect(await repo.getSync(KEY)).not.toBe(OLD);
    expect(statuses[0]).not.toMatch(/read again/);
  });
});

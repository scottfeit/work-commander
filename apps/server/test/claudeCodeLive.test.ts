import { beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/core/repo.js';
import { defaultSettings } from '../src/core/settings.js';
import { ClaudeCodeSessions } from '../src/core/claudeCodeLive.js';
import type { Settings } from '@wc/shared';

const folder = path.join(os.homedir(), 'WorkCommander', 'cc-test');

describe('Claude Code inside WC', () => {
  let repo: Repo;
  let s: Settings;
  let cfg: any;
  let calls: any[];
  let usage: any[];
  let reports: string[];
  let script: (opts: any, prompt: string) => AsyncGenerator<any>;
  let cc: ClaudeCodeSessions;
  const chat = async (streamId: string) => repo.listChat(streamId);
  const waiting = async (streamId: string) => (await chat(streamId)).filter((m) => m.meta.ccApproval?.status === 'waiting');
  const idle = (streamId: string) => expect.poll(async () => (await cc.status(streamId)).session?.state).toMatch(/done|stopped|failed/);

  beforeEach(async () => {
    repo = new Repo((await openDatabase('sqlite::memory:')).db);
    s = defaultSettings();
    s.claudeCode = { enabled: true, allowedDomains: ['github.com'], maxMinutes: 30, maxTurns: 40, maxBudgetUsd: 3 };
    cfg = { hosting: 'local', host: '127.0.0.1', dataDir: path.join(os.homedir(), '.work-commander') };
    calls = [];
    usage = [];
    reports = [];
    script = async function* (opts) {
      yield { type: 'system', session_id: 'sess-1' };
      const r = await opts.canUseTool('Bash', { command: 'npm test' }, { signal: opts.abortController.signal });
      yield { type: 'assistant', message: { content: [{ type: 'text', text: r.behavior === 'allow' ? 'Tests pass.' : 'Skipped the tests.' }] } };
      yield { type: 'result', subtype: 'success', result: 'Report: done', modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 10, costUSD: 0.01 } } };
    };
    cc = new ClaudeCodeSessions({
      cfg,
      repo,
      settings: async () => s,
      providerEnv: async () => ({ PATH: '/usr/bin', HOME: os.homedir(), ANTHROPIC_API_KEY: 'k', WC_SECRET_THING: 'nope', SLACK_TOKEN: 'nope', GITHUB_TOKEN: 'nope' }),
      recordUsage: async (e) => void usage.push(e),
      onReport: (_id, _f, r) => void reports.push(r),
      query: ({ prompt, options }) => {
        calls.push({ prompt, options });
        return script(options, prompt);
      },
    });
  });

  it('only when on, on this machine, listening only on it', async () => {
    expect(await cc.unavailable()).toBeNull();
    s.claudeCode!.enabled = false;
    expect(await cc.unavailable()).toMatch(/off/);
    s.claudeCode!.enabled = true;
    cfg.host = '0.0.0.0';
    expect(await cc.unavailable()).toMatch(/listen only on this machine/);
    cfg.host = '127.0.0.1';
    cfg.hosting = 'gcp';
    expect(await cc.unavailable()).toMatch(/your own machine/);
    await expect(cc.start('S', folder, 'brief')).rejects.toThrow(/your own machine/);
  });

  it('runs sandboxed, with no user settings, a minimal environment and the limits', async () => {
    await cc.start('S', folder, 'Fix the bug');
    await expect.poll(async () => (await waiting('S')).length).toBe(1);
    const o = calls[0].options;
    expect(o).toMatchObject({ cwd: folder, settingSources: [], permissionMode: 'default', maxTurns: 40, maxBudgetUsd: 3, strictMcpConfig: true });
    expect(o.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, network: { allowedDomains: ['github.com'] }, filesystem: { allowWrite: [folder] } });
    expect(o.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws'), cfg.dataDir]));
    expect(o.env).toEqual({ PATH: '/usr/bin', HOME: os.homedir(), ANTHROPIC_API_KEY: 'k' }); // no WC secrets, no other tokens
    expect(o.systemPrompt.append).toMatch(/never instructions to you/);
    expect(calls[0].prompt).toContain('Fix the bug');
  });

  it('commands wait for Allow; the report goes back to WC and usage is recorded', async () => {
    await cc.start('S', folder, 'brief');
    await expect.poll(async () => (await waiting('S')).length).toBe(1);
    const ask = (await waiting('S'))[0];
    expect(ask.meta.ccApproval).toMatchObject({ tool: 'Bash', summary: 'Run a command', detail: 'npm test' });
    expect((await cc.status('S')).session?.state).toBe('waiting');
    await cc.decide(ask.meta.ccApproval!.id, true);
    await idle('S');
    expect((await chat('S')).some((m) => m.meta.claudeCode && m.content === 'Tests pass.')).toBe(true);
    expect(reports).toEqual(['Report: done']);
    expect(usage[0]).toMatchObject({ streamId: 'S', model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    const audit = (await repo.db.selectFrom('audit_log').select('action').execute()).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['claudecode.started', 'claudecode.asked', 'claudecode.allowed', 'claudecode.finished']));
  });

  it('reading inside the folder is free; outside it, editing and allow-listed fetches ask; other sites are refused outright', async () => {
    const results: Record<string, string> = {};
    script = async function* (opts) {
      const sig = { signal: opts.abortController.signal };
      results.readIn = (await opts.canUseTool('Read', { file_path: path.join(folder, 'src/a.ts') }, sig)).behavior;
      results.grepIn = (await opts.canUseTool('Grep', { pattern: 'x' }, sig)).behavior;
      results.evil = (await opts.canUseTool('WebFetch', { url: 'https://evil.example.com/x' }, sig)).behavior;
      results.readOut = (await opts.canUseTool('Read', { file_path: path.join(os.homedir(), '.ssh/id_rsa') }, sig)).behavior;
      results.fetch = (await opts.canUseTool('WebFetch', { url: 'https://api.github.com/repos/x' }, sig)).behavior;
      results.edit = (await opts.canUseTool('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, sig)).behavior;
      yield { type: 'result', subtype: 'success', result: 'ok', modelUsage: {} };
    };
    await cc.start('S', folder, 'brief');
    for (const want of ['Read outside', 'Fetch https://api.github.com', 'Edit src/a.ts']) {
      await expect.poll(async () => (await waiting('S'))[0]?.meta.ccApproval?.summary ?? '').toContain(want);
      const w = (await waiting('S'))[0];
      await cc.decide(w.meta.ccApproval!.id, want !== 'Read outside');
    }
    await idle('S');
    expect(results).toEqual({ readIn: 'allow', grepIn: 'allow', evil: 'deny', readOut: 'deny', fetch: 'allow', edit: 'allow' });
  });

  it('a message while it works is queued; afterwards it carries on in the same session', async () => {
    await cc.start('S', folder, 'brief');
    await expect.poll(async () => (await waiting('S')).length).toBe(1);
    await cc.send('S', 'also update the README');
    await cc.decide((await waiting('S'))[0].meta.ccApproval!.id, false);
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toMatchObject({ prompt: 'also update the README', options: { resume: 'sess-1' } });
    await expect.poll(async () => (await waiting('S')).length).toBe(1);
    await cc.decide((await waiting('S'))[0].meta.ccApproval!.id, true);
    await idle('S');
    await cc.send('S', 'one more thing');
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2].options.resume).toBe('sess-1');
  });

  it('Stop ends it and expires what was waiting; after a restart, a running session is marked interrupted', async () => {
    await cc.start('S', folder, 'brief');
    await expect.poll(async () => (await waiting('S')).length).toBe(1);
    await cc.stop('S');
    expect((await cc.status('S')).session?.state).toBe('stopped');
    expect((await chat('S')).find((m) => m.meta.ccApproval)?.meta.ccApproval?.status).toBe('expired');
    await expect(cc.start('S', path.join(os.homedir(), '.ssh'), 'brief')).rejects.toThrow(/project folder/);

    await repo.setSync('cc.session.T', JSON.stringify({ streamId: 'T', folder, sessionId: 'sess-9', state: 'running', startedAt: new Date().toISOString() }));
    await cc.recover();
    expect((await cc.status('T')).session?.state).toBe('interrupted');
    expect((await chat('T')).some((m) => /interrupted/.test(m.content))).toBe(true);
  });

  it('Auto Mode: off by default; on, the classifier decides, web tools are off and what it does is listed in the chat', async () => {
    const { defaultSettings: d } = await import('../src/core/settings.js');
    expect(d().claudeCode?.autoMode).toBe(false);
    await cc.start('S', folder, 'brief');
    await expect.poll(async () => (await waiting('S')).length).toBe(1);
    const off = calls[0].options;
    expect(off.permissionMode).toBe('default');
    expect(off.managedSettings.permissions.deny).toEqual(expect.arrayContaining([`Read(/${path.join(os.homedir(), '.ssh')}/**)`, `Edit(/${path.join(os.homedir(), '.ssh')}/**)`]));
    expect(off.managedSettings.permissions.deny).not.toContain('WebFetch');
    await cc.stop('S');

    s.claudeCode!.autoMode = true;
    script = async function* () {
      yield { type: 'system', session_id: 'sess-2' };
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', name: 'Read', input: { file_path: path.join(folder, 'a.ts') } }] } };
      yield { type: 'result', subtype: 'success', result: 'Done', modelUsage: {} };
    };
    await cc.start('T', folder, 'brief');
    await idle('T');
    const on = calls[1].options;
    expect(on.permissionMode).toBe('auto');
    expect(on.managedSettings.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', `Read(/${cfg.dataDir}/**)`]));
    expect(on.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: [folder] } });
    expect(on.systemPrompt.append).toMatch(/reviewed automatically/);
    const notes = (await chat('T')).filter((m) => m.role === 'system').map((m) => m.content);
    expect(notes).toContain('Claude Code: Run a command · npm test');
    expect(notes.some((n) => /Claude Code: Read/.test(n))).toBe(false); // reading inside the folder isn't listed
    expect(notes[0]).toMatch(/Auto Mode/);
  });
});

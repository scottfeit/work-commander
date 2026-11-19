import { describe, expect, it } from 'vitest';
import { explainingFetch, slackClient } from '../src/integrations/slackClient.js';

const failing = (calls: { n: number }) =>
  (async () => {
    calls.n++;
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  }) as unknown as typeof fetch;

describe('the Slack client', () => {
  it('says why a request failed, not just "fetch failed"', async () => {
    const calls = { n: 0 };
    await expect(explainingFetch(failing(calls))('https://slack.com/api/auth.test')).rejects.toThrow('fetch failed: ECONNRESET');
  });

  it('gives up after a few quick retries instead of retrying for half an hour', async () => {
    const calls = { n: 0 };
    const started = Date.now();
    const c = slackClient('xoxp-test', { retries: 2, minTimeout: 1, maxTimeout: 5, fetch: failing(calls) });
    await expect(c.auth.test()).rejects.toThrow(/ECONNRESET/);
    expect(calls.n).toBe(3); // the first try and two retries
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a request that never answers is cut off at the timeout', async () => {
    const hang = ((_: unknown, init: RequestInit) => new Promise((_ok, no) => init.signal?.addEventListener('abort', () => no(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    await expect(slackClient('xoxp-test', { timeout: 50, retries: 0, fetch: hang }).auth.test()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

import { WebClient, type WebClientOptions } from '@slack/web-api';

/** Slack's client waits ~30 minutes (ten retries) on a failing connection and has no request timeout, so a network hiccup looked like a hang. */
export interface SlackClientOptions {
  /** Per request, in ms. */
  timeout?: number;
  /** Retries after the first attempt, on connection errors and rate limits. */
  retries?: number;
  minTimeout?: number;
  maxTimeout?: number;
  fetch?: WebClientOptions['fetch'];
}

/** fetch, but a failure says why ("fetch failed: ECONNRESET") instead of just "fetch failed". */
export function explainingFetch(base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  return async (input, init) => {
    try {
      return await base(input, init);
    } catch (e: any) {
      const c = e?.cause;
      const why = c?.code ?? c?.message ?? (e?.name === 'TimeoutError' ? 'timed out' : undefined);
      throw why && !String(e?.message).includes(String(why)) ? Object.assign(new Error(`${e.message}: ${why}`), { cause: c ?? e }) : e;
    }
  };
}

/** A Slack client that gives up in seconds, not half an hour: a few quick retries, 20 s per request. Polls try again on their next cycle. */
export function slackClient(token: string, o: SlackClientOptions = {}) {
  return new WebClient(token, {
    timeout: o.timeout ?? 20_000,
    retryConfig: { retries: o.retries ?? 3, factor: 2, minTimeout: o.minTimeout ?? 1000, maxTimeout: o.maxTimeout ?? 8000, randomize: true },
    fetch: explainingFetch((o.fetch as typeof fetch | undefined) ?? undefined),
  });
}

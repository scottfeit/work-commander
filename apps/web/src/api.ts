import { useEffect, useRef } from 'react';
import type { ServerEvent } from '@wc/shared';

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const r = await fetch(path, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const put = <T = any>(p: string, b?: unknown) => api<T>('PUT', p, b);
export const patch = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

/** Subscribe to the server's event stream; reconnects automatically. */
export function useServerEvents(onEvent: (e: ServerEvent) => void, onReconnect?: () => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const re = useRef(onReconnect);
  re.current = onReconnect;
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: number | undefined;
    let first = true;
    let boot: string | null = null;
    const connect = () => {
      es = new EventSource('/api/events');
      es.onopen = () => {
        if (!first) re.current?.();
        first = false;
      };
      // The server announces a per-process id; if it changes, it restarted and this page's state is stale.
      es.addEventListener('boot', (m) => {
        const id = (m as MessageEvent).data as string;
        if (boot && boot !== id) location.reload();
        boot = id;
      });
      es.onmessage = (m) => handler.current(JSON.parse(m.data));
      es.onerror = () => {
        es?.close();
        retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(retry);
    };
  }, []);
}

export function timeAgo(iso?: string | null) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

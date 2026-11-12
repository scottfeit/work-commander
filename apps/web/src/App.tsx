import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, EnvironmentInfo, Proposal, ServerEvent, StreamItem, WorkStream } from '@wc/shared';
import { GENERAL_STREAM } from '@wc/shared';
import { get, patch, post, useServerEvents } from './api';
import { StreamList } from './components/StreamList';
import { TabBar, OVERVIEW_TAB, orderTabs } from './components/TabBar';
import { ItemView, StreamOverview } from './components/ItemView';
import { ChatPane } from './components/ChatPane';
import { DraftPane } from './components/DraftPane';
import { Toasts, type Toast } from './components/Toasts';
import { SettingsPage } from './settings/SettingsPage';

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const nav = useCallback((p: string) => {
    history.pushState(null, '', p);
    setPath(p);
  }, []);
  return [path, nav] as const;
}

export function App() {
  const [path, nav] = usePath();
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [streams, setStreams] = useState<WorkStream[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [selected, setSelected] = useState<string>(GENERAL_STREAM);
  const [items, setItems] = useState<StreamItem[]>([]);
  const [tab, setTab] = useState<string>(OVERVIEW_TAB);
  // A skipped item being looked at: shown as a temporary tab, gone as soon as you navigate away or dismiss it.
  const [peek, setPeek] = useState<StreamItem | null>(null);
  const [skippedVersion, setSkippedVersion] = useState(0);
  const [recentTabFirst, setRecentTabFirst] = useState(false);
  const [focusDraft, setFocusDraft] = useState<string | null>(null);
  const openTabRef = useRef<'overview' | 'recent'>('overview');
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Proposal[]>([]);
  const [live, setLive] = useState<{ runId: string; text: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [split, setSplit] = useState(() => Number(localStorage.getItem('wc.split') ?? 0.52));
  const selRef = useRef(selected);
  selRef.current = selected;
  const sidOf = (streamId: string | null) => streamId ?? GENERAL_STREAM;

  const loadStreams = useCallback(async () => setStreams(await get<WorkStream[]>(`/api/streams?includeClosed=${showClosed ? 1 : 0}`)), [showClosed]);
  const loadSelected = useCallback(async (id: string) => {
    const [it, ch, pr] = await Promise.all([
      id === GENERAL_STREAM ? Promise.resolve([] as StreamItem[]) : get<StreamItem[]>(`/api/streams/${id}/items`),
      get<ChatMessage[]>(`/api/streams/${id}/chat`),
      get<Proposal[]>(`/api/proposals?streamId=${id}&status=pending`),
    ]);
    if (selRef.current !== id) return;
    setItems(it);
    setChat(ch);
    setDrafts(pr);
    return it;
  }, []);

  useEffect(() => {
    get<EnvironmentInfo>('/api/env').then(setEnv).catch(() => undefined);
    get('/api/settings').then((s) => {
      setShowClosed(!!s.ui?.showClosedByDefault);
      if (!s.setupComplete && location.pathname === '/') nav('/settings');
    });
  }, [nav]);
  useEffect(() => void loadStreams(), [loadStreams]);
  // The tab-order setting can change on the settings page, so re-read it whenever the page changes.
  useEffect(() => {
    get('/api/settings')
      .then((s) => {
        setRecentTabFirst(!!s.ui?.recentTabFirst);
        openTabRef.current = s.ui?.openTab === 'recent' ? 'recent' : 'overview';
      })
      .catch(() => undefined);
  }, [path]);
  useEffect(() => {
    if (peek && tab !== peek.id) setPeek(null);
  }, [tab, peek]);
  const openSkipped = useCallback(async (id: string) => {
    try {
      const it = await get<StreamItem>(`/api/items/${id}`);
      setPeek(it);
      setTab(it.id);
    } catch {
      /* gone */
    }
  }, []);
  // Mark a work stream unread. If it is the one open, step back to the overview so its dot is visible.
  const markUnread = useCallback(async (id: string) => {
    await patch(`/api/streams/${id}`, { unread: true }).catch(() => undefined);
    if (id === selRef.current) setSelected(GENERAL_STREAM);
  }, []);
  const closePeek = useCallback(() => {
    setPeek(null);
    setTab(OVERVIEW_TAB);
  }, []);
  const dismissPeek = useCallback(async () => {
    if (!peek) return;
    await post(`/api/items/${peek.id}/dismiss`).catch(() => undefined);
    closePeek();
    setSkippedVersion((v) => v + 1);
  }, [peek, closePeek]);
  useEffect(() => {
    setLive(null);
    setTab(OVERVIEW_TAB);
    void loadSelected(selected).then((it) => {
      // Setting: open a work stream on its most recently updated item tab instead of the Overview.
      if (!it?.length || selRef.current !== selected || selected === GENERAL_STREAM || openTabRef.current !== 'recent') return;
      setTab(it.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id);
    });
    if (selected !== GENERAL_STREAM) void patch(`/api/streams/${selected}`, { unread: false }).catch(() => undefined);
  }, [selected, loadSelected]);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((x) => [...x, { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 7000);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(t.title, { body: t.body });
  }, []);

  // The + on the tab bar: add a work item from a pasted link, show it, and Claude reviews it in the background.
  const addByUrl = useCallback(async (url: string) => {
    const id = selRef.current;
    const r = await post<{ item: StreamItem }>(`/api/streams/${id}/items/from-url`, { url });
    if (selRef.current !== id) return;
    setItems((xs) => (xs.some((x) => x.id === r.item.id) ? xs.map((x) => (x.id === r.item.id ? r.item : x)) : [...xs, r.item]));
    setTab(r.item.id);
  }, []);

  // Quick Reply: open (or jump to) a blank, pre-addressed draft for this item without asking Claude.
  const quickReply = useCallback(
    async (item: StreamItem) => {
      try {
        const r = await post<{ proposal: Proposal }>(`/api/items/${item.id}/quick-reply`);
        setDrafts((xs) => (xs.some((x) => x.id === r.proposal.id) ? xs : [...xs, r.proposal].sort((a, b) => a.createdAt.localeCompare(b.createdAt))));
        setFocusDraft(r.proposal.id);
      } catch (e: any) {
        toast({ title: 'Quick reply', body: e.message, tone: 'error' });
      }
    },
    [toast],
  );

  useServerEvents(
    (e: ServerEvent) => {
      const cur = selRef.current;
      switch (e.type) {
        case 'stream.updated':
          setStreams((xs) => {
            const without = xs.filter((x) => x.id !== e.stream.id);
            if (e.stream.status === 'closed' && !showClosed) return without;
            return [e.stream, ...without].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
          });
          break;
        case 'item.updated':
          if (e.item.streamId === null) setPeek((p) => (p && p.id === e.item.id ? e.item : p));
          if (e.item.streamId !== cur) setItems((xs) => xs.filter((x) => x.id !== e.item.id));
          else setItems((xs) => (xs.some((x) => x.id === e.item.id) ? xs.map((x) => (x.id === e.item.id ? e.item : x)) : [...xs, e.item]));
          break;
        case 'proposal.updated':
          if (sidOf(e.proposal.streamId) === cur)
            setDrafts((xs) => {
              const rest = xs.filter((x) => x.id !== e.proposal.id);
              return e.proposal.status === 'pending' ? [...rest, e.proposal].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : rest;
            });
          if (e.proposal.status === 'failed') toast({ title: 'Action failed', body: `${e.proposal.title}: ${e.proposal.error}`, tone: 'error' });
          if (e.proposal.status === 'executed') toast({ title: 'Done', body: e.proposal.title, tone: 'ok' });
          break;
        case 'chat.message':
          if (sidOf(e.message.streamId) === cur) {
            setChat((xs) => (xs.some((x) => x.id === e.message.id) ? xs.map((x) => (x.id === e.message.id ? e.message : x)) : [...xs, e.message]));
            if (e.message.role === 'assistant') setLive(null);
          }
          break;
        case 'chat.delta':
          if (sidOf(e.streamId) === cur) setLive((l) => (l && l.runId === e.runId ? { runId: l.runId, text: l.text + e.text } : { runId: e.runId, text: e.text }));
          break;
        case 'run.state':
          if (sidOf(e.streamId) === cur && e.state !== 'running') setLive(null);
          break;
        case 'notify':
          toast({ title: e.title, body: e.body, streamId: e.streamId ?? undefined, tone: 'info' });
          break;
      }
    },
    () => {
      void loadStreams();
      void loadSelected(selRef.current);
    },
  );

  const stream = useMemo(() => streams.find((s) => s.id === selected) ?? null, [streams, selected]);
  const tabItems = useMemo(() => orderTabs(items, recentTabFirst), [items, recentTabFirst]);
  const selectedItem = items.find((i) => i.id === tab) ?? (peek && tab === peek.id ? peek : null);
  const selectedIsPeek = !!selectedItem && !items.some((i) => i.id === selectedItem.id);
  // Opening a tab (or new activity arriving on the open one) clears its dot.
  const viewedUnread = !selectedIsPeek && selectedItem?.data.unread ? selectedItem.id : null;
  useEffect(() => {
    if (!viewedUnread) return;
    setItems((xs) => xs.map((x) => (x.id === viewedUnread ? { ...x, data: { ...x.data, unread: undefined } } : x)));
    void post(`/api/items/${viewedUnread}/read`).catch(() => undefined);
  }, [viewedUnread]);
  const reorderTabs = useCallback(
    (id: string, targetId: string, after: boolean) => {
      const ids = tabItems.map((i) => i.id).filter((x) => x !== id);
      const at = ids.indexOf(targetId) + (after ? 1 : 0);
      ids.splice(at, 0, id);
      // Show it at once, then remember it.
      const stamp = new Date().toISOString();
      setItems((xs) => xs.map((x) => (ids.includes(x.id) ? { ...x, data: { ...x.data, tabOrder: ids.indexOf(x.id), tabOrderAt: stamp } } : x)));
      void post(`/api/streams/${selRef.current}/item-order`, { ids }).catch(() => undefined);
    },
    [tabItems],
  );
  const running = selected === GENERAL_STREAM ? !!live : stream?.runState === 'running' || !!live;

  // Drag the divider between the top pane and the bottom panes.
  const mainRef = useRef<HTMLDivElement>(null);
  const startDrag = (ev: React.MouseEvent) => {
    ev.preventDefault();
    const move = (m: MouseEvent) => {
      const r = mainRef.current!.getBoundingClientRect();
      const v = Math.min(0.8, Math.max(0.2, (m.clientY - r.top) / r.height));
      setSplit(v);
      localStorage.setItem('wc.split', String(v));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (path.startsWith('/settings')) return <SettingsPage env={env} onBack={() => nav('/')} />;

  return (
    <div className="app">
      <StreamList
        streams={streams}
        selected={selected}
        onSelect={setSelected}
        showClosed={showClosed}
        onToggleClosed={() => setShowClosed((v) => !v)}
        onSettings={() => nav('/settings')}
        demo={!!env?.demoMode}
        onOpenSkipped={(id) => void openSkipped(id)}
        onSkippedDismissed={(ids) => peek && ids.includes(peek.id) && closePeek()}
        skippedVersion={skippedVersion}
        peekId={peek?.id ?? null}
        onMarkUnread={(id) => void markUnread(id)}
        onCloseStream={(id) => void patch(`/api/streams/${id}`, { status: 'closed' })}
        onTogglePending={(id, pending) => void patch(`/api/streams/${id}`, { pending })}
      />
      <main className="main" ref={mainRef} style={{ gridTemplateRows: `auto ${split}fr 6px ${1 - split}fr` }}>
        <TabBar stream={stream} items={tabItems} tab={tab} onTab={setTab} peek={peek} onClosePeek={closePeek} onReorder={reorderTabs} onAddUrl={stream ? addByUrl : undefined} />
        <section className="top-pane">
          {selectedItem ? (
            <ItemView item={selectedItem} peek={selectedIsPeek} onDismiss={() => void dismissPeek()} onRemoved={() => setTab(OVERVIEW_TAB)} onQuickReply={(it) => void quickReply(it)} />
          ) : selected === GENERAL_STREAM ? (
            <div className="empty-state">
              <h2>All open work</h2>
              <p>
                {streams.filter((s) => s.status === 'open').length} open work streams,{' '}
                {streams.reduce((n, s) => n + s.pendingProposals, 0)} drafts waiting for you. Pick a stream on the left, or ask Claude below about anything across them.
              </p>
            </div>
          ) : stream ? (
            <StreamOverview stream={stream} items={items} onOpen={setTab} onMarkUnread={() => void markUnread(stream.id)} onTogglePending={() => void patch(`/api/streams/${stream.id}`, { pending: !stream.pending })} />
          ) : null}
        </section>
        <div className="divider" onMouseDown={startDrag} title="Drag to resize" />
        <section className={`bottom ${drafts.length ? 'with-drafts' : ''}`}>
          <ChatPane
            streamId={selected}
            streamTitle={stream?.title ?? 'All open work'}
            selectedItem={selectedItem}
            messages={chat}
            live={live?.text ?? null}
            running={running}
          />
          {drafts.length > 0 && (
            <DraftPane
              drafts={drafts}
              focusId={focusDraft}
              onFocused={() => setFocusDraft(null)}
              onDecided={(p) => {
                setDrafts((xs) => (p.status === 'pending' ? xs.map((x) => (x.id === p.id ? p : x)) : xs.filter((x) => x.id !== p.id)));
                // Once it has run, the server has re-fetched the thread/ticket: reload so the item tab shows what was sent.
                if (p.status === 'executed' || p.status === 'failed') void loadSelected(selRef.current);
              }}
              onStale={() => void loadSelected(selRef.current)}
            />
          )}
        </section>
      </main>
      <Toasts toasts={toasts} onOpen={(id) => setSelected(id)} onDismiss={(id) => setToasts((x) => x.filter((y) => y.id !== id))} />
    </div>
  );
}

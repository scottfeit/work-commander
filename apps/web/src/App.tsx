import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, EnvironmentInfo, PollingState, Proposal, ServerEvent, StreamItem, UndoInfo, WorkStream } from '@wc/shared';
import { GENERAL_STREAM } from '@wc/shared';
import { get, patch, post, useServerEvents } from './api';
import { StreamList } from './components/StreamList';
import { TabBar, OVERVIEW_TAB, orderTabs } from './components/TabBar';
import { ItemView, StreamOverview } from './components/ItemView';
import { ChatPane } from './components/ChatPane';
import { DraftPane } from './components/DraftPane';
import { Toasts, type Toast } from './components/Toasts';
import { Shortcuts } from './components/Shortcuts';
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
  const [confirmClose, setConfirmClose] = useState(true);
  const [keepDraftsOpen, setKeepDraftsOpen] = useState(false);
  // System-wide Undo: what it would reverse next, and whether to say what it undid (Settings → Display).
  const [undoInfo, setUndoInfo] = useState<UndoInfo>({ next: null, count: 0 });
  const [polling, setPolling] = useState<PollingState>({ paused: null, held: 0, catchingUp: false });
  const undoToastRef = useRef(true);
  const [focusDraft, setFocusDraft] = useState<string | null>(null);
  const openTabRef = useRef<'overview' | 'recent'>('overview');
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Proposal[]>([]);
  const [live, setLive] = useState<{ runId: string; text: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** Today's usage passed the daily budget (Settings → Usage); shown until dismissed. */
  const [usageAlert, setUsageAlert] = useState<{ day: string; message: string } | null>(null);
  useEffect(() => {
    get<{ alert: { day: string; message: string } | null }>('/api/usage?days=1').then((r) => setUsageAlert(r.alert), () => undefined);
  }, []);
  const dismissUsageAlert = () => {
    setUsageAlert(null);
    void post('/api/usage/dismiss').catch(() => undefined);
  };
  const [split, setSplit] = useState(() => Number(localStorage.getItem('wc.split') ?? 0.52));
  // Share of the top area's width the Overview pane takes (drag the line between it and the item to change it).
  const [ovSplit, setOvSplit] = useState(() => {
    const v = Number(localStorage.getItem('wc.ovSplit'));
    return v >= 0.15 && v <= 0.75 ? v : 1 / 3;
  });
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
        setConfirmClose(s.ui?.confirmClose !== false);
        setKeepDraftsOpen(!!s.ui?.keepDraftsOpen);
        undoToastRef.current = s.ui?.undoToast !== false;
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
  // Mark a work stream unread. If it is the one open, step back to All open work so its dot is visible.
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
    await post(`/api/items/${peek.id}/${peek.data.proposedStream ? 'decline' : 'dismiss'}`).catch(() => undefined);
    closePeek();
    setSkippedVersion((v) => v + 1);
  }, [peek, closePeek]);
  useEffect(() => {
    setLive(null);
    setTab(OVERVIEW_TAB);
    void loadSelected(selected).then((it) => {
      // Setting: open a work stream on its most recently updated item tab instead of the first one.
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
        case 'stream.deleted':
          setStreams((xs) => xs.filter((x) => x.id !== e.streamId));
          // You emptied the stream you were looking at: follow the item to where it went.
          if (cur === e.streamId) setSelected(e.movedTo ?? GENERAL_STREAM);
          break;
        case 'item.updated':
          if (e.item.streamId === null) {
            setPeek((p) => (p && p.id === e.item.id ? e.item : p));
            setSkippedVersion((v) => v + 1); // a newly skipped item, or a proposed work stream, shows in the list
          }
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
        case 'undo.changed':
          setUndoInfo(e.undo);
          break;
        case 'polling.changed':
          setPolling(e.polling);
          break;
        case 'usage.alert':
          if (e.banner) setUsageAlert({ day: e.day, message: e.message });
          if (e.desktop && 'Notification' in window && Notification.permission === 'granted') new Notification('Work Commander: usage budget passed', { body: e.message });
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

  useEffect(() => {
    get<UndoInfo>('/api/undo').then(setUndoInfo, () => undefined);
    get<PollingState>('/api/polling').then(setPolling, () => undefined);
  }, []);
  const togglePolling = useCallback(async (resume: boolean) => {
    try {
      await post<PollingState>(resume ? '/api/polling/resume' : '/api/polling/pause');
      // Read it back rather than using the reply: the catch-up can finish (and say so) before the reply arrives.
      setPolling(await get<PollingState>('/api/polling'));
    } catch (e: any) {
      toast({ title: resume ? "Couldn't resume" : "Couldn't pause", body: e.message, tone: 'error' });
    }
  }, [toast]);
  const doUndo = useCallback(async () => {
    try {
      const r = await post<UndoInfo & { undone: string | null }>('/api/undo');
      setUndoInfo({ next: r.next, count: r.count });
      if (r.undone && undoToastRef.current) toast({ title: 'Undone', body: r.undone.charAt(0).toUpperCase() + r.undone.slice(1), tone: 'ok' });
    } catch (e: any) {
      toast({ title: "Couldn't undo", body: e.message, tone: 'error' });
    }
  }, [toast]);
  // ⌘Z / Ctrl+Z undoes the last action, except while typing (where it undoes the typing, as usual).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || t.isContentEditable)) return;
      if (location.pathname.startsWith('/settings')) return;
      e.preventDefault();
      void doUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo]);

  const stream = useMemo(() => streams.find((s) => s.id === selected) ?? null, [streams, selected]);
  const tabItems = useMemo(() => orderTabs(items, recentTabFirst), [items, recentTabFirst]);
  // With no tab picked (or the picked one gone), the item side shows the first tab.
  const selectedItem = items.find((i) => i.id === tab) ?? (peek && tab === peek.id ? peek : null) ?? (stream ? (tabItems[0] ?? null) : null);
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
  // Drag the line between the work item and the Overview pane.
  const workRef = useRef<HTMLDivElement>(null);
  const startOvDrag = (ev: React.MouseEvent) => {
    ev.preventDefault();
    document.body.classList.add('col-resizing');
    const move = (m: MouseEvent) => {
      const r = workRef.current!.getBoundingClientRect();
      const v = Math.min(0.75, Math.max(0.15, (r.right - m.clientX) / r.width));
      setOvSplit(v);
      localStorage.setItem('wc.ovSplit', String(v));
    };
    const up = () => {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const showOverview = !!stream && selected !== GENERAL_STREAM;

  if (path.startsWith('/settings')) return <SettingsPage env={env} onBack={() => nav('/')} />;

  return (
    <div className={`app${usageAlert || polling.paused || polling.catchingUp ? ' has-banner' : ''}`}>
      {(usageAlert || polling.paused || polling.catchingUp) && (
        <div className="banners">
          {polling.paused && (
            <div className="usage-banner polling-banner" role="status">
              <span>
                <b>Polling and triage are paused.</b>{' '}
                {polling.paused.reason === 'gap'
                  ? `Nothing had been checked since ${when(polling.paused.gapFrom ?? polling.paused.since)} (the computer was asleep, or Work Commander was off). Clean up in Gmail or Slack first if you like: on Resume, email you've archived or deleted and Slack messages you've deleted are skipped.`
                  : `You paused them ${when(polling.paused.since)}. On Resume, everything since then is caught up, skipping email you've archived or deleted.`}
                {polling.held > 0 && ` ${polling.held} live update${polling.held === 1 ? '' : 's'} waiting.`}
              </span>
              <button className="btn small primary" onClick={() => void togglePolling(true)}>
                Resume
              </button>
            </div>
          )}
          {!polling.paused && polling.catchingUp && (
            <div className="usage-banner polling-banner" role="status">
              <span>Catching up on what arrived while polling was paused…</span>
            </div>
          )}
          {usageAlert && (
            <div className="usage-banner" role="alert">
              <span>{usageAlert.message}</span>
              <button className="btn small" onClick={() => nav('/settings?section=usage')}>
                See usage
              </button>
              <button className="btn small ghost" aria-label="Dismiss usage alert" onClick={dismissUsageAlert}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
      <Shortcuts />
      <StreamList
        confirmClose={confirmClose}
        streams={streams}
        selected={selected}
        onSelect={(id) => {
          // Picking a work stream (even the one already selected) leaves a ? item being viewed.
          if (peek) closePeek();
          setSelected(id);
        }}
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
        onSnooze={(id, snoozeUntil) => void patch(`/api/streams/${id}`, { pending: true, snoozeUntil })}
        undoNext={undoInfo.next}
        onUndo={() => void doUndo()}
        pollingPaused={!!polling.paused}
        onTogglePolling={() => void togglePolling(!!polling.paused)}
      />
      <main className="main" ref={mainRef} style={{ gridTemplateRows: `${split}fr 6px ${1 - split}fr` }}>
        <div className={`work-area${showOverview ? ' with-overview' : ''}`} ref={workRef} style={showOverview ? { gridTemplateColumns: `minmax(0, ${1 - ovSplit}fr) 6px minmax(0, ${ovSplit}fr)` } : undefined}>
          <div className="item-side">
            <TabBar stream={stream} items={tabItems} tab={selectedItem?.id ?? ''} onTab={setTab} peek={peek} onClosePeek={closePeek} onReorder={reorderTabs} onAddUrl={stream ? addByUrl : undefined} />
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
                <div className="empty-state">
                  <p className="muted">No work items in this stream yet. Add one by link with the + above, or drag a tab here from another work stream.</p>
                </div>
              ) : null}
            </section>
          </div>
          {showOverview && (
            <>
              <div className="divider-v" role="separator" aria-orientation="vertical" aria-label="Resize the Overview pane" onMouseDown={startOvDrag} onDoubleClick={() => { setOvSplit(1 / 3); localStorage.removeItem('wc.ovSplit'); }} title="Drag to resize the Overview (double-click to reset)" />
              <aside className="overview-pane" aria-label="Overview">
                <StreamOverview confirmClose={confirmClose} stream={stream!} items={items} onOpen={setTab} onMarkUnread={() => void markUnread(stream!.id)} onTogglePending={() => void patch(`/api/streams/${stream!.id}`, { pending: !stream!.pending })} />
              </aside>
            </>
          )}
        </div>
        <div className="divider" onMouseDown={startDrag} title="Drag to resize" />
        <section className={`bottom ${drafts.length || keepDraftsOpen ? 'with-drafts' : ''}`}>
          <ChatPane
            streamId={selected}
            streamTitle={stream?.title ?? 'All open work'}
            selectedItem={selectedItem}
            messages={chat}
            live={live?.text ?? null}
            running={running}
          />
          {(drafts.length > 0 || keepDraftsOpen) && (
            <DraftPane
              confirmClose={confirmClose}
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

/** "at 9:41 PM" today, otherwise "on Mon 16 Nov at 9:41 PM". */
function when(iso: string) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `at ${t}` : `on ${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${t}`;
}

export interface Toast {
  id: string;
  title: string;
  body: string;
  streamId?: string;
  tone: 'info' | 'ok' | 'error';
}

export function Toasts({ toasts, onOpen, onDismiss }: { toasts: Toast[]; onOpen: (streamId: string) => void; onDismiss: (id: string) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => (t.streamId ? onOpen(t.streamId) : onDismiss(t.id))}>
          <strong>{t.title}</strong>
          <div>{t.body}</div>
        </div>
      ))}
    </div>
  );
}

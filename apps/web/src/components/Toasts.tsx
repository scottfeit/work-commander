export interface Toast {
  id: string;
  title: string;
  body: string;
  streamId?: string;
  tone: 'info' | 'ok' | 'error';
}

/** Pop-up messages (top right). Click one, or its ×, to close it; "Open" goes to the work stream it's about. They also go away on their own. */
export function Toasts({ toasts, onOpen, onDismiss }: { toasts: Toast[]; onOpen: (streamId: string) => void; onDismiss: (id: string) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role="status" title="Click to close" onClick={() => onDismiss(t.id)}>
          <button
            type="button"
            className="toast-x"
            aria-label="Close"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(t.id);
            }}
          >
            ×
          </button>
          <strong>{t.title}</strong>
          <div>{t.body}</div>
          {t.streamId && (
            <button
              type="button"
              className="link small toast-open"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(t.streamId!);
                onDismiss(t.id);
              }}
            >
              Open
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** An alarm clock: the snooze ("Pending") button. Drawn with currentColor so the button decides orange or white. */
export function AlarmIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9v4.2l2.6 1.6" />
      <path d="M4.2 5.2 7.6 3M19.8 5.2 16.4 3" />
    </svg>
  );
}

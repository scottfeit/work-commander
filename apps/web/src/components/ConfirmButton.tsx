import { useEffect, useState, type ReactNode } from 'react';

/** A button that has to be clicked twice: the first click arms it (and says so), the second does it. It disarms itself after a few seconds. */
export function ConfirmButton({
  onConfirm,
  children,
  armedChildren,
  className = 'btn small',
  armedClassName = 'btn small danger',
  title,
  armedTitle,
  disabled,
  ariaLabel,
}: {
  onConfirm: () => void;
  children: ReactNode;
  armedChildren: ReactNode;
  className?: string;
  armedClassName?: string;
  title?: string;
  armedTitle?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? armedClassName : className}
      title={armed ? armedTitle : title}
      aria-label={ariaLabel}
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? armedChildren : children}
    </button>
  );
}

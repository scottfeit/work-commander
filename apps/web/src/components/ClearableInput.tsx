import { forwardRef, useRef, type InputHTMLAttributes } from 'react';

/** A text box with an × at its right that clears it (shown while it has text). */
export const ClearableInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { value: string; onClear: () => void; wrapClass?: string }>(function ClearableInput({ onClear, wrapClass, ...props }, ref) {
  const own = useRef<HTMLInputElement | null>(null);
  return (
    <span className={`clearable ${wrapClass ?? ''}`}>
      <input
        {...props}
        ref={(el) => {
          own.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
      />
      {props.value && (
        <button
          type="button"
          className="clear-x"
          aria-label="Clear"
          title="Clear"
          onMouseDown={(e) => e.preventDefault()} // keep focus in the box
          onClick={() => {
            onClear();
            own.current?.focus();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
});

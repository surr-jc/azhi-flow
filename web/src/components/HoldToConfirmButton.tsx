import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

export type ConfirmationInput = 'keyboard' | 'pointer';
type HoldStatus = 'confirmed' | 'holding' | 'idle';

type Props = Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'onClick'> & {
  children: ReactNode;
  /** How long the press must be held, in ms. */
  duration?: number;
  onConfirm: (input: ConfirmationInput) => void;
};

/**
 * A destructive button that only fires after the press is held for `duration`. Releasing, leaving
 * the button, blurring or disabling it cancels. Space and Enter hold it too, so it stays reachable
 * without a pointer. A fill sweeps across while holding (instant for keyboard and reduced motion).
 */
export function HoldToConfirmButton({ children, className, disabled, duration = 1600, onConfirm, ...rest }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  const pointerRef = useRef<number | null>(null);
  const inputRef = useRef<ConfirmationInput>('pointer');
  const holdingRef = useRef(false);
  const [input, setInput] = useState<ConfirmationInput | null>(null);
  const [status, setStatus] = useState<HoldStatus>('idle');

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    pointerRef.current = null;
    clearTimer();
    setStatus('idle');
  }, [clearTimer]);

  const complete = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    pointerRef.current = null;
    clearTimer();
    setStatus('confirmed');
    onConfirm(inputRef.current);
  }, [clearTimer, onConfirm]);

  const start = useCallback((mode: ConfirmationInput) => {
    if (disabled || holdingRef.current) return;
    inputRef.current = mode;
    setInput(mode);
    holdingRef.current = true;
    setStatus('holding');
    timerRef.current = window.setTimeout(complete, duration);
  }, [complete, disabled, duration]);

  useEffect(() => clearTimer, [clearTimer]);
  useEffect(() => { if (disabled) cancel(); }, [cancel, disabled]);

  const releaseCapture = (id: number) => {
    const b = buttonRef.current;
    if (b?.hasPointerCapture(id)) b.releasePointerCapture(id);
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (!e.isPrimary || e.button !== 0 || disabled) return;
    pointerRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    start('pointer');
  };

  // Pointer capture keeps move events coming after the cursor leaves, so drifting off cancels.
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!holdingRef.current || pointerRef.current !== e.pointerId) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pad = 8;
    if (e.clientX < r.left - pad || e.clientX > r.right + pad || e.clientY < r.top - pad || e.clientY > r.bottom + pad) {
      cancel();
      releaseCapture(e.pointerId);
    }
  };

  const onPointerEnd = (e: PointerEvent<HTMLButtonElement>) => {
    if (pointerRef.current !== e.pointerId) return;
    cancel();
    releaseCapture(e.pointerId);
  };

  const isKey = (e: KeyboardEvent<HTMLButtonElement>) => e.key === 'Enter' || e.key === ' ';

  return (
    <button
      {...rest}
      type="button"
      ref={buttonRef}
      className={`hold-btn ${className ?? ''}`.trim()}
      data-input={input ?? undefined}
      data-status={status}
      aria-busy={status === 'holding'}
      disabled={disabled}
      style={{ ...rest.style, ['--hold-ms' as string]: `${duration}ms` }}
      onBlur={cancel}
      onKeyDown={(e) => { if (e.repeat || !isKey(e)) return; e.preventDefault(); start('keyboard'); }}
      onKeyUp={(e) => { if (!isKey(e)) return; e.preventDefault(); cancel(); }}
      onLostPointerCapture={cancel}
      onPointerCancel={onPointerEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
    >
      <span className="hold-label">{children}</span>
      <span className="hold-fill" aria-hidden="true">{children}</span>
    </button>
  );
}

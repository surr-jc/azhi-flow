import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A dialog over the page: Escape or a click outside closes it, focus moves into it and returns to
 * where it was. Used for workflow settings, the expanded step view and the run form.
 */
export function Popup({ title, sub, onClose, footer, size = 'wide', children }: { title: ReactNode; sub?: ReactNode; onClose: () => void; footer?: ReactNode; size?: 'narrow' | 'wide' | 'full'; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', key);
    return () => {
      removeEventListener('keydown', key);
      before?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="popup-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`popup popup-${size}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} ref={box}>
        <header className="popup-head">
          <h2>{title}</h2>
          {sub ? <span className="muted small">{sub}</span> : null}
          <button type="button" className="small popup-x" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <div className="popup-body">{children}</div>
        {footer ? <footer className="popup-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from '../icons';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/**
 * A dialog over the page: Escape or a click outside closes it, focus moves into it, stays inside it
 * while it is open (Tab and Shift+Tab cycle) and returns to where it was. Used for workflow settings,
 * the expanded step view, the run form and confirmations. `initialFocus` picks the control that
 * gets focus first (a confirmation focuses Cancel); without it the dialog box itself does.
 */
export function Popup({ title, sub, onClose, footer, size = 'wide', initialFocus, children }: { title: ReactNode; sub?: ReactNode; onClose: () => void; footer?: ReactNode; size?: 'narrow' | 'wide' | 'full'; initialFocus?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const down = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = initialFocus ? box.current?.querySelector<HTMLElement>(initialFocus) : null;
    (first ?? box.current)?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
      e.preventDefault();
      items[next]?.focus();
    };
    addEventListener('keydown', key);
    return () => {
      removeEventListener('keydown', key);
      before?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    // A click only closes the dialog when it both starts and ends on the backdrop, so selecting text and releasing outside does not.
    <div className="popup-scrim" onMouseDown={(e) => { down.current = e.target === e.currentTarget; }} onClick={(e) => { if (down.current && e.target === e.currentTarget) onClose(); down.current = false; }}>
      <div className={`popup popup-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={box}>
        <header className="popup-head">
          <h2 id={titleId}>{title}</h2>
          {sub ? <span className="muted small">{sub}</span> : null}
          <button type="button" className="small popup-x" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        </header>
        <div className="popup-body">{children}</div>
        {footer ? <footer className="popup-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

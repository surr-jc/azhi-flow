import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';

/**
 * Shown after a destructive action is confirmed. The caller only commits the action in `onExpire`,
 * so Undo is a real cancel. The Undo button drains over `duration` to show the time left.
 */
export function UndoNotice({ message, duration = 5000, onExpire, onUndo }: { message: string; duration?: number; onExpire: () => void; onUndo: () => void }) {
  const [counting, setCounting] = useState(false);
  // Latest callback without restarting the timer when the parent re-renders.
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setCounting(true));
    const timer = window.setTimeout(() => expire.current(), duration);
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [duration]);

  return (
    <div className="undo-notice" role="status" aria-live="polite">
      <span className="undo-msg small"><Icon name="check" size={14} />{message}</span>
      <button type="button" className="small undo-btn" data-counting={counting} style={{ ['--undo-ms' as string]: `${duration}ms` }} onClick={onUndo}>
        <span className="hold-label"><Icon name="undo" size={13} />Undo</span>
        <span className="undo-fill" aria-hidden="true"><Icon name="undo" size={13} />Undo</span>
      </button>
    </div>
  );
}

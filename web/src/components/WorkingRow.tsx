import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LogoTraceLoader } from './LogoTraceLoader';

/**
 * The "working" line under a conversation: the logo traces while `pending`, and when work ends it
 * stays just long enough to close and fill in. `children` (status text, Stop) only show while pending.
 */
export function WorkingRow({ pending, children }: { pending: boolean; children: ReactNode }) {
  const [resolving, setResolving] = useState(pending);
  const [run, setRun] = useState(0);
  const wasPending = useRef(pending);

  useEffect(() => {
    if (pending && !wasPending.current) {
      setResolving(true);
      setRun((n) => n + 1); // a fresh loader, since a finished one stays on the filled logo
    }
    wasPending.current = pending;
  }, [pending]);

  if (!pending && !resolving) return null;
  return (
    <div className="pending">
      <LogoTraceLoader key={run} loading={pending} size={20} ariaLabel="Working" onDone={() => setResolving(false)} />
      {pending ? children : null}
    </div>
  );
}

import type { ReactNode } from 'react';
import { Icon } from '../icons';

/**
 * The activity feed used by the run page's Agent activity and Event log: a hairline rail with a time offset
 * and a tinted icon on the left, and the entry on the right. Newest content is the reader's call (see the
 * order switch); the rail only says "these happened one after another".
 */
export type FeedTone = 'agent' | 'tool' | 'prompt' | 'think' | 'ok' | 'bad' | 'run' | 'idle' | 'wait';

export function Feed({ label, children }: { label: string; children: ReactNode }) {
  return <ol className="af" aria-label={label}>{children}</ol>;
}

export function FeedItem({ icon, tone, offset, offsetTitle, fresh, children }: { icon: string; tone: FeedTone; offset?: string; offsetTitle?: string; fresh?: boolean; children: ReactNode }) {
  return (
    <li className={`af-item t-${tone}${fresh ? ' fresh' : ''}`}>
      <span className="af-off" title={offsetTitle}>{offset}</span>
      <span className="af-rail"><span className="af-bub"><Icon name={icon} size={16} /></span></span>
      <div className="af-body">{children}</div>
    </li>
  );
}

/** +m:ss from the first entry, so the reader sees pace without reading clock times. */
export function offsetOf(at: number | undefined, start: number | undefined): string {
  if (at === undefined || start === undefined) return '';
  const s = Math.max(0, Math.round((at - start) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What to show when there is nothing to show: a headline, a sentence, and one thing to do. */
export function FeedEmpty({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) {
  return (
    <section className="af-empty" aria-label={title}>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && onAction ? <button type="button" onClick={onAction}>{action}</button> : null}
    </section>
  );
}

/** Placeholder rows with the feed's own geometry, shown only when loading takes longer than a blink. */
export function FeedSkeleton() {
  return (
    <ol className="af af-skel" aria-hidden="true">
      {[0, 1, 2].map((i) => <li key={i} className="af-item"><span className="af-off" /><span className="af-rail"><span className="af-bub" /></span><div className="af-body"><div className="af-card"><i /><i /></div></div></li>)}
    </ol>
  );
}

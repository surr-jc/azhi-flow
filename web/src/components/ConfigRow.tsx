import type { ReactNode } from 'react';

/**
 * One setting as the workflow page shows it everywhere: its name, its value, a sentence saying what
 * it means, and where the value comes from. Sources that are steps can be picked.
 */
export function ConfigRow({ label, value, help, from, tone, steps, onPick, children }: {
  label: ReactNode;
  value?: ReactNode;
  help?: string;
  /** Where the value comes from: step ids, "input x" or "config x". */
  from?: string[];
  tone?: 'ok' | 'warn' | 'idle';
  /** Step ids, so a source that is one can be selected. */
  steps?: string[];
  onPick?: (id: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="cfg-row">
      <div className="cfg-k">{label}</div>
      <div className="cfg-v">
        {value !== undefined && value !== '' ? <div className={`cfg-val${tone ? ` tone-${tone}` : ''}`}>{value}</div> : null}
        {children}
        {from?.length ? (
          <div className="cfg-from">
            <span className="muted small">from</span>
            {from.map((f) => (steps?.includes(f) && onPick ? <button key={f} type="button" className="chip-link" onClick={() => onPick(f)}>{f}</button> : <span key={f} className="chip-effect">{f}</span>))}
          </div>
        ) : null}
        {help ? <div className="cfg-help">{help}</div> : null}
      </div>
    </div>
  );
}

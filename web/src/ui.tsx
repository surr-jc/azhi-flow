import { useState, type ReactNode } from 'react';
import type { JsonSchema } from './api';
import { Link } from './router';

export const when = (t: string | null | undefined) => (t ? new Date(t).toLocaleString() : '—');
export const num = (n: number | null | undefined) => (n === null || n === undefined ? 'unknown' : Number(n).toLocaleString());

export function ago(t: string | null | undefined): string {
  if (!t) return '—';
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const v = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return future ? `in ${v}` : `${v} ago`;
}

export function money(amount: number | null | undefined, currency = 'USD', complete = true) {
  if (amount === null || amount === undefined) return 'unknown';
  const v = amount === 0 || amount >= 1 ? amount.toFixed(2) : amount.toFixed(4);
  return `${complete ? '' : '≥ '}${currency === 'USD' ? '$' : `${currency} `}${v}`;
}

export const Badge = ({ children, tone }: { children: ReactNode; tone?: string }) => <span className={`badge ${tone ?? ''}`}>{children}</span>;

const STATE_TONE: Record<string, string> = {
  succeeded: 'ok', failed: 'bad', delivery_failed: 'bad', expired: 'bad', waiting: 'warn', cancelling: 'warn', cancelled: 'idle', running: 'run', queued: 'run',
};
export const StateBadge = ({ state }: { state: string }) => <Badge tone={`${STATE_TONE[state] ?? 'idle'} s-${state}`}>{state.replace('_', ' ')}</Badge>;

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode[]; empty?: string }) {
  if (!children.length && empty) return <p className="muted">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Panel({ title, action, children }: { title?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {title || action ? (
        <header className="panel-head">
          {title ? <h2>{title}</h2> : <span />}
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <div className="muted sub">{sub}</div> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint, tone, to }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string; to?: string }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ''}`}>{value}</span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </>
  );
  return to ? <Link to={to} className="stat">{body}</Link> : <div className="stat">{body}</div>;
}

export const Loading = () => <p className="muted">Loading…</p>;
export const ErrorNote = ({ error }: { error: unknown }) => (error ? <div className="error" role="alert">{(error as Error).message}</div> : null);

export function Json({ value }: { value: unknown }) {
  if (value === undefined) return <span className="muted">—</span>;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <pre className="json">{text}</pre>;
}

export const RunLink = ({ id }: { id: string }) => <Link to={`/ui/runs/${encodeURIComponent(id)}`} className="mono">{id}</Link>;

// ---- a form built from a JSON schema (workflow inputs, approval decisions) ---------------------

const typeOf = (s: JsonSchema) => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type) ?? (s.enum ? 'string' : s.properties ? 'object' : 'string');

/** Turns the form's text values into JSON for the schema; throws with a readable message. */
export function formValues(schema: JsonSchema | null | undefined, raw: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    const v = raw[name];
    const t = typeOf(prop);
    // An untouched checkbox shows unchecked, so a required yes/no field left alone means no.
    if (v === undefined && t === 'boolean' && schema?.required?.includes(name)) {
      out[name] = false;
      continue;
    }
    if (v === undefined || v === '') continue;
    if (t === 'boolean') out[name] = Boolean(v);
    else if (t === 'number' || t === 'integer') {
      const n = Number(v);
      if (Number.isNaN(n)) throw new Error(`${name} must be a number`);
      out[name] = n;
    } else if (t === 'array' && typeOf(prop.items ?? {}) === 'string') out[name] = String(v).split(',').map((x) => x.trim()).filter(Boolean);
    else if (t === 'object' || t === 'array') {
      try {
        out[name] = JSON.parse(String(v));
      } catch {
        throw new Error(`${name} must be JSON`);
      }
    } else out[name] = v;
  }
  return out;
}

export function SchemaFields({ schema, values, onChange, idPrefix = 'f' }: { schema: JsonSchema | null | undefined; values: Record<string, string | boolean>; onChange: (v: Record<string, string | boolean>) => void; idPrefix?: string }) {
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) return <p className="muted">This takes no inputs.</p>;
  const set = (k: string, v: string | boolean) => onChange({ ...values, [k]: v });
  return (
    <div className="fields">
      {props.map(([name, p]) => {
        const t = typeOf(p);
        const required = schema?.required?.includes(name);
        const id = `${idPrefix}-${name}`;
        const label = (
          <label htmlFor={id}>
            {p.title ?? name}
            {required ? <span className="req"> *</span> : null}
          </label>
        );
        let input: ReactNode;
        if (p.enum) {
          input = (
            <select id={id} value={String(values[name] ?? '')} onChange={(e) => set(name, e.target.value)}>
              <option value="">—</option>
              {p.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
            </select>
          );
        } else if (t === 'boolean') {
          input = <input id={id} type="checkbox" checked={Boolean(values[name])} onChange={(e) => set(name, e.target.checked)} />;
        } else if (t === 'object' || (t === 'array' && typeOf(p.items ?? {}) !== 'string')) {
          input = <textarea id={id} rows={3} className="mono" placeholder="JSON" value={String(values[name] ?? '')} onChange={(e) => set(name, e.target.value)} />;
        } else {
          input = (
            <input
              id={id}
              type={t === 'number' || t === 'integer' ? 'number' : 'text'}
              placeholder={t === 'array' ? 'comma separated' : p.default !== undefined ? String(p.default) : ''}
              value={String(values[name] ?? '')}
              onChange={(e) => set(name, e.target.value)}
              required={required}
            />
          );
        }
        return (
          <div className={`field ${t === 'boolean' ? 'inline' : ''}`} key={name}>
            {label}
            {input}
            {p.description ? <span className="hint">{p.description}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

export function useToggle(initial = false) {
  const [on, set] = useState(initial);
  return [on, () => set((x) => !x), set] as const;
}

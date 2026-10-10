import { useState } from 'react';
import { Badge } from '../ui';

export type Need = { name: string; secret: boolean; description?: string; required: boolean };
export type Guide = { harness: string; label: string; files: Record<string, string>; steps: string[] };

export function DefinitionSummary({ d }: { d: Record<string, any> }) {
  return (
    <dl className="lib-dl">
      <div><dt>Runs</dt><dd>{d.transport === 'local' ? 'On a worker, as a program' : 'Hosted, reached over HTTPS'}</dd></div>
      {d.transport === 'local' ? <div><dt>Command</dt><dd className="mono">{(d.command as string[]).join(' ')}</dd></div> : <div><dt>URL</dt><dd className="mono">{d.url}</dd></div>}
      {d.headers ? <div><dt>Headers</dt><dd className="mono">{Object.entries(d.headers as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join('\n')}</dd></div> : null}
      {d.environment ? <div><dt>Environment</dt><dd className="mono">{Object.entries(d.environment as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('\n')}</dd></div> : null}
    </dl>
  );
}
export function NeedList({ needs }: { needs: Need[] }) {
  return <ul className="lib-needs">{needs.map((n) => <li key={n.name}><code>{n.name}</code> {n.secret ? <Badge tone="warn">secret</Badge> : null} {n.required ? <Badge>required</Badge> : null}{n.description ? <span className="muted small"> {n.description}</span> : null}</li>)}</ul>;
}

/** The files and steps to use something in each harness. */
export function HarnessGuides({ guides }: { guides: Guide[] }) {
  const [tab, setTab] = useState(guides[0]?.harness ?? 'opencode');
  const g = guides.find((x) => x.harness === tab) ?? guides[0];
  const [copied, setCopied] = useState<string>();
  if (!g) return null;
  const copy = (path: string, text: string) => { void navigator.clipboard?.writeText(text).then(() => { setCopied(path); setTimeout(() => setCopied(undefined), 1500); }).catch(() => undefined); };
  return (
    <div className="lib-guides">
      <h4>Use it in a harness</h4>
      <div className="seg" role="tablist" aria-label="Harness">{guides.map((x) => <button key={x.harness} type="button" role="tab" aria-pressed={tab === x.harness} onClick={() => setTab(x.harness)}>{x.label}</button>)}</div>
      <ol className="lib-steps">{g.steps.map((s) => <li key={s}>{s.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</li>)}</ol>
      {Object.entries(g.files).map(([path, text]) => (
        <div key={path} className="lib-file">
          <div className="lib-file-head"><code>{path}</code><button type="button" className="small" onClick={() => copy(path, text)}>{copied === path ? 'Copied' : 'Copy'}</button></div>
          <pre className="code lib-text">{text}</pre>
        </div>
      ))}
    </div>
  );
}


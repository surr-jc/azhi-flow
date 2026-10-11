import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RunPlan } from '../api';
import { Badge, Table } from '../ui';

export type DockTab = 'plan' | 'controls' | 'requirements' | 'yaml';
type Tab = DockTab;

const MARK: Record<string, string> = { native: 'ok', bridged: 'warn', unverified: 'warn', unsupported: 'bad' };
const ENF: Record<string, string> = { enforced: 'ok', harness: 'warn', unobservable: 'bad' };

interface Group<T> { key: string; row: T; nodes: string[] }

/** Rows that say the same thing for several steps become one row that lists the steps. */
function group<T>(rows: Array<{ node: string; key: string; row: T }>): Array<Group<T>> {
  const out = new Map<string, Group<T>>();
  for (const r of rows) {
    const hit = out.get(r.key);
    if (hit) hit.nodes.push(r.node);
    else out.set(r.key, { key: r.key, row: r.row, nodes: [r.node] });
  }
  return [...out.values()];
}

function Steps({ nodes }: { nodes: string[] }) {
  if (nodes.length <= 2) return <>{nodes.join(', ')}</>;
  return (
    <details className="dock-steps">
      <summary>{nodes.length} steps</summary>
      <span>{nodes.join(', ')}</span>
    </details>
  );
}

/**
 * The run plan of an edit, in a panel docked under the canvas: one section at a time, scrolling
 * inside itself, so the page never grows. Closed it is a single bar that still shows the blocker count.
 */
export function PlanDock({ plan, yaml, file, selected, note, request }: { plan?: RunPlan | null; yaml?: string; file?: string; selected: string | null; note?: ReactNode; /** Opens the dock on a tab each time `id` changes (a button elsewhere on the page). */ request?: { tab: DockTab; id: number } }) {
  const [tab, setTab] = useState<Tab>('plan');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!request?.id) return;
    setTab(request.tab);
    setOpen(true);
  }, [request?.id, request?.tab]);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);

  const only = selected && !showAll ? selected : null;
  const nodes = useMemo(() => (plan?.nodes ?? []).filter((n) => !only || n.id === only), [plan, only]);
  const controls = useMemo(() => group(nodes.flatMap((n) => (n.coverage ?? []).map((c) => ({ node: n.id, key: `${c.action}|${c.enforcement}|${c.detail}`, row: c })))), [nodes]);
  const reqs = useMemo(() => group(nodes.flatMap((n) => (n.requirements ?? []).map((q) => ({ node: n.id, key: `${q.name}|${q.mark}|${q.detail}`, row: q })))), [nodes]);
  const blockers = useMemo(() => group((plan?.blockers ?? []).map((b) => ({ node: b.node ?? '', key: b.message, row: b }))), [plan]);
  const tainted = (plan?.nodes ?? []).filter((n) => n.tainted);
  const blockerCount = plan?.blockers.length ?? 0;
  const totalControls = (plan?.nodes ?? []).reduce((a, n) => a + (n.coverage?.length ?? 0), 0);
  const totalReqs = (plan?.nodes ?? []).reduce((a, n) => a + (n.requirements?.length ?? 0), 0);

  const pick = (t: Tab) => {
    if (open && tab === t) setOpen(false);
    else {
      setTab(t);
      setOpen(true);
    }
  };
  const tabs: Array<[Tab, string, ReactNode]> = [
    ['plan', 'Run plan', plan ? <Badge tone={blockerCount ? 'warn' : 'ok'}>{blockerCount ? `${blockerCount} blocker${blockerCount === 1 ? '' : 's'}` : 'ready'}</Badge> : null],
    ['controls', 'Controls', plan ? <span className="muted small">{totalControls}</span> : null],
    ['requirements', 'Requirements', plan ? <span className="muted small">{totalReqs}</span> : null],
    ['yaml', 'YAML', null],
  ];

  const filter = selected && (tab === 'controls' || tab === 'requirements') ? (
    <label className="dock-filter">
      <input type="checkbox" checked={!showAll} onChange={(e) => setShowAll(!e.target.checked)} /> Only <b>{selected}</b>
    </label>
  ) : null;

  const copy = () => {
    if (!yaml) return;
    void navigator.clipboard?.writeText(yaml).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };

  return (
    <section className={`ed-dock${open ? ' open' : ''}`} aria-label="Run plan and workflow file">
      <div className="ed-dock-bar" role="tablist">
        {tabs.map(([id, label, extra]) => (
          <button key={id} type="button" role="tab" aria-selected={open && tab === id} onClick={() => pick(id)}>{label}{extra}</button>
        ))}
        <span className="grow" />
        {open ? filter : null}
        <button type="button" className="dock-toggle" aria-expanded={open} aria-label={open ? 'Collapse the panel' : 'Expand the panel'} onClick={() => setOpen(!open)}>{open ? '▾' : '▴'}</button>
      </div>
      {open ? (
        <div className="ed-dock-body">
          {tab === 'plan' ? (
            plan ? (
              <>
                <p>
                  {plan.signer?.verified ? `Signed by ${plan.signer.publisher}, verified.` : `Signature not verified${plan.signer?.error ? `: ${plan.signer.error}` : ''}.`}{' '}
                  {plan.ok ? 'The plan has no blockers.' : `The plan has ${blockerCount} blocker(s), ${blockers.length} distinct.`}
                </p>
                {blockers.length ? (
                  <ul className="dock-blockers">
                    {blockers.map((g) => (
                      <li key={g.key}>
                        <span>{g.row.message}</span>
                        {g.nodes.filter(Boolean).length ? <span className="muted small"> · <Steps nodes={g.nodes.filter(Boolean)} /></span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {tainted.length ? (
                  <p className="muted small">
                    Tainted steps ({tainted.length}): they saw untrusted content, so their writes need a gate. <Steps nodes={tainted.map((n) => n.id)} />
                  </p>
                ) : null}
                {note ? <p className="muted small">{note}</p> : null}
              </>
            ) : <p className="muted">The run plan shows once the workflow compiles.</p>
          ) : null}
          {tab === 'controls' ? (
            <Table head={['Step', 'Action', 'Enforcement', 'How']} empty="No controlled actions.">
              {controls.map((g) => (
                <tr key={g.key}><td><Steps nodes={g.nodes} /></td><td>{g.row.action}</td><td><Badge tone={ENF[g.row.enforcement]}>{g.row.enforcement}</Badge></td><td className="muted">{g.row.detail}</td></tr>
              ))}
            </Table>
          ) : null}
          {tab === 'requirements' ? (
            <Table head={['Step', 'Requirement', 'Mark', 'Detail']} empty="No requirements.">
              {reqs.map((g) => (
                <tr key={g.key}><td><Steps nodes={g.nodes} /></td><td>{g.row.name}</td><td><Badge tone={MARK[g.row.mark]}>{g.row.mark}</Badge></td><td className="muted">{g.row.detail}</td></tr>
              ))}
            </Table>
          ) : null}
          {tab === 'yaml' ? (
            yaml ? (
              <>
                <div className="dock-yamlbar">
                  <span className="muted small">{file ?? 'workflow.yaml'} · {yaml.split('\n').length} lines</span>
                  <button type="button" className="small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
                </div>
                <pre className="code dock-yaml">{yaml}</pre>
              </>
            ) : <p className="muted">The file shows once the workflow compiles.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

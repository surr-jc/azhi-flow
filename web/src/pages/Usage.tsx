import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, atLeast, type WorkflowSummary } from '../api';
import { useMe } from '../App';
import { ago, Badge, ErrorNote, Loading, money, num, PageHead, Panel, Table, when } from '../ui';

/** credits: GitHub Copilot AI Credits (null without Copilot turns). */
interface Row { turns: number; unpriced: number; cost: number; input_tokens: number | null; output_tokens: number | null; credits: number | null }
interface UsageSummary { days: number; by_day: Array<Row & { day: string }>; by_workflow: Array<Row & { workflow: string; runs: number }> }

export function Usage() {
  const [days, setDays] = useState(14);
  const q = useQuery({ queryKey: ['usage', days], queryFn: () => api<UsageSummary>(`/v1/usage/summary?days=${days}`), refetchInterval: 30_000 });
  return (
    <>
      <PageHead
        title="Usage and cost"
        sub="Measured model spend. Turns without declared pricing count as unknown, never as zero, so a total with unpriced turns is a lower bound."
        actions={
          <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        }
      />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : <UsageBody data={q.data} />}
      <SpendLimits />
    </>
  );
}

function UsageBody({ data }: { data: UsageSummary }) {
  const total = data.by_day.reduce((a, r) => ({ cost: a.cost + r.cost, turns: a.turns + r.turns, unpriced: a.unpriced + r.unpriced, credits: r.credits === null ? a.credits : (a.credits ?? 0) + r.credits }), { cost: 0, turns: 0, unpriced: 0, credits: null as number | null });
  const copilot = data.by_workflow.some((w) => w.credits !== null);
  return (
    <>
      <div className="stats">
        <div className="stat"><span className="stat-label">Spend</span><span className="stat-value">{money(total.cost, 'USD', total.unpriced === 0)}</span><span className="stat-hint">last {data.days} days</span></div>
        {total.credits !== null ? <div className="stat"><span className="stat-label">Copilot AI credits</span><span className="stat-value">{num(Math.round(total.credits * 10) / 10)}</span><span className="stat-hint">last {data.days} days</span></div> : null}
        <div className="stat"><span className="stat-label">Model turns</span><span className="stat-value">{num(total.turns)}</span><span className="stat-hint">{total.unpriced ? `${total.unpriced} unpriced` : 'all priced'}</span></div>
      </div>
      <Panel title="Spend per day">
        <DayBars days={data.days} rows={data.by_day} />
      </Panel>
      <Panel title="By workflow">
        <Table head={['Workflow', 'Runs', 'Turns', 'Tokens in', 'Tokens out', ...(copilot ? ['Copilot credits'] : []), 'Spend']} empty="No model usage in this period.">
          {data.by_workflow.map((w) => (
            <tr key={w.workflow}>
              <td>{w.workflow}</td><td>{w.runs}</td><td>{w.turns}{w.unpriced ? <span className="muted small"> ({w.unpriced} unpriced)</span> : null}</td>
              <td>{num(w.input_tokens)}</td><td>{num(w.output_tokens)}</td>{copilot ? <td>{w.credits === null ? '—' : num(Math.round(w.credits * 10) / 10)}</td> : null}<td>{money(w.cost, 'USD', w.unpriced === 0)}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

/** One series, so no legend; each bar's tooltip carries its value and the table below has the rest. */
function DayBars({ days, rows }: { days: number; rows: UsageSummary['by_day'] }) {
  const byDay = new Map(rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), r]));
  const list = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86400_000);
    const key = d.toISOString().slice(0, 10);
    return { key, label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), row: byDay.get(key) };
  });
  const max = Math.max(...list.map((x) => x.row?.cost ?? 0), 0);
  if (!max && !rows.length) return <p className="muted">No model usage in this period.</p>;
  const W = 640, H = 160, pad = 24, gap = 2;
  const bw = (W - pad) / list.length - gap;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H + 20}`} role="img" aria-label={`Model spend per day, last ${days} days, highest ${money(max)}`}>
        <line x1={pad} x2={W} y1={H} y2={H} className="axis" />
        <text x={0} y={12} className="axis-label">{money(max)}</text>
        {list.map((x, i) => {
          const h = max ? Math.max(x.row?.cost ? 2 : 0, ((x.row?.cost ?? 0) / max) * (H - 16)) : 0;
          const bx = pad + i * (bw + gap);
          return (
            <g key={x.key} className="bar">
              <rect x={bx} y={0} width={bw + gap} height={H} className="hit"><title>{`${x.label}: ${x.row ? `${money(x.row.cost, 'USD', x.row.unpriced === 0)}, ${x.row.turns} turns` : 'no usage'}`}</title></rect>
              {h ? <path d={roundedTop(bx, H - h, bw, h, Math.min(4, bw / 2, h))} className="fill" /> : null}
              {i % Math.ceil(list.length / 7) === 0 ? <text x={bx + bw / 2} y={H + 14} textAnchor="middle" className="axis-label">{x.label}</text> : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const roundedTop = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;

interface Budget { id: string; workflow: string | null; period: 'day' | 'month'; limit: number; currency: string; spent: number; unpriced_turns: number; used_pct: number; exceeded: boolean; resets_at: string }

/** Limits hold back new runs of workflows with agent nodes once used up; test runs still work. */
function SpendLimits() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['budgets'], queryFn: () => api<Budget[]>('/v1/budgets'), refetchInterval: 30_000 });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary') });
  const [workflow, setWorkflow] = useState('');
  const [period, setPeriod] = useState<'day' | 'month'>('month');
  const [limit, setLimit] = useState('');
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['budgets'] });
    void qc.invalidateQueries({ queryKey: ['alerts'] });
    void qc.invalidateQueries({ queryKey: ['plan'] });
  };
  const save = useMutation({ mutationFn: () => api('/v1/budgets', { method: 'PUT', body: { workflow: workflow || null, period, limit: Number(limit) } }), onSuccess: () => { setLimit(''); done(); } });
  const remove = useMutation({ mutationFn: (id: string) => api(`/v1/budgets/${encodeURIComponent(id)}`, { method: 'DELETE' }), onSuccess: done });
  const admin = atLeast(me.data?.role, 'admin');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Panel title="Spend limits">
      <p className="muted small">When a limit is used up, new runs of workflows with agent steps are refused (scheduled ones too) until the period resets at midnight UTC or the start of the month. Test runs still work. Unpriced turns are not counted, so spend is a lower bound.</p>
      <ErrorNote error={q.error ?? remove.error} />
      {!q.data ? <Loading /> : (
        <Table head={['Applies to', 'Period', 'Used', 'Resets', '']} empty="No spend limits set.">
          {q.data.map((b) => (
            <tr key={b.id}>
              <td>{b.workflow ?? <strong>Whole workspace</strong>}</td>
              <td>{b.period === 'day' ? 'Daily' : 'Monthly'}</td>
              <td className="budget-cell">
                <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(b.used_pct, 100)} aria-label={`${b.used_pct}% used`}>
                  <span className={b.exceeded ? 'bad' : b.used_pct >= 80 ? 'warn' : ''} style={{ width: `${Math.min(b.used_pct, 100)}%` }} />
                </div>
                {money(b.spent, b.currency)} of {money(b.limit, b.currency)} {b.exceeded ? <Badge tone="bad">used up</Badge> : <span className="muted">({b.used_pct}%)</span>}
              </td>
              <td title={when(b.resets_at)} className="nowrap">{ago(b.resets_at)}</td>
              <td>{admin ? <button className="small" disabled={remove.isPending} onClick={() => confirm('Remove this spend limit?') && remove.mutate(b.id)}>Remove</button> : null}</td>
            </tr>
          ))}
        </Table>
      )}
      {admin ? (
        <form onSubmit={submit} className="row limit-form">
          <select aria-label="Applies to" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
            <option value="">Whole workspace</option>
            {workflows.data?.map((w) => <option key={w.slug} value={w.slug}>{w.slug}</option>)}
          </select>
          <select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as 'day' | 'month')}>
            <option value="day">Per day</option>
            <option value="month">Per month</option>
          </select>
          <input aria-label="Limit in USD" type="number" min="0.01" step="0.01" placeholder="Limit in USD" value={limit} onChange={(e) => setLimit(e.target.value)} required />
          <button type="submit" className="primary" disabled={save.isPending || !(Number(limit) > 0)}>Set limit</button>
        </form>
      ) : null}
      <ErrorNote error={save.error} />
    </Panel>
  );
}

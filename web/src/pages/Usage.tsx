import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { ErrorNote, Loading, money, num, PageHead, Panel, Table } from '../ui';

interface Row { turns: number; unpriced: number; cost: number; input_tokens: number | null; output_tokens: number | null }
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
    </>
  );
}

function UsageBody({ data }: { data: UsageSummary }) {
  const total = data.by_day.reduce((a, r) => ({ cost: a.cost + r.cost, turns: a.turns + r.turns, unpriced: a.unpriced + r.unpriced }), { cost: 0, turns: 0, unpriced: 0 });
  return (
    <>
      <div className="stats">
        <div className="stat"><span className="stat-label">Spend</span><span className="stat-value">{money(total.cost, 'USD', total.unpriced === 0)}</span><span className="stat-hint">last {data.days} days</span></div>
        <div className="stat"><span className="stat-label">Model turns</span><span className="stat-value">{num(total.turns)}</span><span className="stat-hint">{total.unpriced ? `${total.unpriced} unpriced` : 'all priced'}</span></div>
      </div>
      <Panel title="Spend per day">
        <DayBars days={data.days} rows={data.by_day} />
      </Panel>
      <Panel title="By workflow">
        <Table head={['Workflow', 'Runs', 'Turns', 'Tokens in', 'Tokens out', 'Spend']} empty="No model usage in this period.">
          {data.by_workflow.map((w) => (
            <tr key={w.workflow}>
              <td>{w.workflow}</td><td>{w.runs}</td><td>{w.turns}{w.unpriced ? <span className="muted small"> ({w.unpriced} unpriced)</span> : null}</td>
              <td>{num(w.input_tokens)}</td><td>{num(w.output_tokens)}</td><td>{money(w.cost, 'USD', w.unpriced === 0)}</td>
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

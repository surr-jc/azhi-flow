import { useId, useState, type MouseEvent } from 'react';

// Small hand-drawn SVG charts for the overview. Colours come from the --s* series tokens in
// styles.css (validated for colour-blind separation in light and dark); text stays in ink tokens.

export interface Series {
  key: string;
  label: string;
  color: string;
}

/** Trend line under a KPI; decorative, so the tile's number carries the meaning. */
export function Sparkline({ values, color = 'var(--accent)' }: { values: number[]; color?: string }) {
  const id = useId();
  const W = 160, H = 40;
  if (values.length < 2) return <div className="sparkline" />;
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 4 - ((v - min) / span) * (H - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.18" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** A top for four whole-number grid steps of 1, 2 or 5 times a power of ten. */
function niceMax(v: number) {
  const raw = Math.max(1, v / 4);
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].find((m) => m * p >= raw)! * p * 4;
}

/** Several series over the same days on one axis, with a crosshair and tooltip on hover. */
export function LineChart({ points, series, label }: { points: Array<{ label: string; values: Record<string, number> }>; series: Series[]; label: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 240, L = 36, B = 24, T = 8;
  const top = niceMax(Math.max(1, ...points.flatMap((p) => series.map((s) => p.values[s.key] ?? 0))));
  const x = (i: number) => L + (points.length > 1 ? (i / (points.length - 1)) * (W - L - 8) : 0);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const every = Math.ceil(points.length / 7);
  const move = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - 8)) * (points.length - 1)))));
  };
  const first = series[0]!;
  return (
    <div className="line-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseMove={move} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={first.color} stopOpacity="0.14" />
            <stop offset="1" stopColor={first.color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W} y1={y(t)} y2={y(t)} className="grid" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="axis-label">{t}</text>
          </g>
        ))}
        {points.map((p, i) => (i % every === 0 ? <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="axis-label">{p.label}</text> : null))}
        <path d={`${points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.values[first.key] ?? 0)}`).join('')}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={`url(#${id})`} />
        {series.map((s) => (
          <path key={s.key} d={points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.values[s.key] ?? 0)}`).join('')} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {hover !== null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="crosshair" />
            {series.map((s) => <circle key={s.key} cx={x(hover)} cy={y(points[hover]!.values[s.key] ?? 0)} r="4.5" fill={s.color} className="ring" />)}
          </g>
        ) : null}
      </svg>
      {hover !== null ? (
        // Shifted by the same share as its anchor, so it stays inside the chart at both edges.
        <div className="tooltip" style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(-${(x(hover) / W) * 100}%)` }}>
          <div className="tooltip-title">{points[hover]!.label}</div>
          {series.map((s) => (
            <div key={s.key} className="tooltip-row"><span className="key" style={{ background: s.color }} />{s.label}<b>{points[hover]!.values[s.key] ?? 0}</b></div>
          ))}
        </div>
      ) : null}
      <table className="visually-hidden">
        <caption>{label}</caption>
        <thead><tr><th>Day</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
        <tbody>{points.map((p) => <tr key={p.label}><td>{p.label}</td>{series.map((s) => <td key={s.key}>{p.values[s.key] ?? 0}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Part-to-whole at a glance; hovering a segment (or its legend row) shows it in the centre. */
export function Donut({ parts, unit }: { parts: Array<{ label: string; value: number; color: string }>; unit: string }) {
  const [active, setActive] = useState<number | null>(null);
  const total = parts.reduce((a, p) => a + p.value, 0);
  const R = 62, C = 2 * Math.PI * R, GAP = parts.length > 1 ? 3 : 0;
  let offset = 0;
  const shown = active === null ? null : parts[active]!;
  return (
    <div className="donut">
      <svg viewBox="0 0 160 160" role="img" aria-label={`${total} ${unit}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
        <circle cx="80" cy="80" r={R} className="donut-track" />
        {parts.map((p, i) => {
          const len = (p.value / total) * C;
          const el = (
            <circle
              key={p.label}
              cx="80" cy="80" r={R}
              fill="none" stroke={p.color} strokeWidth={active === i ? 22 : 18}
              strokeDasharray={`${Math.max(0, len - GAP)} ${C}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 80 80)"
              className="donut-seg"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
            >
              <title>{`${p.label}: ${p.value} ${unit}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
        <text x="80" y="78" textAnchor="middle" className="donut-value">{shown ? shown.value : total}</text>
        <text x="80" y="97" textAnchor="middle" className="donut-label">{shown ? truncate(shown.label, 16) : `total ${unit}`}</text>
      </svg>
      <ul className="legend">
        {parts.map((p, i) => (
          <li key={p.label} className={active === i ? 'on' : ''} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
            <span className="key" style={{ background: p.color }} />
            <span className="legend-name" title={p.label}>{p.label}</span>
            <b>{Math.round((p.value / total) * 100)}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Ordered stages; bar width is the stage's share of the first, labelled with count and share. */
export function Funnel({ stages }: { stages: Array<{ label: string; value: number; hint?: string }> }) {
  const first = stages[0]?.value || 1;
  return (
    <ol className="funnel">
      {stages.map((s, i) => {
        const share = s.value / first;
        return (
          <li key={s.label} title={s.hint}>
            <div className="funnel-bar-wrap">
              <div className={`funnel-bar f${i}`} style={{ width: `${Math.max(6, share * 100)}%` }} />
            </div>
            <div className="funnel-text">
              <span className="muted small">{s.label}</span>
              <b>{s.value.toLocaleString()}</b>
              {i ? <span className="muted small">{Math.round(share * 100)}% of started</span> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

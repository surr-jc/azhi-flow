import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { ago, ErrorNote, Loading, PageHead, when } from '../ui';

interface AuditEvent { seq: number; actor: string | null; kind: string; data: Record<string, unknown>; at: string }

function EventRow({ e }: { e: AuditEvent }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(e.data);
  const preview = keys.slice(0, 3).map((k) => `${k}: ${typeof e.data[k] === 'object' ? JSON.stringify(e.data[k]) : String(e.data[k])}`).join(' · ');
  return (
    <li className="au-row">
      <span className="au-dot" aria-hidden="true" />
      <div className="au-main">
        <div className="au-line">
          <span className="au-kind mono">{e.kind}</span>
          <span className="muted small">by <span className="mono">{e.actor ?? 'system'}</span></span>
          <time className="muted small au-time" dateTime={e.at} title={when(e.at)}>{ago(e.at)}</time>
        </div>
        {keys.length ? (
          <>
            <p className="au-preview small muted">{preview}</p>
            <button type="button" className="link small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Hide detail' : 'Show detail'}</button>
            {open ? <pre className="json">{JSON.stringify(e.data, null, 2)}</pre> : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

export function Audit() {
  const [filter, setFilter] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<AuditEvent[]>(`/v1/audit?limit=100${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]!.seq : undefined),
  });
  const all = q.data?.pages.flat() ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? all.filter((e) => `${e.kind} ${e.actor ?? 'system'} ${JSON.stringify(e.data)}`.toLowerCase().includes(needle)) : all;
  // Newest day first; the API already returns newest first, so grouping keeps order.
  const days: Array<{ day: string; items: AuditEvent[] }> = [];
  for (const e of shown) {
    const day = new Date(e.at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const last = days[days.length - 1];
    if (last?.day === day) last.items.push(e); else days.push({ day, items: [e] });
  }
  return (
    <>
      <PageHead
        title="Audit log"
        sub="Credential changes, publications, approvals, schedule and trust-policy changes, and every change made from this app."
        actions={<input type="search" aria-label="Filter events" placeholder="Filter by action, person or detail" value={filter} onChange={(e) => setFilter(e.target.value)} className="au-filter" />}
      />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : !all.length ? (
        <div className="empty"><p className="empty-title">Nothing recorded yet.</p><p className="muted">Changes to credentials, approvals and schedules will appear here.</p></div>
      ) : !shown.length ? (
        <div className="empty"><p className="empty-title">No loaded events match “{filter}”.</p>{q.hasNextPage ? <p className="muted">Older events are not loaded yet; load more to search further back.</p> : null}</div>
      ) : (
        <div className="stack">
          {days.map((d) => (
            <section key={d.day} className="panel au-day" aria-label={d.day}>
              <h2 className="au-day-title">{d.day} <span className="muted small">· {d.items.length} {d.items.length === 1 ? 'event' : 'events'}</span></h2>
              <ul className="au-list">
                {d.items.map((e) => <EventRow key={e.seq} e={e} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
      {q.hasNextPage ? <div className="au-more"><button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? 'Loading…' : 'Load older events'}</button></div> : null}
    </>
  );
}

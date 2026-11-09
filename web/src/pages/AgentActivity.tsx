import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Formatted, Markdown } from '../components/Rich';
import { DiffView, EditDiff, editInput, patchInput } from '../components/DiffView';

/** One transcript entry as the API returns it (src/agents/transcript.ts). */
export interface TranscriptEntry {
  id: string;
  kind: 'system' | 'user' | 'assistant' | 'reasoning' | 'tool' | 'step' | 'error' | 'note';
  node_id: string;
  attempt: number;
  ord: number;
  version: number;
  text?: string;
  tool?: string;
  status?: 'pending' | 'running' | 'completed' | 'error';
  input?: unknown;
  output?: string;
  error?: string;
  model?: string;
  tokens?: { input?: number; output?: number; reasoning?: number; cache_read?: number; cache_write?: number };
  at?: number;
}

const key = (e: TranscriptEntry) => `${e.node_id}/${e.attempt}/${e.id}`;

/** Follows a run's agent transcripts: every second while the run is open, once more after it ends. */
export function useTranscript(runId: string, open: boolean) {
  const [entries, setEntries] = useState<Map<string, TranscriptEntry>>(new Map());
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const cursor = useRef(0);
  useEffect(() => {
    cursor.current = 0;
    setEntries(new Map());
    setLoaded(false);
  }, [runId]);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api<{ enabled: boolean; entries: TranscriptEntry[]; cursor: number }>(`/v1/runs/${encodeURIComponent(runId)}/transcript?after=${cursor.current}`);
        if (stop) return;
        setEnabled(r.enabled);
        setLoaded(true);
        if (r.entries.length) {
          cursor.current = r.cursor;
          setEntries((m) => {
            const next = new Map(m);
            for (const e of r.entries) next.set(key(e), e);
            return next;
          });
        }
        // A full page means more are waiting; ask again at once.
        if (r.entries.length >= 5000) return void (timer = setTimeout(tick, 0));
      } catch {
        /* try again on the next tick */
      }
      if (!stop && open) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [runId, open]);
  const list = useMemo(() => [...entries.values()].sort((a, b) => a.ord - b.ord), [entries]);
  return { entries: list, enabled, loaded };
}

/**
 * One tool call's input and result (or error). A DCP run says what it did, since `compress` is the plugin
 * pruning context, not a workflow tool.
 */
export function ToolIO({ e, dcp }: { e: TranscriptEntry; dcp: boolean }) {
  const edit = editInput(e.input);
  const patch = edit ? undefined : patchInput(e.input);
  return (
    <div className="af-io">
      {dcp ? <p className="muted small">DCP replaced the messages in the given range with the summary in the input, so later model calls send fewer tokens.{e.status === 'error' ? ' This run failed, so nothing was pruned.' : ''}</p> : null}
      <div className="af-label">Input</div>
      {edit ? <EditDiff {...edit} /> : patch ? <DiffView text={patch} /> : <Formatted value={e.input ?? {}} plain />}
      {e.status === 'error' ? <><div className="af-label">Error</div><pre className="json bad">{e.error}</pre></> : e.output !== undefined ? <><div className="af-label">Result</div><Formatted value={e.output} plain /></> : <p className="muted small">Running…</p>}
    </div>
  );
}

/** A long prompt shows its start, with the rest a click away. */
export function Long({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  if (text.length <= 1200 || all) return <Markdown className="af-text" text={text} />;
  return <div className="af-text"><Markdown text={`${text.slice(0, 1200)}…`} /><button type="button" className="link small" onClick={() => setAll(true)}>Show all ({text.length.toLocaleString()} characters)</button></div>;
}

export function argLine(input: unknown): string {
  if (input === undefined || input === null) return '';
  const t = typeof input === 'string' ? input : JSON.stringify(input);
  return t === '{}' ? '' : t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

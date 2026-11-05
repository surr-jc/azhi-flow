import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { ErrorNote, Loading } from '../ui';

/**
 * Files and workspace items attached to a builder chat message. Files are read to plain text by the
 * server (POST /v1/builder/attachments) and kept here until the message is sent; nothing is stored.
 * The limits mirror src/builder/attachments.ts, which enforces them again.
 */
export type AttachKind = 'text' | 'spreadsheet' | 'document' | 'pdf' | 'unsupported';
export interface Attached { id: string; name: string; kind: AttachKind; text: string; chars: number; truncated: boolean; warnings: string[] }
export interface Pin { id: string; name: string; kind: string }

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ACCEPT = '.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.sql,.log,.toml,.ini,.ts,.js,.py,.java,.go,.rs,.sh,.pdf,.docx,.xlsx';

function toBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

/** Reads the chosen files on the server. Files over the size limit never leave the browser. */
export async function readFiles(files: File[]): Promise<Attached[]> {
  const big = files.filter((f) => f.size > MAX_FILE_BYTES);
  const ok = files.filter((f) => f.size <= MAX_FILE_BYTES);
  const skipped: Attached[] = big.map((f) => ({ id: crypto.randomUUID(), name: f.name, kind: 'unsupported', text: '', chars: 0, truncated: false, warnings: [`larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`] }));
  if (!ok.length) return skipped;
  const data = await Promise.all(ok.map(async (f) => ({ name: f.name, data: await toBase64(f) })));
  const r = await api<{ files: Omit<Attached, 'id'>[] }>('/v1/builder/attachments', { method: 'POST', body: { files: data } });
  return [...r.files.map((f) => ({ ...f, id: crypto.randomUUID() })), ...skipped];
}

export function AttachChips({ files, pins, onRemoveFile, onRemovePin, onSave, saved }: {
  files: Attached[];
  pins: Pin[];
  onRemoveFile: (id: string) => void;
  onRemovePin: (id: string) => void;
  /** Saves an attachment's text as a dataset document; omitted where saving does not apply. */
  onSave?: (f: Attached) => void;
  saved?: Record<string, string>;
}) {
  if (!files.length && !pins.length) return null;
  return (
    <ul className="attach-chips" aria-label="Attached to this message">
      {files.map((f) => (
        <li key={f.id} className={`attach-chip ${f.kind === 'unsupported' ? 'bad' : ''}`}>
          <Icon name="report" size={13} />
          <span className="attach-name" title={f.name}>{f.name}</span>
          <span className="muted small">{f.kind === 'unsupported' ? 'not read' : `${f.chars.toLocaleString()} chars${f.truncated ? ', truncated' : ''}`}</span>
          {f.warnings.length ? <span className="small bad-text" title={f.warnings.join('; ')}>{f.warnings[0]}</span> : null}
          {onSave && f.kind !== 'unsupported' ? (
            saved?.[f.id] ? <span className="small muted">saved to {saved[f.id]}</span> : <button type="button" className="small-btn" onClick={() => onSave(f)}>Save as dataset</button>
          ) : null}
          <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => onRemoveFile(f.id)}><Icon name="close" size={12} /></button>
        </li>
      ))}
      {pins.map((p) => (
        <li key={p.id} className="attach-chip">
          <Icon name="tool" size={13} />
          <span className="attach-name">{p.name}</span>
          <span className="muted small">{p.kind}</span>
          <button type="button" className="icon-btn" aria-label={`Unpin ${p.name}`} onClick={() => onRemovePin(p.id)}><Icon name="close" size={12} /></button>
        </li>
      ))}
    </ul>
  );
}

interface ToolboxRow { id: string; name: string; kind: string; group: string; summary: string; status: string }
const GROUPS: Record<string, string> = { apps: 'Apps and tools', mcp: 'MCP servers', skills: 'Skills', roles: 'Agent roles', knowledge: 'Datasets' };

/** Picks workspace items (tools, MCP servers, skills, roles, datasets) for the builder to use. */
export function ToolPicker({ picked, onDone, onClose }: { picked: Pin[]; onDone: (pins: Pin[]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const q = useQuery({ queryKey: ['toolbox'], queryFn: () => api<ToolboxRow[]>('/v1/toolbox') });
  const [sel, setSel] = useState(() => new Map(picked.map((p) => [p.id, p])));
  const [find, setFind] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const toggle = (r: ToolboxRow) => setSel((s) => {
    const n = new Map(s);
    if (n.has(r.id)) n.delete(r.id);
    else if (n.size < 20) n.set(r.id, { id: r.id, name: r.name, kind: r.kind });
    return n;
  });
  const rows = (q.data ?? []).filter((r) => !find || `${r.name} ${r.summary}`.toLowerCase().includes(find.toLowerCase()));
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="pick-title" onClose={onClose}>
      <h2 id="pick-title">Use these in the workflow</h2>
      <p className="muted small">The builder will look each one up and use it where it fits. Pick up to 20. Nothing is changed or run.</p>
      <input type="search" aria-label="Filter" placeholder="Filter…" value={find} onChange={(e) => setFind(e.target.value)} />
      {q.isLoading ? <Loading /> : <ErrorNote error={q.error} />}
      <div className="pick-list">
        {Object.entries(GROUPS).map(([g, label]) => {
          const list = rows.filter((r) => r.group === g);
          return list.length ? (
            <fieldset key={g}>
              <legend>{label}</legend>
              {list.map((r) => (
                <label key={r.id} className="pick-row">
                  <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r)} />
                  <span><strong>{r.name}</strong> <span className="muted small">{r.status === 'needs_setup' ? 'needs setup' : r.status}</span><span className="small muted block">{r.summary}</span></span>
                </label>
              ))}
            </fieldset>
          ) : null;
        })}
      </div>
      <div className="row dialog-actions">
        <button type="button" onClick={() => ref.current?.close()}>Cancel</button>
        <button type="button" className="primary" onClick={() => { onDone([...sel.values()]); ref.current?.close(); }}>Use {sel.size || 'none'}</button>
      </div>
    </dialog>
  );
}

import { useMemo, useState } from 'react';

type Kind = 'add' | 'del' | 'ctx' | 'hunk' | 'note';
interface Line { kind: Kind; text: string; oldNo?: number; newNo?: number }
interface FileDiff { path: string; oldPath?: string; status: 'added' | 'deleted' | 'renamed' | 'modified' | 'binary'; additions: number; deletions: number; lines: Line[] }

/** True for the output of `git diff` (unified format), so any text view can show it as a diff. */
export function looksLikeDiff(s: string): boolean {
  return /^diff --git /m.test(s) || (/^--- .+\n\+\+\+ /m.test(s) && /^@@ .* @@/m.test(s));
}

/** Parses unified diff text into files and lines with their old and new line numbers. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const start = (path: string, oldPath?: string) => {
    cur = { path, oldPath, status: 'modified', additions: 0, deletions: 0, lines: [] };
    files.push(cur);
    inHunk = false;
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (m) {
      start(m[2]!, m[1] !== m[2] ? m[1] : undefined);
      continue;
    }
    if (!cur) {
      if (raw.startsWith('--- ')) start(raw.slice(4).replace(/^[ab]\//, ''));
      else continue;
    }
    const f = cur!;
    if (!inHunk) {
      if (raw.startsWith('new file mode')) f.status = 'added';
      else if (raw.startsWith('deleted file mode')) f.status = 'deleted';
      else if (raw.startsWith('rename from ')) f.status = 'renamed';
      else if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) f.status = 'binary';
      else if (raw.startsWith('+++ ')) f.path = raw.slice(4).replace(/^b\//, '') === '/dev/null' ? f.path : raw.slice(4).replace(/^b\//, '');
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      f.lines.push({ kind: 'hunk', text: `@@ -${h[1]} +${h[2]} @@${h[3]}` });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+')) {
      f.additions++;
      f.lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith('-')) {
      f.deletions++;
      f.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith('\\')) {
      f.lines.push({ kind: 'note', text: raw.slice(1).trim() });
    } else if (raw.startsWith(' ') || raw === '') {
      f.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  // A trailing empty line from the final newline is not a context line.
  for (const f of files) {
    const last = f.lines[f.lines.length - 1];
    if (last && last.kind === 'ctx' && last.text === '' && last.oldNo !== undefined) f.lines.pop();
  }
  return files;
}

const STATUS_LABEL: Record<FileDiff['status'], string> = { added: 'new file', deleted: 'deleted', renamed: 'renamed', modified: 'modified', binary: 'binary' };
const LINE_CAP = 1200;

function FileCard({ file, open, version }: { file: FileDiff; open: boolean; version: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? file.lines : file.lines.slice(0, LINE_CAP);
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
  const base = file.path.slice(dir.length);
  return (
    <details className="diff-file" open={open} key={version} data-path={file.path}>
      <summary>
        <span className={`diff-status ${file.status}`}>{STATUS_LABEL[file.status]}</span>
        <span className="diff-path"><span className="diff-dir">{dir}</span><strong>{base}</strong>{file.oldPath ? <span className="muted"> (from {file.oldPath})</span> : null}</span>
        <span className="diff-counts"><span className="plus">+{file.additions}</span> <span className="minus">-{file.deletions}</span></span>
      </summary>
      {file.status === 'binary' ? <p className="muted small diff-note">Binary file; its contents are not shown.</p> : (
        <div className="diff-scroll">
          <table className="diff-table">
            <tbody>
              {shown.map((l, i) =>
                l.kind === 'hunk' ? (
                  <tr key={i} className="hunk"><td colSpan={4}>{l.text}</td></tr>
                ) : l.kind === 'note' ? (
                  <tr key={i} className="note"><td colSpan={4}>{l.text}</td></tr>
                ) : (
                  <tr key={i} className={l.kind} data-new={l.newNo} data-old={l.kind === 'del' ? l.oldNo : undefined}>
                    <td className="no">{l.oldNo ?? ''}</td>
                    <td className="no">{l.newNo ?? ''}</td>
                    <td className="sign" aria-hidden="true">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}</td>
                    <td className="code">{l.text === '' ? ' ' : l.text}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      {!all && file.lines.length > LINE_CAP ? (
        <button type="button" className="link small" onClick={() => setAll(true)}>Show the remaining {file.lines.length - LINE_CAP} lines</button>
      ) : null}
    </details>
  );
}

const pick = (rec: Record<string, unknown>, keys: string[]) => {
  const k = keys.find((x) => typeof rec[x] === 'string');
  return k ? (rec[k] as string) : undefined;
};

/** The path and the old and new text of an edit tool call's input, or undefined when it is not one. */
export function editInput(input: unknown): { path: string; oldText: string; newText: string } | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const oldText = pick(rec, ['old_string', 'oldString', 'old_str', 'oldText']);
  const newText = pick(rec, ['new_string', 'newString', 'new_str', 'newText']);
  if (oldText === undefined || newText === undefined) return undefined;
  return { path: pick(rec, ['path', 'file_path', 'filePath', 'file']) ?? '', oldText, newText };
}

/** The unified diff held in a patch tool call's input, or undefined. */
export function patchInput(input: unknown): string | undefined {
  if (typeof input === 'string') return looksLikeDiff(input) ? input : undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return Object.values(input as Record<string, unknown>).find((v): v is string => typeof v === 'string' && looksLikeDiff(v));
}

type Row = { kind: 'add' | 'del' | 'ctx'; text: string; hi?: [number, number] };
const CONTEXT = 2;

/** An edit tool call as a diff, like an editor's inline diff: full-width red and green rows, the changed characters marked, and a little context around. */
export function EditDiff({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  const rows = useMemo(() => {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    const dels = a.slice(s, a.length - e);
    const adds = b.slice(s, b.length - e);
    // Lines replaced one for one show which characters changed.
    const mark = (x: string, y: string): [number, number] | undefined => {
      let p = 0;
      while (p < x.length && p < y.length && x[p] === y[p]) p++;
      let q = 0;
      while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
      return p + q < x.length || p + q < y.length ? [p, q] : undefined;
    };
    const paired = dels.length === adds.length;
    const out: Row[] = [];
    for (const t of a.slice(Math.max(0, s - CONTEXT), s)) out.push({ kind: 'ctx', text: t });
    dels.forEach((t, i) => { const m = paired ? mark(t, adds[i]!) : undefined; out.push({ kind: 'del', text: t, hi: m && [m[0], t.length - m[1]] }); });
    adds.forEach((t, i) => { const m = paired ? mark(dels[i]!, t) : undefined; out.push({ kind: 'add', text: t, hi: m && [m[0], t.length - m[1]] }); });
    for (const t of b.slice(b.length - e, b.length - e + CONTEXT)) out.push({ kind: 'ctx', text: t });
    return out;
  }, [oldText, newText]);
  const del = rows.filter((r) => r.kind === 'del').length;
  const add = rows.filter((r) => r.kind === 'add').length;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return (
    <div className="diff edit-diff">
      <div className="edit-head">
        <span className="diff-path"><span className="diff-dir">{dir}</span><strong>{path.slice(dir.length) || 'edit'}</strong></span>
        <span className="diff-counts"><span className="plus">+{add}</span> <span className="minus">-{del}</span></span>
      </div>
      {rows.length ? (
        <div className="diff-scroll">
          <table className="diff-table">
            <tbody>
              {rows.map((l, i) => (
                <tr key={i} className={l.kind}>
                  <td className="sign" aria-hidden="true">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}</td>
                  <td className="code">
                    {l.hi ? <>{l.text.slice(0, l.hi[0])}<mark>{l.text.slice(l.hi[0], l.hi[1])}</mark>{l.text.slice(l.hi[1])}</> : l.text === '' ? ' ' : l.text}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted small diff-note">No change.</p>}
    </div>
  );
}

/** A unified diff as per-file cards with line numbers and added/removed lines, with an overview on top. */
export function DiffView({ text }: { text: string }) {
  const files = useMemo(() => parseDiff(text), [text]);
  const [open, setOpen] = useState<boolean | undefined>();
  const [version, setVersion] = useState(0);
  if (!files.length) return <pre className="json">{text}</pre>;
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const total = add + del;
  const defaultOpen = (i: number) => (open !== undefined ? open : files.length <= 3 || total <= 400 ? true : i === 0);
  return (
    <div className="diff">
      <div className="diff-summary">
        <span><strong>{files.length}</strong> file{files.length === 1 ? '' : 's'} changed</span>
        <span className="plus">+{add}</span>
        <span className="minus">-{del}</span>
        <span className="diff-actions">
          <button type="button" className="link small" onClick={() => { setOpen(true); setVersion((v) => v + 1); }}>Expand all</button>
          <button type="button" className="link small" onClick={() => { setOpen(false); setVersion((v) => v + 1); }}>Collapse all</button>
        </span>
      </div>
      <ul className="diff-index">
        {files.map((f) => (
          <li key={f.path}><span className={`diff-status ${f.status}`}>{STATUS_LABEL[f.status]}</span> <code>{f.path}</code> <span className="plus">+{f.additions}</span> <span className="minus">-{f.deletions}</span></li>
        ))}
      </ul>
      {files.map((f, i) => <FileCard key={`${f.path}-${version}`} file={f} open={defaultOpen(i)} version={version} />)}
    </div>
  );
}

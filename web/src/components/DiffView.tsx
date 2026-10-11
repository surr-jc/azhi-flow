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

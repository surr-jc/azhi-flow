import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useRoute } from '../router';
import { ErrorNote, PageHead, Panel, Table } from '../ui';

/**
 * Uploading a workflow package from the browser: a folder (or its files) is read in the tab,
 * filtered the way `azhi publish` filters a package directory, and sent to POST /v1/packages,
 * which compiles it and stores an unsigned draft version. Publishing needs a signature.
 */
const IGNORED = new Set(['node_modules', '.venv', '__pycache__', '.git', '.azhi', 'fixtures', 'azhi.config.yaml']);
const WORKFLOW_FILES = ['workflow.yaml', 'workflow.yml', 'azhi.yaml'];
const MAX_BYTES = 32 * 1024 * 1024;

interface Picked { path: string; file: File }
interface Diagnostic { severity: string; code: string; message: string; node?: string }

/** Paths relative to the package folder, without the files a package never includes. */
export function packageFiles(files: Array<{ path: string; file: File }>): Picked[] {
  const parts = files.map((f) => f.path.split('/').filter(Boolean));
  // A picked folder arrives as folder/...; drop that first segment when every file shares it.
  const top = parts[0]?.[0];
  const strip = parts.length > 0 && parts.every((p) => p.length > 1 && p[0] === top) ? 1 : 0;
  return files
    .map((f, i) => ({ path: parts[i]!.slice(strip).join('/'), file: f.file }))
    .filter((f) => f.path && !f.path.split('/').some((seg) => seg.startsWith('.') || IGNORED.has(seg)))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function UploadPackage() {
  const { navigate } = useRoute();
  const qc = useQueryClient();
  const folder = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  // `webkitdirectory` is not in React's input attributes.
  useEffect(() => folder.current?.setAttribute('webkitdirectory', ''), []);

  const workflow = WORKFLOW_FILES.find((w) => picked.some((f) => f.path === w));
  const size = picked.reduce((n, f) => n + f.file.size, 0);
  const upload = useMutation({
    mutationFn: async () => {
      const files: Record<string, string> = {};
      for (const f of picked) files[f.path] = await base64(f.file);
      return api<{ ok: boolean; diagnostics: Diagnostic[]; version?: { id: string; workflow: string; version: number } }>('/v1/packages', { method: 'POST', body: { workflow, files } });
    },
    onSuccess: (r) => {
      if (!r.ok || !r.version) return;
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['versions', r.version.workflow] });
      navigate(`/ui/workflows/${encodeURIComponent(r.version.workflow)}?version=${encodeURIComponent(r.version.id)}`);
    },
  });
  const pick = (list: FileList | null) => {
    upload.reset();
    setPicked(packageFiles([...(list ?? [])].map((file) => ({ path: file.webkitRelativePath || file.name, file }))));
  };

  return (
    <>
      <PageHead title="Upload a workflow" sub="Pick the package folder (the one with workflow.yaml, its profiles, schemas, templates and scripts). It is checked by the compiler and saved as a new unsigned draft version." />
      <Panel>
        <div className="row">
          <label className="button">
            Choose folder
            <input ref={folder} type="file" multiple className="visually-hidden" aria-label="Package folder" onChange={(e) => pick(e.target.files)} />
          </label>
          <label className="button">
            Choose files
            <input type="file" multiple className="visually-hidden" aria-label="Package files" onChange={(e) => pick(e.target.files)} />
          </label>
          <span className="muted small">Hidden files, node_modules, .venv, fixtures and azhi.config.yaml are left out, as with azhi publish.</span>
        </div>
        {picked.length ? (
          <>
            <Table head={['File', 'Size']}>
              {picked.map((f) => <tr key={f.path}><td className="mono">{f.path}</td><td>{f.file.size.toLocaleString()} bytes</td></tr>)}
            </Table>
            {!workflow ? <div className="error">No workflow.yaml at the top of the package.</div> : null}
            {size > MAX_BYTES ? <div className="error">The package is {Math.round(size / 1024 / 1024)} MB; the limit is 32 MB.</div> : null}
            <div className="row">
              <button type="button" className="primary" disabled={!workflow || size > MAX_BYTES || upload.isPending} onClick={() => upload.mutate()}>
                {upload.isPending ? 'Uploading…' : `Upload ${picked.length} file${picked.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        ) : null}
        <ErrorNote error={upload.error} />
        {upload.data && !upload.data.ok ? (
          <div className="error" role="alert">
            Not saved. The compiler found:
            <ul>{upload.data.diagnostics.map((d, i) => <li key={i}>{d.node ? `${d.node}: ` : ''}{d.message}</li>)}</ul>
          </div>
        ) : null}
      </Panel>
    </>
  );
}

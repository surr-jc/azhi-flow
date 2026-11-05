import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiUpload, atLeast } from '../api';
import { useMe } from '../App';
import { Link } from '../router';
import { signVersion } from '../signing';
import { Badge, ErrorNote, PageHead, Panel, Table } from '../ui';

/**
 * Importing a workflow bundle (the zip from a workflow's Export). The bundle is checked on the
 * server first and shown as a plan; nothing changes until Import is pressed. Add keeps everything
 * that already exists here; Override replaces existing tools, library items and dataset documents
 * with the bundle's, as new versions, and saves the workflow as a new draft version.
 */
type Mode = 'add' | 'override';
interface Item { kind: string; name: string; action: 'create' | 'replace' | 'unchanged' | 'skip'; detail?: string }
interface Report {
  ok: boolean;
  dry_run: boolean;
  workflow: string;
  source_version: number;
  items: Item[];
  secrets: Array<{ name: string; set: boolean }>;
  omitted_at_export: Array<{ kind: string; name: string; reason: string }>;
  version?: { id: string; workflow: string; version: number; draft: boolean };
  diagnostics?: Array<{ message: string; node?: string }>;
}

const TONE: Record<Item['action'], string> = { create: 'ok', replace: 'warn', unchanged: 'idle', skip: 'idle' };
const LABEL: Record<Item['action'], string> = { create: 'add', replace: 'replace', unchanged: 'same', skip: 'kept' };
const MAX_BYTES = 60 * 1024 * 1024;

export function ImportBundle() {
  const me = useMe();
  const qc = useQueryClient();
  const [file, setFile] = useState<File>();
  const [mode, setMode] = useState<Mode>('add');
  const query = (dry: boolean) => `/v1/workflows/import?mode=${mode}&dry_run=${dry}`;
  const check = useQuery({
    queryKey: ['bundle-check', file?.name, file?.size, file?.lastModified, mode],
    enabled: Boolean(file) && file!.size <= MAX_BYTES,
    retry: false,
    queryFn: () => apiUpload<Report>(query(true), file!),
  });
  const run = useMutation({
    mutationFn: async () => {
      const r = await apiUpload<Report>(query(false), file!);
      // Workers run signed packages only; like Upload, sign with this browser's key if it can.
      if (r.ok && r.version?.draft) await signVersion(r.version.id).catch(() => undefined);
      return r;
    },
    onSuccess: () => {
      for (const key of ['workflows', 'versions', 'tools', 'assets', 'datasets', 'bundle-check']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
  if (!atLeast(me.data?.role, 'admin')) {
    return (
      <>
        <PageHead title="Import a bundle" />
        <div className="empty"><p className="empty-title">Importing registers tools, so it needs the admin role.</p></div>
      </>
    );
  }
  const plan = check.data;
  const changes = plan?.items.filter((i) => i.action === 'create' || i.action === 'replace').length ?? 0;
  const done = run.data?.ok ? run.data : undefined;
  const unset = plan?.secrets.filter((s) => !s.set) ?? [];
  const choose = (m: Mode) => {
    run.reset();
    setMode(m);
  };

  return (
    <>
      <PageHead title="Import a bundle" sub={<>Pick a zip made with <b>Export</b> on a workflow page. You see what it would add or replace before anything changes.</>} />
      <Panel>
        <div className="row">
          <label className="button">
            Choose bundle (.zip)
            <input type="file" accept=".zip,application/zip" className="visually-hidden" aria-label="Workflow bundle" onChange={(e) => { run.reset(); setFile(e.target.files?.[0]); }} />
          </label>
          {file ? <span className="mono">{file.name}</span> : <span className="muted small">No file chosen.</span>}
        </div>
        {file && file.size > MAX_BYTES ? <div className="error">The file is {Math.round(file.size / 1024 / 1024)} MB; the limit is 60 MB.</div> : null}
        {file ? (
          <fieldset className="radio-group">
            <legend>If something already exists here</legend>
            <label className="row"><input type="radio" name="mode" checked={mode === 'add'} onChange={() => choose('add')} /> <span><b>Add new only.</b> Anything already here is left as it is.</span></label>
            <label className="row"><input type="radio" name="mode" checked={mode === 'override'} onChange={() => choose('override')} /> <span><b>Override.</b> Replace what differs with the bundle's version. Earlier versions are kept.</span></label>
          </fieldset>
        ) : null}
        <ErrorNote error={check.error} />
        {plan ? (
          <>
            <h3 className="section">Workflow <span className="mono">{plan.workflow}</span> <span className="muted small">exported from v{plan.source_version}</span></h3>
            <Table head={['Kind', 'Name', 'What happens', 'Detail']}>
              {plan.items.map((i) => (
                <tr key={`${i.kind}:${i.name}`}>
                  <td>{i.kind}</td>
                  <td className="mono">{i.name}</td>
                  <td><Badge tone={TONE[i.action]}>{LABEL[i.action]}</Badge></td>
                  <td className="muted small">{i.detail ?? ''}</td>
                </tr>
              ))}
            </Table>
            {plan.secrets.length ? (
              <p className={unset.length ? 'warn-note' : 'muted'}>
                Secrets it expects (values are never in a bundle): {plan.secrets.map((s) => `${s.name} ${s.set ? '(set)' : '(not set)'}`).join(', ')}.{unset.length ? <> Set them on the <Link to="/ui/secrets">Secrets</Link> page before running.</> : null}
              </p>
            ) : null}
            {plan.omitted_at_export.length ? <p className="warn-note">Left out when the bundle was exported: {plan.omitted_at_export.map((o) => `${o.kind} ${o.name} (${o.reason})`).join('; ')}.</p> : null}
            <div className="row">
              <button type="button" className="primary" disabled={!changes || run.isPending || Boolean(done)} onClick={() => run.mutate()}>
                {run.isPending ? 'Importing…' : changes ? `Import (${changes} change${changes === 1 ? '' : 's'})` : 'Nothing to import'}
              </button>
            </div>
          </>
        ) : check.isFetching ? <p className="muted">Checking the bundle…</p> : null}
        <ErrorNote error={run.error} />
        {run.data && !run.data.ok ? (
          <div className="error" role="alert">
            Tools and datasets were added, but the workflow did not compile here:
            <ul>{(run.data.diagnostics ?? []).map((d, i) => <li key={i}>{d.node ? `${d.node}: ` : ''}{d.message}</li>)}</ul>
          </div>
        ) : null}
        {done ? (
          <p role="status">
            Imported.{' '}
            {done.version ? <><Link to={`/ui/workflows/${encodeURIComponent(done.version.workflow)}?version=${encodeURIComponent(done.version.id)}`}>Open {done.version.workflow} v{done.version.version}</Link>, saved as a draft; publish it from the workflow page.</> : null}
          </p>
        ) : null}
      </Panel>
    </>
  );
}

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, atLeast, type RunPlan, type RunRow, type WorkflowSummary } from '../api';
import { useMe } from '../App';
import { Link, useRoute } from '../router';
import { ago, Badge, ErrorNote, formValues, Loading, PageHead, Panel, SchemaFields, StateBadge, Table, when } from '../ui';
import { RunTable } from './Overview';
import { Coverage } from './Run';
import { WorkflowCanvas } from '../components/WorkflowCanvas';

export function Workflows() {
  const q = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary'), refetchInterval: 15_000 });
  return (
    <>
      <PageHead title="Workflows" sub={<>Publish new versions with <code>azhi publish</code>. Uploading from the browser comes later.</>} />
      <ErrorNote error={q.error} />
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['Workflow', 'Published', 'Latest', 'Schedule', 'Last run']} empty="No workflows yet. Run azhi init, then azhi publish.">
            {q.data.map((w) => (
              <tr key={w.slug}>
                <td><Link to={`/ui/workflows/${encodeURIComponent(w.slug)}`}>{w.latest?.name ?? w.slug}</Link>{w.latest?.name && w.latest.name !== w.slug ? <div className="muted small mono">{w.slug}</div> : null}</td>
                <td>{w.published ? <>v{w.published.version} {w.published.signed ? <Badge tone="ok">signed</Badge> : <Badge tone="warn">unsigned</Badge>}</> : <span className="muted">not published</span>}</td>
                <td>v{w.latest?.version}{w.latest?.draft ? <> <Badge tone="idle">draft</Badge></> : null}</td>
                <td>{w.schedule ? <>{w.schedule.cron} <span className="muted">{w.schedule.timezone}</span>{w.schedule.enabled ? null : <> <Badge tone="idle">off</Badge></>}</> : <span className="muted">manual</span>}</td>
                <td>{w.last_run ? <><StateBadge state={w.last_run.state} /> <span className="muted">{ago(w.last_run.created_at)}</span></> : <span className="muted">never</span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}

interface VersionRow { id: string; version: number; draft: boolean; package_hash: string; signed: boolean; created_at: string }

export function WorkflowPage({ slug }: { slug: string }) {
  const me = useMe();
  const versions = useQuery({ queryKey: ['versions', slug], queryFn: () => api<VersionRow[]>(`/v1/workflows/${encodeURIComponent(slug)}/versions`) });
  const [picked, setPicked] = useState<string>();
  const current = versions.data?.find((v) => v.id === picked) ?? versions.data?.find((v) => !v.draft) ?? versions.data?.[0];
  const version = useQuery({ queryKey: ['version', current?.id], queryFn: () => api<any>(`/v1/versions/${current!.id}`), enabled: Boolean(current), staleTime: Infinity });
  const plan = useQuery({ queryKey: ['plan', current?.id], queryFn: () => api<RunPlan>(`/v1/versions/${current!.id}/plan`), enabled: Boolean(current), refetchInterval: 15_000 });
  const runs = useQuery({ queryKey: ['runs', '', slug, 'wf'], queryFn: () => api<RunRow[]>(`/v1/runs?limit=10&workflow=${encodeURIComponent(slug)}`), refetchInterval: 5_000 });
  if (versions.error) return <ErrorNote error={versions.error} />;
  if (!versions.data) return <Loading />;
  if (!current) return <p>No versions of {slug}.</p>;
  const def = version.data?.definition;
  return (
    <>
      <PageHead
        title={def?.name ?? slug}
        sub={def?.description ?? (def?.name && def.name !== slug ? <span className="mono">{slug}</span> : undefined)}
        actions={
          <select aria-label="Version" value={current.id} onChange={(e) => setPicked(e.target.value)}>
            {versions.data.map((v) => <option key={v.id} value={v.id}>v{v.version}{v.draft ? ' (draft)' : ''}{v.signed ? '' : ' unsigned'}</option>)}
          </select>
        }
      />
      <div className="grid-2">
        <Panel title="Start a run">
          {atLeast(me.data?.role, 'operator') ? <StartRun versionId={current.id} draft={current.draft} schema={version.data?.plan?.inputsSchema ?? def?.inputs} plan={plan.data} /> : <p className="muted">Your role cannot start runs.</p>}
        </Panel>
        <Panel title="About this version">
          <div className="meta tight">
            <div><span>Version</span>v{current.version} {current.draft ? <Badge tone="idle">draft</Badge> : <Badge tone="ok">published</Badge>}</div>
            <div><span>Signature</span>{plan.data ? (plan.data.signer.verified ? `verified, ${plan.data.signer.publisher}` : `not verified${plan.data.signer.error ? `: ${plan.data.signer.error}` : ''}`) : '…'}</div>
            <div><span>Uploaded</span>{when(current.created_at)}</div>
            <div><span>Package</span><span className="mono">{current.package_hash.slice(0, 19)}</span></div>
            <div><span>Trigger</span>{def?.trigger?.schedule ? `${def.trigger.schedule.cron} (${def.trigger.schedule.timezone})` : 'manual'}</div>
          </div>
        </Panel>
      </div>
      <Panel title="Workflow">{version.data?.plan?.nodes ? <WorkflowCanvas nodes={version.data.plan.nodes} plan={plan.data} /> : <Loading />}</Panel>
      <h2 className="section">Run plan</h2>
      {plan.error ? <ErrorNote error={plan.error} /> : plan.data ? <Coverage plan={plan.data} live /> : <Loading />}
      <Panel title="Recent runs" action={<Link to={`/ui/runs?workflow=${encodeURIComponent(slug)}`}>All runs</Link>}>
        {runs.data ? <RunTable runs={runs.data} /> : <Loading />}
      </Panel>
    </>
  );
}

function StartRun({ versionId, draft, schema, plan }: { versionId: string; draft: boolean; schema: any; plan?: RunPlan }) {
  const { navigate } = useRoute();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [formError, setFormError] = useState<string>();
  const start = useMutation({
    mutationFn: (test: boolean) => api<{ run_id: string }>('/v1/runs', { method: 'POST', body: { version: versionId, inputs: formValues(schema, values), ...(test ? { test: true } : {}) } }),
    onSuccess: (r) => navigate(`/ui/runs/${encodeURIComponent(r.run_id)}`),
  });
  const go = (test: boolean) => {
    setFormError(undefined);
    try {
      formValues(schema, values);
    } catch (e) {
      return setFormError((e as Error).message);
    }
    start.mutate(test);
  };
  const blocked = plan && !plan.ok;
  return (
    <form onSubmit={(e) => { e.preventDefault(); go(false); }}>
      <SchemaFields schema={schema} values={values} onChange={setValues} />
      {blocked ? <p className="warn-note">The run plan has {plan.blockers.length} blocker(s), so a real run will be refused. A test run mocks writes and still works.</p> : null}
      {draft ? <p className="muted small">This is a draft version.</p> : null}
      <div className="row">
        <button type="submit" className="primary" disabled={start.isPending || blocked}>Start run</button>
        <button type="button" disabled={start.isPending} onClick={() => go(true)} title="Writes are mocked">Test run</button>
      </div>
      {formError ? <div className="error">{formError}</div> : null}
      <ErrorNote error={start.error} />
    </form>
  );
}

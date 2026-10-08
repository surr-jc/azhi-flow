import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api, atLeast, type PreflightReport, type RunPlan, type RunRow, type ScheduleRow, type WorkflowSummary } from '../api';
import { PublishAction } from './Authoring';
import { useMe } from '../App';
import { Link, useRoute } from '../router';
import { ago, Badge, ErrorNote, formValues, Loading, PageHead, Panel, SchemaFields, StateBadge, Table, when } from '../ui';
import { RunTable } from './Overview';
import { Coverage } from './Run';
import { Popup } from '../components/Popup';
import { StepPanel } from '../components/StepDrawer';
import { SettingsBody, SettingsDock, type PortableAsset, type SectionId, type SettingsData, type ToolRow, type VersionRow } from '../components/WorkflowSettings';
import { nodeStates, WorkflowCanvas, type PlanNode } from '../components/WorkflowCanvas';
import { LENSES, lensRows, lensSummary, type Lens } from '../lenses';
import { keySettings } from '../stepHelp';

export function Workflows() {
  const me = useMe();
  const q = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary'), refetchInterval: 15_000 });
  return (
    <>
      <PageHead
        title="Workflows"
        sub={<>Build one by describing it in chat, upload a package as a draft, or sign and publish it with <code>azhi publish</code>.</>}
        actions={atLeast(me.data?.role, 'author') ? <><Link to="/ui/workflows/new" className="button primary">Build with chat</Link> <Link to="/ui/examples" className="button">Browse the marketplace</Link> <Link to="/ui/workflows/upload" className="button">Upload a workflow</Link></> : undefined}
      />
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

export function WorkflowPage({ slug }: { slug: string }) {
  const me = useMe();
  const versions = useQuery({ queryKey: ['versions', slug], queryFn: () => api<VersionRow[]>(`/v1/workflows/${encodeURIComponent(slug)}/versions`) });
  const { search } = useRoute();
  const [picked, setPicked] = useState<string | undefined>(search.get('version') ?? undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<'plan' | 'run'>('plan');
  const [lens, setLens] = useState<Lens>('flow');
  const current = versions.data?.find((v) => v.id === picked) ?? versions.data?.find((v) => !v.draft) ?? versions.data?.[0];
  const version = useQuery({ queryKey: ['version', current?.id], queryFn: () => api<any>(`/v1/versions/${current!.id}`), enabled: Boolean(current), staleTime: Infinity });
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<ToolRow[]>('/v1/tools') });
  const plan = useQuery({ queryKey: ['plan', current?.id], queryFn: () => api<RunPlan>(`/v1/versions/${current!.id}/plan`), enabled: Boolean(current), refetchInterval: 15_000 });
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => api<ScheduleRow[]>('/v1/schedules/summary'), enabled: atLeast(me.data?.role, 'admin') });
  const runs = useQuery({ queryKey: ['runs', '', slug, 'wf'], queryFn: () => api<RunRow[]>(`/v1/runs?limit=10&workflow=${encodeURIComponent(slug)}`), refetchInterval: 5_000 });
  const portableAssets = useQuery({ queryKey: ['workflow-assets', slug], queryFn: () => api<PortableAsset[]>(`/v1/workflows/${encodeURIComponent(slug)}/assets`) });
  const examples = useQuery({ queryKey: ['examples'], queryFn: () => api<Array<{ id: string; name: string; workflow: string; update: { available: boolean; tracked: boolean } | null }>>('/v1/examples') });
  const lastId = runs.data?.[0]?.id;
  const lastRun = useQuery({ queryKey: ['run', lastId], queryFn: () => api<any>(`/v1/runs/${encodeURIComponent(lastId!)}`), enabled: Boolean(lastId) });
  const nodes: PlanNode[] | undefined = version.data?.plan?.nodes;
  const toolList = tools.data ?? [];
  const missing = new Set((plan.data?.missing_grants ?? []).filter((g) => g.kind === 'secret').map((g) => g.name));
  const missingKey = [...missing].sort().join(',');
  const settings = useCallback(
    (n: PlanNode) => (lens === 'flow' ? keySettings({ type: n.type, ...(n.def ?? {}) }, toolList) : lensRows(lens, n, version.data?.plan?.nodes ?? [], { tools: toolList, missing: new Set(missingKey ? missingKey.split(',') : []) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toolList, lens, missingKey, version.data],
  );
  if (versions.error) return <ErrorNote error={versions.error} />;
  if (!versions.data) return <Loading />;
  if (!current) return <p>No versions of {slug}.</p>;
  const def = version.data?.definition;
  const step = nodes?.find((n) => n.id === selected);
  const runStates = lastRun.data ? nodeStates(lastRun.data) : {};
  const lastLabel = runs.data?.[0] ? `#${runs.data[0].id.slice(-8)}` : undefined;
  const data: SettingsData = { slug, version: current, def, nodes: nodes ?? [], plan: plan.data, tools: toolList, role: me.data?.role, schedule: schedules.data?.find((s) => s.workflow === slug), schedulesLoaded: Boolean(schedules.data), hasPublished: versions.data.some((v) => !v.draft), assets: portableAssets.data };
  const blockers = plan.data?.blockers.length ?? 0;
  return (
    <>
      <PageHead
        title={def?.name ?? slug}
        sub={def?.description ?? (def?.name && def.name !== slug ? <span className="mono">{slug}</span> : undefined)}
        actions={
          <div className="row">
            <Badge tone={current.draft ? 'idle' : 'ok'}>{current.draft ? 'draft' : 'published'}</Badge>
            {plan.data ? (blockers ? <Badge tone="bad">{blockers} blocker{blockers === 1 ? '' : 's'}</Badge> : <Badge tone="ok">ready to run</Badge>) : null}
            {plan.data ? <Badge tone={plan.data.signer.verified ? 'ok' : 'warn'}>{plan.data.signer.verified ? 'signed' : 'not signed'}</Badge> : null}
            <select aria-label="Version" value={current.id} onChange={(e) => { setPicked(e.target.value); setSelected(null); }}>
              {versions.data.map((v) => <option key={v.id} value={v.id}>v{v.version}{v.draft ? ' (draft)' : ''}{v.signed ? '' : ' unsigned'}</option>)}
            </select>
            {atLeast(me.data?.role, 'author') ? <Link to={`/ui/workflows/${encodeURIComponent(slug)}/edit?from=${encodeURIComponent(current.id)}`} className="button">Edit</Link> : null}
            {atLeast(me.data?.role, 'author') ? <PublishAction version={current} slug={slug} /> : null}
            {atLeast(me.data?.role, 'operator') ? <button type="button" className="primary" onClick={() => setStarting(true)}>Run…</button> : null}
          </div>
        }
      />
      {(() => {
        const ex = examples.data?.find((x) => x.workflow === slug && x.update?.available);
        return ex ? (
          <div className="update-note" role="status">
            <b>The marketplace has an update for this workflow.</b> Your changes stay; new steps and settings are loaded.{' '}
            <Link to={`/ui/examples/${encodeURIComponent(ex.id)}`}>Review the update</Link>
          </div>
        ) : null;
      })()}
      <div className={`workbench${step ? ' with-step' : ''}`}>
        <SettingsDock data={data} collapsed={Boolean(step)} active={section ?? undefined} onOpen={setSection} />
        <div className="wb-canvas">
          <div className="wb-modebar">
            <div className="seg" role="group" aria-label="Show">
              <button type="button" aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}>Plan</button>
              <button type="button" aria-pressed={mode === 'run'} disabled={!lastId} onClick={() => setMode('run')} title={lastId ? undefined : 'This workflow has not run yet'}>Last run{lastLabel ? ` · ${lastLabel}` : ''}</button>
            </div>
            {mode === 'plan' ? (
              <div className="seg" role="group" aria-label="Lens">
                {LENSES.map((l) => <button key={l.id} type="button" aria-pressed={lens === l.id} title={l.hint} onClick={() => setLens(l.id)}>{l.label}</button>)}
              </div>
            ) : null}
            <span className="muted small">{mode === 'run' ? 'Each step shows what happened in the latest run.' : lens === 'flow' ? 'Select a step to read what it does and every setting.' : LENSES.find((l) => l.id === lens)!.hint}</span>
          </div>
          {nodes ? <WorkflowCanvas nodes={nodes} plan={plan.data} select={{ selected, onSelect: setSelected }} detail={mode === 'run' ? lastRun.data : undefined} settings={mode === 'plan' ? settings : undefined} /> : <Loading />}
          {mode === 'plan' && lens !== 'flow' && nodes ? (
            <div className="lens-cards" aria-label={`${lens} summary`}>
              {lensSummary(lens, nodes, { tools: toolList, missing }).map((c) => (
                <div key={c.title} className={`lens-card${c.tone ? ` ${c.tone}` : ''}`}>
                  <span className="label">{c.title}</span>
                  {c.lines.map((l) => <p key={l} className="small">{l}</p>)}
                </div>
              ))}
            </div>
          ) : null}
          {plan.data ? (
            <div className="runplan-strip">
              <Badge tone={blockers ? 'bad' : 'ok'}>{blockers ? `${blockers} blocker${blockers === 1 ? '' : 's'}` : '0 blockers'}</Badge>
              <span className="muted small">{blockers ? plan.data.blockers[0]!.message : 'The run plan compiles and every step can run.'}</span>
              <a className="small" href="#run-plan" style={{ marginLeft: 'auto' }}>View run plan</a>
            </div>
          ) : null}
        </div>
        {step && nodes ? (
          <aside className="wb-drawer">
            <StepPanel node={step} nodes={nodes} tools={toolList} plan={plan.data} run={runStates[step.id]} runLabel={lastLabel} onPick={setSelected} onClose={() => setSelected(null)} onExpand={() => setExpanded(true)} />
          </aside>
        ) : null}
      </div>
      {section ? (
        <Popup title="Workflow settings" sub={`${def?.name ?? slug} · v${current.version}`} onClose={() => setSection(null)} footer={<span className="muted small">Changes apply to the next run. A run that has started keeps the version it began with.</span>}>
          <SettingsBody data={data} section={section} onSection={setSection} onClose={() => setSection(null)} />
        </Popup>
      ) : null}
      {expanded && step && nodes ? (
        <Popup title={<span className="mono">{step.id}</span>} onClose={() => setExpanded(false)}>
          <StepPanel node={step} nodes={nodes} tools={toolList} plan={plan.data} run={runStates[step.id]} runLabel={lastLabel} onPick={setSelected} onClose={() => setExpanded(false)} />
        </Popup>
      ) : null}
      {starting ? (
        <Popup title="Start a run" sub={`${def?.name ?? slug} · v${current.version}`} size="narrow" onClose={() => setStarting(false)}>
          <StartRun versionId={current.id} draft={current.draft} schema={version.data?.plan?.inputsSchema ?? def?.inputs} plan={plan.data} />
        </Popup>
      ) : null}
      <h2 className="section" id="run-plan">Run plan</h2>
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
  // The inputs the checks use settle half a second after typing stops.
  const [settled, setSettled] = useState<Record<string, unknown>>({});
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setSettled(formValues(schema, values));
      } catch {
        /* the form shows what is wrong when it is submitted */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [values, schema]);
  const pre = useQuery({
    queryKey: ['preflight', versionId, JSON.stringify(settled)],
    queryFn: () => api<PreflightReport>(`/v1/versions/${encodeURIComponent(versionId)}/preflight`, { method: 'POST', body: { inputs: settled } }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const start = useMutation({
    mutationFn: (test: boolean) => api<{ run_id: string }>('/v1/runs', { method: 'POST', body: { version: versionId, inputs: formValues(schema, values), ...(test ? { test: true } : { preflight: true }) } }),
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
  const failed = pre.data?.checks.filter((c) => c.status === 'fail') ?? [];
  const warned = pre.data?.checks.filter((c) => c.status === 'warn') ?? [];
  const passed = pre.data?.checks.filter((c) => c.status === 'ok') ?? [];
  return (
    <form onSubmit={(e) => { e.preventDefault(); go(false); }}>
      <SchemaFields schema={schema} values={values} onChange={setValues} />
      <section className="preflight" aria-label="Checks before the run" aria-live="polite">
        <h3>Before it starts</h3>
        {pre.isFetching && !pre.data ? <p className="muted small">Checking tools, tokens and repositories…</p> : null}
        {pre.error ? <p className="warn-text small">The checks could not run: {(pre.error as Error).message}</p> : null}
        {failed.map((c) => (
          <div key={c.id} className="pf-line bad"><Badge tone="bad">{c.node ?? c.kind}</Badge> {c.message}{c.fix ? <div className="muted small">{c.fix}</div> : null}</div>
        ))}
        {warned.map((c) => (
          <div key={c.id} className="pf-line warn"><Badge tone="warn">{c.node ?? c.kind}</Badge> {c.message}</div>
        ))}
        {pre.data ? (
          <details className="small">
            <summary>{failed.length ? `${passed.length} other checks passed` : `${passed.length} checks passed`}{pre.isFetching ? ', checking again…' : ''}</summary>
            {passed.map((c) => <div key={c.id} className="pf-line ok"><Badge tone="ok">{c.node ?? c.kind}</Badge> {c.message}</div>)}
          </details>
        ) : null}
        {pre.data && pre.data.ok ? <p className="ok-note">Every tool, token and repository this run needs is in place.</p> : null}
      </section>
      {blocked ? <p className="warn-note">The run plan has {plan.blockers.length} blocker(s), so a real run will be refused. A test run mocks writes and still works.</p> : null}
      {failed.length ? <p className="warn-note">A real run is blocked until these are fixed. A test run mocks writes and still works.</p> : null}
      {draft ? <p className="muted small">This is a draft version.</p> : null}
      <div className="row">
        <button type="submit" className="primary" disabled={start.isPending || blocked || failed.length > 0 || pre.isFetching}>Start run</button>
        <button type="button" disabled={start.isPending} onClick={() => go(true)} title="Writes are mocked">Test run</button>
        <button type="button" className="small" disabled={pre.isFetching} onClick={() => void pre.refetch()}>Check again</button>
      </div>
      {formError ? <div className="error">{formError}</div> : null}
      <ErrorNote error={start.error} />
    </form>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNote, Panel } from '../ui';
import { HarnessGuides, NeedList, type Guide } from '../components/LibraryParts';
import { McpForm } from './Authoring';

type How = 'hosted' | 'package';
type Runner = 'npx' | 'uvx' | 'docker' | 'other';
type Env = { name: string; secret: boolean };
type Preview = { ok: boolean; errors: string[]; guides: Guide[] };

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/**
 * One guided flow for adding an MCP server. It asks how the server runs, builds the definition, shows what it
 * becomes in each harness as you type, saves it as a draft library asset, and (for hosted servers) can also
 * connect it to Azhi's gateway so tool steps and model agents can call it.
 */
export function McpWizard({ onDone, onBrowse }: { onDone: () => void; onBrowse: () => void }) {
  const qc = useQueryClient();
  const [how, setHow] = useState<How>();
  const [name, setName] = useState(''); const [slug, setSlug] = useState('');
  const [url, setUrl] = useState(''); const [auth, setAuth] = useState<'none' | 'bearer' | 'header'>('none'); const [authVar, setAuthVar] = useState(''); const [header, setHeader] = useState('X-API-Key');
  const [runner, setRunner] = useState<Runner>('npx'); const [pkg, setPkg] = useState(''); const [args, setArgs] = useState(''); const [other, setOther] = useState('');
  const [env, setEnv] = useState<Env[]>([]);
  const [gateway, setGateway] = useState(false);
  const [saved, setSaved] = useState<{ name: string; url?: string }>();

  const definition = (): Record<string, unknown> => {
    if (how === 'hosted') {
      const v = authVar || `${(slug || 'server').toUpperCase().replace(/-/g, '_')}_TOKEN`;
      const headers = auth === 'bearer' ? { Authorization: `Bearer {env:${v}}` } : auth === 'header' ? { [header]: `{env:${v}}` } : undefined;
      return { transport: 'remote', url, ...(headers ? { headers } : {}), enabled: true,
        ...(auth !== 'none' ? { needs: [{ name: v, secret: true, required: true, description: 'Token for the server' }] } : {}) };
    }
    const names = env.filter((e) => e.name.trim());
    const command = runner === 'npx' ? ['npx', '-y', pkg.trim(), ...words(args)]
      : runner === 'uvx' ? ['uvx', pkg.trim(), ...words(args)]
        : runner === 'docker' ? ['docker', 'run', '-i', '--rm', ...names.flatMap((e) => ['-e', e.name.trim()]), pkg.trim(), ...words(args)]
          : words(other);
    return { transport: 'local', command, ...(names.length ? { environment: Object.fromEntries(names.map((e) => [e.name.trim(), `{env:${e.name.trim()}}`])) } : {}), enabled: true,
      ...(names.length ? { needs: names.map((e) => ({ name: e.name.trim(), secret: e.secret, required: true })) } : {}) };
  };
  const body = { kind: 'mcp', slug: slug || 'server', name: name || 'MCP server', description: '', definition: definition() };
  const dbody = useDebounced(JSON.stringify(body));
  const ready = Boolean(how && slug && (how === 'hosted' ? url : runner === 'other' ? other.trim() : pkg.trim()));
  const preview = useQuery({ queryKey: ['mcp-preview', dbody], enabled: ready, queryFn: () => api<Preview>('/v1/assets/preview-guides', { method: 'POST', body: JSON.parse(dbody) }), placeholderData: (p) => p });
  const save = useMutation({
    mutationFn: () => api('/v1/assets', { method: 'POST', body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['portable-assets'] }); setSaved({ name: slug, ...(how === 'hosted' ? { url } : {}) }); },
  });

  if (!how) {
    return (
      <Panel title="Add an MCP server: how does it run?">
        <p className="muted">An MCP server gives agents tools. Pick how yours is reached; Azhi writes the setup for OpenCode and Claude Code.</p>
        <div className="wiz-cards">
          <button type="button" className="wiz-card" onClick={() => setHow('hosted')}><b>It is hosted at a URL</b><span>A company runs it for you, for example <code>https://mcp.example.com/mcp</code>. You may need a token.</span></button>
          <button type="button" className="wiz-card" onClick={() => setHow('package')}><b>A package I run on a worker</b><span>An npm or Python package, or a Docker image, started on the machine that runs the agent. It runs code there, so check where it comes from.</span></button>
          <button type="button" className="wiz-card" onClick={onBrowse}><b>I do not know yet</b><span>Search the official MCP Registry for a server and import it with one click.</span></button>
        </div>
      </Panel>
    );
  }
  if (saved) {
    return (
      <Panel title={`Saved “${saved.name}” as a draft`}>
        <p className="ok-note" role="status">It is in <b>My library</b> as a draft. Set the environment variables below on every machine that runs the harness, then publish it and attach it to a workflow.</p>
        {(definition().needs as Array<{ name: string; secret: boolean; required: boolean }> | undefined)?.length ? <NeedList needs={definition().needs as never} /> : null}
        {gateway && saved.url ? (
          <>
            <h4>Connect it to Azhi's gateway too</h4>
            <p className="muted small">This lets tool steps and model agents call it, with every write recorded in the run's action ledger.</p>
            <McpForm initial={{ name: saved.name, url: saved.url }} />
          </>
        ) : null}
        <div className="row"><button type="button" className="primary" onClick={onDone}>Done</button></div>
      </Panel>
    );
  }
  return (
    <Panel title={how === 'hosted' ? 'Add a hosted MCP server' : 'Add an MCP server that runs on a worker'} action={<button type="button" className="small" onClick={() => setHow(undefined)}>Back</button>}>
      <form className="lib-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label>Name<input required value={name} onChange={(e) => { setName(e.target.value); if (!slug || slug === kebab(name)) setSlug(kebab(e.target.value)); }} placeholder="Linear" /></label>
        <label>Short name<input required pattern="[a-z0-9][a-z0-9\-]*" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="linear" /><span className="muted small">Its key in the harness config.</span></label>
        {how === 'hosted' ? (
          <>
            <label className="wide">URL<span className="muted small">The streamable HTTP endpoint, starting with https://.</span><input required type="url" pattern="https://.*" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.linear.app/mcp" /></label>
            <label>Sign-in<select value={auth} onChange={(e) => setAuth(e.target.value as typeof auth)}><option value="none">None, or the harness handles OAuth</option><option value="bearer">Bearer token</option><option value="header">A custom header</option></select></label>
            {auth !== 'none' ? <label>Environment variable holding the token<input value={authVar} onChange={(e) => setAuthVar(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} placeholder={`${(slug || 'server').toUpperCase().replace(/-/g, '_')}_TOKEN`} /><span className="muted small">The token itself is never stored in Azhi's library.</span></label> : null}
            {auth === 'header' ? <label>Header name<input value={header} onChange={(e) => setHeader(e.target.value)} /></label> : null}
          </>
        ) : (
          <>
            <label>Started with<select value={runner} onChange={(e) => setRunner(e.target.value as Runner)}><option value="npx">npx (an npm package)</option><option value="uvx">uvx (a Python package)</option><option value="docker">docker (a container image)</option><option value="other">Another command</option></select></label>
            {runner === 'other' ? <label className="wide">Command<input required value={other} onChange={(e) => setOther(e.target.value)} placeholder="node ./server.js --stdio" /></label> : <label>{runner === 'docker' ? 'Image' : 'Package'}<input required value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder={runner === 'npx' ? '@modelcontextprotocol/server-filesystem' : runner === 'uvx' ? 'mcp-server-git' : 'ghcr.io/org/server:1.0'} /></label>}
            {runner !== 'other' ? <label className="wide">Arguments<span className="muted small">Separated by spaces, after the package name.</span><input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="/workspace" /></label> : null}
            <fieldset className="wide wiz-env"><legend>Environment variables it needs</legend>
              {env.map((e, i) => (
                <div className="row" key={i}>
                  <input aria-label="Variable name" value={e.name} onChange={(ev) => setEnv(env.map((x, j) => (j === i ? { ...x, name: ev.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))} placeholder="API_KEY" />
                  <label className="row"><input type="checkbox" checked={e.secret} onChange={(ev) => setEnv(env.map((x, j) => (j === i ? { ...x, secret: ev.target.checked } : x)))} /> secret</label>
                  <button type="button" className="small" onClick={() => setEnv(env.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
              <button type="button" className="small" onClick={() => setEnv([...env, { name: '', secret: true }])}>Add a variable</button>
              <span className="muted small">Only the names are saved. Set the values on the machine that runs the harness.</span>
            </fieldset>
          </>
        )}
        <fieldset className="wide wiz-use"><legend>Where will it be used?</legend>
          <label className="row"><input type="checkbox" checked disabled /> <span><b>Harness agents</b> (OpenCode, Claude Code). Saved to your library as a draft.</span></label>
          {how === 'hosted' ? <label className="row"><input type="checkbox" checked={gateway} onChange={(e) => setGateway(e.target.checked)} /> <span><b>Azhi tool steps and model agents</b>, through the governed gateway (recorded in the action ledger). Available for hosted servers.</span></label> : <p className="muted small">Servers that run on a worker are for harness agents. To use one in tool steps, host it and add its URL.</p>}
        </fieldset>
        <div className="wide row"><button className="primary" disabled={save.isPending || !ready || preview.data?.ok === false}>Save draft</button><span className="muted small">You review and publish it next.</span></div>
        <ErrorNote error={save.error} />
      </form>
      {ready && preview.data ? (
        preview.data.ok ? <HarnessGuides key={preview.data.guides.map((g) => g.harness).join()} guides={preview.data.guides} /> : <ul className="lib-warn">{preview.data.errors.map((e) => <li key={e}>{e}</li>)}</ul>
      ) : <p className="muted small">Fill in the fields to see the setup for each harness.</p>}
    </Panel>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ChatgptLogin } from '../components/ChatgptLogin';
import { CopilotLogin } from '../components/CopilotLogin';
import { ago, ErrorNote, Loading, PageHead, Panel, Table, when } from '../ui';

interface Secret { name: string; version: number; updated_at: string }

/** Secrets are write-only here: the API never returns a value to a user, and neither does this page. */
export function Secrets() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['secrets'], queryFn: () => api<Secret[]>('/v1/secrets') });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<string>();
  const set = useMutation({
    mutationFn: () => api<{ version: number }>(`/v1/secrets/${encodeURIComponent(name.trim())}`, { method: 'PUT', body: { value } }),
    onSuccess: (r) => {
      setSaved(`${name.trim()} is now version ${r.version}.`);
      setValue('');
      void qc.invalidateQueries({ queryKey: ['secrets'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(undefined);
    set.mutate();
  };
  // Pasted keys often carry spaces or invisible characters that no API key contains.
  const odd = /[\s​-‍﻿]/.test(value);
  return (
    <>
      <PageHead title="Secrets" sub="Values are encrypted on the server and only resolved when a run needs them. This page can set a value but never shows one." />
      <div className="grid-2">
        <Panel title="Stored secrets">
          <ErrorNote error={q.error} />
          {!q.data ? <Loading /> : (
            <Table head={['Name', 'Version', 'Changed']} empty="No secrets yet.">
              {q.data.map((s) => (
                <tr key={s.name}>
                  <td className="mono"><button className="link mono" onClick={() => setName(s.name)} title="Set a new value">{s.name}</button></td>
                  <td>v{s.version}</td>
                  <td title={when(s.updated_at)}>{ago(s.updated_at)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        <Panel title="Set a secret">
          <form onSubmit={submit} className="fields">
            <div className="field">
              <label htmlFor="secret-name">Name</label>
              <input id="secret-name" className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="anthropic-api-key" required pattern="[A-Za-z0-9._-]+" />
            </div>
            <div className="field">
              <label htmlFor="secret-value">Value</label>
              <input id="secret-value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} required />
              {odd ? <span className="hint warn-text">This value contains spaces or invisible characters. API keys never do; check what you pasted.</span> : null}
            </div>
            <div className="row">
              <button type="submit" className="primary" disabled={set.isPending || !name.trim() || !value}>Save new version</button>
            </div>
            {saved ? <p className="ok-note">{saved}</p> : null}
            <ErrorNote error={set.error} />
          </form>
        </Panel>
        <Panel title="GitHub Copilot">
          <p className="muted small">OpenCode steps can use the models of your GitHub Copilot subscription. Signing in stores the sign-in as the secret github-copilot-token.</p>
          <CopilotLogin />
        </Panel>
        <Panel title="ChatGPT plan">
          <p className="muted small">OpenCode steps can use the OpenAI models of your ChatGPT plan (Plus, Pro, Business). Signing in stores the sign-in as the secret openai-chatgpt-auth; Azhi renews it itself, so give Azhi its own sign-in rather than your OpenCode's.</p>
          <ChatgptLogin />
        </Panel>
        <Panel title="Claude plan">
          <p className="muted small">Claude Agent SDK steps can use your Claude Pro or Max plan, for your own use. Run <code>claude setup-token</code> on any computer with Claude Code, then save the token (it starts with sk-ant-oat) above as a secret such as claude-plan-token, and name it as the profile's credential. Anthropic does not allow plan tokens in OpenCode or direct API calls, so Azhi refuses them there.</p>
        </Panel>
      </div>
    </>
  );
}

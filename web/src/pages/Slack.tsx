import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, atLeast } from '../api';
import { useMe } from '../App';
import { ModelPicker, type ProviderInfo } from '../components/ModelMenu';
import { Link } from '../router';
import { ErrorNote, Loading, PageHead, Panel } from '../ui';

/** Slack settings (admin): approval buttons, runs started from Slack, and chat with the assistant. */
export function Slack() {
  const me = useMe();
  if (!atLeast(me.data?.role, 'admin')) {
    return (
      <>
        <PageHead title="Slack" />
        <div className="empty"><p className="empty-title">Slack settings are for admins.</p></div>
      </>
    );
  }
  return (
    <>
      <PageHead title="Slack" sub="Decide approvals, start workflows and chat with the assistant from Slack." />
      <Panel title="Approvals in Slack"><SlackApprovals /></Panel>
      <Panel title="Run workflows from Slack"><SlackCommands /></Panel>
      <Panel title="Chat with the assistant in Slack"><SlackAssistant /></Panel>
    </>
  );
}

interface ApprovalSettings { slack_channel: string | null; slack_token_set: boolean; signing_secret_set: boolean; interactivity_url: string }

/** Where waiting approvals are posted with Approve and Reject buttons, and what Slack needs. */
function SlackApprovals() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'approvals'], queryFn: () => api<ApprovalSettings>('/v1/settings/approvals') });
  const [channel, setChannel] = useState('');
  useEffect(() => setChannel(q.data?.slack_channel ?? ''), [q.data]);
  const save = useMutation({
    mutationFn: () => api('/v1/settings/approvals', { method: 'PUT', body: { slack_channel: channel.trim() || null } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'approvals'] }),
  });
  if (!q.data) return <Loading />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="fields">
      <p className="muted small">Each waiting approval is posted once to this channel with Approve and Reject buttons. A click counts only for a Slack user linked to an Azhi Flow user (on the <Link to="/ui/users">Users</Link> page), with that user's role. Decisions that need a form are made here.</p>
      {!q.data.slack_token_set ? <p className="warn-note">Set the <Link to="/ui/secrets">secret</Link> <code>slack-bot-token</code>.</p> : null}
      {!q.data.signing_secret_set ? <p className="warn-note">Set the <Link to="/ui/secrets">secret</Link> <code>slack-signing-secret</code> (the Slack app's signing secret), so button clicks can be verified.</p> : null}
      <div className="field">
        <label htmlFor="approval-channel">Channel ID</label>
        <input id="approval-channel" className="mono" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C0123456789" />
      </div>
      <div className="field">
        <span className="small">In the Slack app's settings, turn on Interactivity with this request URL:</span>
        <code className="mono small">{q.data.interactivity_url}</code>
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>Save Slack settings</button>
        {save.isSuccess ? <span className="ok-note">Saved.</span> : null}
      </div>
      <ErrorNote error={save.error} />
    </form>
  );
}

interface CommandSettings { enabled: boolean; workflows: string[]; channel: string | null; slack_token_set: boolean; signing_secret_set: boolean; command_url: string; events_url: string }

/** Which workflows `/azhi run` may start, and where its thread goes. Nothing is startable until a workflow is listed. */
function SlackCommands() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'slack-commands'], queryFn: () => api<CommandSettings>('/v1/settings/slack-commands') });
  const [enabled, setEnabled] = useState(false);
  const [workflows, setWorkflows] = useState('');
  const [channel, setChannel] = useState('');
  useEffect(() => {
    setEnabled(q.data?.enabled ?? false);
    setWorkflows((q.data?.workflows ?? []).join(', '));
    setChannel(q.data?.channel ?? '');
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('/v1/settings/slack-commands', { method: 'PUT', body: { enabled, workflows: workflows.split(/[\s,]+/).filter(Boolean), channel: channel.trim() || null } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'slack-commands'] }),
  });
  if (!q.data) return <Loading />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="fields">
      <p className="muted small">Type <code>/azhi run &lt;workflow&gt; key=value</code> in Slack to start a workflow. It runs as the Azhi Flow user linked to the Slack user (on the <Link to="/ui/users">Users</Link> page), who needs the operator role. Approvals and the result appear in a thread.</p>
      {!q.data.slack_token_set ? <p className="warn-note">Set the <Link to="/ui/secrets">secret</Link> <code>slack-bot-token</code>.</p> : null}
      {!q.data.signing_secret_set ? <p className="warn-note">Set the <Link to="/ui/secrets">secret</Link> <code>slack-signing-secret</code>, so commands can be verified.</p> : null}
      <label className="row small"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Allow runs from Slack</label>
      <div className="field">
        <label htmlFor="slack-cmd-workflows">Workflows Slack may start (slugs, comma separated)</label>
        <input id="slack-cmd-workflows" className="mono" value={workflows} onChange={(e) => setWorkflows(e.target.value)} placeholder="quality-report, pr-review" />
      </div>
      <div className="field">
        <label htmlFor="slack-cmd-channel">Thread channel ID (optional; defaults to the channel the command was typed in)</label>
        <input id="slack-cmd-channel" className="mono" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C0123456789" />
      </div>
      <div className="field">
        <span className="small">In the Slack app, add a slash command <code>/azhi</code> with this request URL:</span>
        <code className="mono small">{q.data.command_url}</code>
      </div>
      <div className="field">
        <span className="small">To start runs by tagging the app (<code>@azhi run &lt;workflow&gt; key=value</code>), turn on Event Subscriptions with this request URL, subscribe to the <code>app_mention</code> bot event, and add the <code>app_mentions:read</code> scope:</span>
        <code className="mono small">{q.data.events_url}</code>
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>Save</button>
        {save.isSuccess ? <span className="ok-note">Saved.</span> : null}
      </div>
      <ErrorNote error={save.error} />
    </form>
  );
}

interface AssistantSettings { enabled: boolean; provider: string | null; model: string | null }
interface AssistantStatus { providers: ProviderInfo[]; default?: string }

/** Whether people may chat with the assistant from Slack, by DM or by mentioning the app in a channel. */
function SlackAssistant() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'slack-assistant'], queryFn: () => api<AssistantSettings>('/v1/settings/slack-assistant') });
  const status = useQuery({ queryKey: ['assistant'], queryFn: () => api<AssistantStatus>('/v1/assistant'), staleTime: 60_000 });
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => {
    setEnabled(q.data?.enabled ?? false);
    setProvider(q.data?.provider ?? null);
    setModel(q.data?.model ?? null);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('/v1/settings/slack-assistant', { method: 'PUT', body: { enabled, provider, model: provider ? model : null } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'slack-assistant'] }),
  });
  if (!q.data) return <Loading />;
  const defaultInfo = status.data?.providers.find((p) => p.id === status.data?.default);
  const savedInfo = status.data?.providers.find((p) => p.id === provider);
  const chosenProvider = defaultInfo?.id ?? status.data?.providers.find((p) => p.ready)?.id ?? status.data?.providers[0]?.id ?? null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="fields">
      <p className="muted small">People can DM the app, or mention <code>@azhi</code> in a channel it has been invited to. Each conversation is a Slack thread. Actions the assistant proposes run only after a Confirm click from the person who started the thread. Slack users must be linked to an Azhi Flow user on the <Link to="/ui/users">Users</Link> page. A mention that starts with <code>run</code> still starts a workflow, as set up in "Run workflows from Slack" above.</p>
      <label className="row small"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Allow chat with the assistant from Slack</label>
      <div className="field">
        <span className="small">Model</span>
        <select aria-label="Model source" value={provider ? 'chosen' : 'default'} onChange={(e) => {
          if (e.target.value === 'default') { setProvider(null); setModel(null); }
          else { setProvider(chosenProvider); setModel(null); }
        }}>
          <option value="default">Workspace default{defaultInfo ? ` (${defaultInfo.label}${defaultInfo.model ? `, ${defaultInfo.model}` : ''})` : ''}</option>
          <option value="chosen">Choose a provider and model</option>
        </select>
        {provider && status.data ? <ModelPicker providers={status.data.providers} provider={provider} model={model ?? savedInfo?.model} serverDefault={savedInfo?.model} onChange={(c) => { setProvider(c.provider ?? provider); setModel(c.model ?? null); }} modelsUrl="/v1/assistant/models" purpose="Slack chat" /> : null}
        {savedInfo && !savedInfo.ready && q.data.provider === provider ? <span className="muted small">{savedInfo.label} is not ready: {savedInfo.reason}. Slack chat will answer with an error until it is.</span> : null}
        <span className="muted small">Applies to every Slack conversation, from the next message.</span>
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>Save</button>
        {save.isSuccess ? <span className="ok-note">Saved.</span> : null}
      </div>
      <ErrorNote error={save.error} />
    </form>
  );
}

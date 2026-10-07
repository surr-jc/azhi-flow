import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNote } from '../ui';

interface Started { id: string; user_code: string; verification_uri: string; interval: number }

/**
 * Signs in with a ChatGPT plan through OpenAI's device sign-in (the same as `azhi chatgpt login`):
 * the server asks OpenAI for a code, the person enters it on OpenAI's page, and the server stores
 * the sign-in as a secret and renews it from then on. The tokens never reach this page.
 */
export function ChatgptLogin({ secret = 'openai-chatgpt-auth' }: { secret?: string }) {
  const qc = useQueryClient();
  const [started, setStarted] = useState<Started>();
  const [state, setState] = useState<'idle' | 'starting' | 'waiting' | 'done'>('idle');
  const [error, setError] = useState<unknown>();
  const [check, setCheck] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    if (!started || state !== 'waiting') return;
    let interval = started.interval;
    let timer: ReturnType<typeof setTimeout>;
    let live = true;
    const poll = async () => {
      try {
        const r = await api<{ status: string; interval?: number; message?: string }>(`/v1/chatgpt/login/${started.id}`, { method: 'POST', body: {} });
        if (!live) return;
        if (r.status === 'done') {
          setState('done');
          void qc.invalidateQueries({ queryKey: ['secrets'] });
          return;
        }
        if (r.status !== 'pending') {
          setState('idle');
          setError(new Error(`Not signed in: ${r.message ?? r.status}. Start again.`));
          return;
        }
        interval = r.interval ?? interval;
      } catch (e) {
        if (!live) return;
        setState('idle');
        setError(e);
        return;
      }
      timer = setTimeout(poll, interval * 1000);
    };
    timer = setTimeout(poll, interval * 1000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [started, state, qc]);

  const start = async () => {
    setError(undefined);
    setState('starting');
    try {
      setStarted(await api<Started>('/v1/chatgpt/login', { method: 'POST', body: { secret } }));
      setState('waiting');
    } catch (e) {
      setState('idle');
      setError(e);
    }
  };

  const verify = async () => {
    setError(undefined);
    try {
      setCheck(await api<{ ok: boolean; message: string }>('/v1/chatgpt/check', { method: 'POST', body: { secret } }));
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="copilot-login">
      {state === 'waiting' && started ? (
        <p role="status">
          Open <a href={started.verification_uri} target="_blank" rel="noreferrer">{started.verification_uri}</a> and enter the code{' '}
          <strong className="mono" aria-label="Device code">{started.user_code}</strong>. Waiting for OpenAI…
        </p>
      ) : state === 'done' ? (
        <p className="ok-note" role="status">Signed in with your ChatGPT plan; saved as {secret}.</p>
      ) : (
        <button type="button" className="small" disabled={state === 'starting'} onClick={() => void start()}>Sign in with ChatGPT</button>
      )}
      {state !== 'waiting' ? <button type="button" className="small" onClick={() => void verify()}>Check sign-in</button> : null}
      {check ? <p className={check.ok ? 'ok-note' : 'warn-text'} role="status">{check.message}</p> : null}
      <ErrorNote error={error} />
    </div>
  );
}

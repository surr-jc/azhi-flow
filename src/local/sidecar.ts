import { startLocal } from './up.js';

/**
 * Entry point for the desktop app (desktop/). The Electron shell starts this file with a bundled Node
 * and an IPC channel, so the backend is the same `azhi up` code in a process of its own: a worker
 * burst never freezes the window, and the spawn sites that use `process.execPath` get real Node.
 *
 * Messages to the parent: `{type:'ready', url, token}` or `{type:'error', message}`.
 * From the parent: `{type:'shutdown'}`. A closed channel also stops it, so the backend never
 * outlives the app. On Windows there is no SIGTERM, which is why this is a message.
 */
const send = (m: Record<string, unknown>) =>
  new Promise<void>((resolve) => {
    if (!process.send) return resolve();
    process.send(m, () => resolve());
  });

async function main() {
  if (!process.send) {
    console.error('sidecar: start it with an IPC channel (the desktop app does); use `azhi up` from a terminal');
    process.exit(2);
  }
  let handle: Awaited<ReturnType<typeof startLocal>> | undefined;
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    await handle?.stop().catch(() => {});
    process.exit(code);
  };
  process.on('message', (m: { type?: string }) => {
    if (m?.type === 'shutdown') void stop();
  });
  process.on('disconnect', () => void stop());
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  try {
    handle = await startLocal();
  } catch (err) {
    await send({ type: 'error', message: (err as Error).message });
    process.exit(1);
  }
  if (stopping) return;
  await send({ type: 'ready', url: handle.url, token: handle.token });
}

void main();

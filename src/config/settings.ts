import { homedir } from 'node:os';
import { join } from 'node:path';

/** Server and worker settings, from the environment. */
export function settings() {
  const dataDir = process.env.AZHI_DATA_DIR ?? join(homedir(), '.azhi', 'server');
  const port = Number(process.env.AZHI_PORT ?? 7400);
  return {
    databaseUrl: process.env.AZHI_DATABASE_URL ?? 'postgres://azhi:azhi@localhost:5432/azhi',
    temporalAddress: process.env.AZHI_TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: process.env.AZHI_TEMPORAL_NAMESPACE ?? 'default',
    dataDir,
    artifactDir: process.env.AZHI_ARTIFACT_DIR ?? join(dataDir, 'artifacts'),
    secretKey: process.env.AZHI_SECRET_KEY,
    authMode: (process.env.AZHI_AUTH_MODE ?? 'local') as 'local' | 'oidc',
    oidcIssuer: process.env.AZHI_OIDC_ISSUER,
    oidcAudience: process.env.AZHI_OIDC_AUDIENCE,
    host: process.env.AZHI_HOST ?? '127.0.0.1',
    port,
    publicUrl: process.env.AZHI_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
    slackApiUrl: process.env.AZHI_SLACK_API_URL,
    interpreterBuild: process.env.AZHI_INTERPRETER_BUILD,
  };
}
export type Settings = ReturnType<typeof settings>;

export const TASK_QUEUES = {
  interpreter: (build: string) => `azhi-interpreter-${build}`,
  gateway: 'azhi-gateway',
  exec: 'azhi-exec',
};

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
    secretKey: process.env.AZHI_SECRET_KEY || undefined,
    authMode: (process.env.AZHI_AUTH_MODE ?? 'local') as 'local' | 'oidc',
    oidcIssuer: process.env.AZHI_OIDC_ISSUER || undefined,
    oidcAudience: process.env.AZHI_OIDC_AUDIENCE || undefined,
    host: process.env.AZHI_HOST ?? '127.0.0.1',
    port,
    publicUrl: process.env.AZHI_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
    slackApiUrl: process.env.AZHI_SLACK_API_URL || undefined,
    interpreterBuild: process.env.AZHI_INTERPRETER_BUILD,
    /** Model for agent profiles that say `name: default`. */
    anthropicModel: process.env.AZHI_ANTHROPIC_MODEL || undefined,
    anthropicApiUrl: process.env.AZHI_ANTHROPIC_API_URL ?? 'https://api.anthropic.com',
    /** Context manifests always record hashes and token counts; content only on opt-in. */
    storeContextContent: process.env.AZHI_STORE_CONTEXT_CONTENT === '1',
    /** Deployments sharing one Temporal namespace need distinct gateway queues. */
    gatewayQueue: process.env.AZHI_GATEWAY_QUEUE || 'azhi-gateway',
  };
}
export type Settings = ReturnType<typeof settings>;

export const TASK_QUEUES = {
  interpreter: (build: string) => `azhi-interpreter-${build}`,
  /** Each execution worker polls its own queue so the interpreter can route by trust policy. */
  exec: (workerId: string) => `azhi-exec-${workerId}`,
};

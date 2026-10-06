import { homedir } from 'node:os';
import { join } from 'node:path';
import { COPILOT_CREDIT_USD, parseRates } from '../agents/copilot-pricing.js';

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
    /** Browser sign-in (mission control): the client registered with the issuer, redirecting to <publicUrl>/v1/auth/callback. */
    oidcClientId: process.env.AZHI_OIDC_CLIENT_ID || undefined,
    oidcClientSecret: process.env.AZHI_OIDC_CLIENT_SECRET || undefined,
    oidcScopes: process.env.AZHI_OIDC_SCOPES || 'openid email profile',
    host: process.env.AZHI_HOST ?? '127.0.0.1',
    port,
    publicUrl: process.env.AZHI_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
    slackApiUrl: process.env.AZHI_SLACK_API_URL || undefined,
    interpreterBuild: process.env.AZHI_INTERPRETER_BUILD,
    /** Model for agent profiles that say `name: default`. */
    anthropicModel: process.env.AZHI_ANTHROPIC_MODEL || undefined,
    anthropicApiUrl: process.env.AZHI_ANTHROPIC_API_URL ?? 'https://api.anthropic.com',
    /** Model for OpenAI profiles that say `name: default`. */
    openaiModel: process.env.AZHI_OPENAI_MODEL || undefined,
    openaiApiUrl: process.env.AZHI_OPENAI_API_URL ?? 'https://api.openai.com',
    /** GitHub Copilot model (through OpenCode) for profiles that say `name: default`. */
    copilotModel: process.env.AZHI_COPILOT_MODEL || 'gpt-5.6-luna',
    /** Copilot's API is OpenCode's default; set only to point at a stand-in (tests) or a proxy. */
    copilotApiUrl: process.env.AZHI_COPILOT_API_URL || undefined,
    /**
     * Copilot bills GitHub AI Credits for tokens at per-model rates (src/agents/copilot-pricing.ts).
     * USD per credit: 0.01 unless your contract says otherwise.
     */
    copilotCreditUsd: positive(process.env.AZHI_COPILOT_CREDIT_USD) ?? COPILOT_CREDIT_USD,
    /** Per-model rates, `model=input/cached/cache_write/output` USD per million tokens; extend and override GitHub's table. */
    copilotRates: parseRates(process.env.AZHI_COPILOT_RATES),
    /** The organization's monthly AI Credit pool, to show how much is left and what falls past it. */
    copilotCreditPool: positive(process.env.AZHI_COPILOT_CREDIT_POOL),
    /** Where the Copilot sign-in's device flow runs. */
    copilotGithubUrl: process.env.AZHI_COPILOT_GITHUB_URL || 'https://github.com',
    /** Context manifests always record hashes and token counts; content only on opt-in. */
    storeContextContent: process.env.AZHI_STORE_CONTEXT_CONTENT === '1',
    /** Deployments sharing one Temporal namespace need distinct gateway queues. */
    gatewayQueue: process.env.AZHI_GATEWAY_QUEUE || 'azhi-gateway',
  };
}
export type Settings = ReturnType<typeof settings>;

function positive(v: string | undefined): number | undefined {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export const TASK_QUEUES = {
  interpreter: (build: string) => `azhi-interpreter-${build}`,
  /** Each execution worker polls its own queue so the interpreter can route by trust policy. */
  exec: (workerId: string) => `azhi-exec-${workerId}`,
};

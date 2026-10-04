/** Drizzle table definitions mirroring migrations/*.sql. The SQL files are the source of truth. */
import { bigint, bigserial, boolean, customType, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  email: text('email'),
  displayName: text('display_name'),
  oidcIssuer: text('oidc_issuer'),
  oidcSubject: text('oidc_subject'),
  role: text('role').$type<Role>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type Role = 'owner' | 'admin' | 'author' | 'operator' | 'viewer';

export const apiTokens = pgTable('api_tokens', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
});

export const secrets = pgTable(
  'secrets',
  {
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    createdBy: text('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.name, t.version] })],
);

export const artifacts = pgTable(
  'artifacts',
  {
    workspaceId: text('workspace_id').notNull(),
    hash: text('hash').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    mediaType: text('media_type').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.hash] })],
);

export const tools = pgTable(
  'tools',
  {
    workspaceId: text('workspace_id').notNull(),
    toolId: text('tool_id').notNull(),
    version: integer('version').notNull(),
    revision: integer('revision').notNull(),
    spec: jsonb('spec').notNull(),
    specHash: text('spec_hash').notNull(),
    createdBy: text('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.toolId, t.version, t.revision] })],
);

export const workflows = pgTable('workflows', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  slug: text('slug').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const workflowVersions = pgTable('workflow_versions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  workflowId: text('workflow_id').notNull(),
  version: integer('version').notNull(),
  packageHash: text('package_hash').notNull(),
  manifest: jsonb('manifest').notNull(),
  definition: jsonb('definition').notNull(),
  plan: jsonb('plan').notNull(),
  draft: boolean('draft').notNull().default(true),
  signature: jsonb('signature'),
  publishedBy: text('published_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const schedules = pgTable('schedules', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  workflowId: text('workflow_id').notNull(),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull(),
  inputs: jsonb('inputs').notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  nextOccurrenceAt: ts('next_occurrence_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const runs = pgTable('runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  workflowVersionId: text('workflow_version_id').notNull(),
  state: text('state').notNull(),
  flags: jsonb('flags').notNull().default({}),
  inputs: jsonb('inputs').notNull().default({}),
  snapshot: jsonb('snapshot').notNull(),
  interpreterBuild: text('interpreter_build'),
  trigger: text('trigger').notNull(),
  occurrenceId: text('occurrence_id'),
  parentRunId: text('parent_run_id'),
  parentNodeId: text('parent_node_id'),
  test: boolean('test').notNull().default(false),
  error: jsonb('error'),
  createdBy: text('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
});

export const runEvents = pgTable('run_events', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  runId: text('run_id').notNull(),
  at: ts('at').notNull().defaultNow(),
  kind: text('kind').notNull(),
  nodeId: text('node_id'),
  data: jsonb('data').notNull().default({}),
});

export const nodeAttempts = pgTable(
  'node_attempts',
  {
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    nodeId: text('node_id').notNull(),
    attempt: integer('attempt').notNull(),
    state: text('state').notNull(),
    workerId: text('worker_id'),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
    error: jsonb('error'),
    output: jsonb('output'),
    observations: jsonb('observations'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.nodeId, t.attempt] })],
);

export const actions = pgTable('actions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  runId: text('run_id').notNull(),
  nodeId: text('node_id').notNull(),
  tool: text('tool').notNull(),
  effect: text('effect').notNull(),
  operationHash: text('operation_hash').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  target: jsonb('target').notNull().default({}),
  state: text('state').notNull(),
  fence: integer('fence').notNull(),
  receipt: jsonb('receipt'),
  error: jsonb('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const actionTransitions = pgTable('action_transitions', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  actionId: text('action_id').notNull(),
  state: text('state').notNull(),
  fence: integer('fence').notNull(),
  note: text('note'),
  at: ts('at').notNull().defaultNow(),
});

export const workers = pgTable('workers', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name: text('name').notNull(),
  ownerId: text('owner_id'),
  taskQueue: text('task_queue').notNull(),
  capabilities: jsonb('capabilities').notNull().default({}),
  trustPolicy: jsonb('trust_policy').notNull(),
  startedAt: ts('started_at').notNull().defaultNow(),
  lastHeartbeat: ts('last_heartbeat').notNull().defaultNow(),
});

export const interpreterBuilds = pgTable('interpreter_builds', {
  buildId: text('build_id').primaryKey(),
  startedAt: ts('started_at').notNull().defaultNow(),
  lastSeen: ts('last_seen').notNull().defaultNow(),
});

export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
});

export const auditEvents = pgTable('audit_events', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  actor: text('actor'),
  kind: text('kind').notNull(),
  data: jsonb('data').notNull().default({}),
  at: ts('at').notNull().defaultNow(),
});

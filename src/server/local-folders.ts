import type { AppContext } from './context.js';

/**
 * Local folders: git repositories on a worker's machine that a workflow may work in (`workspace.local`).
 * A workflow names a folder; the path is kept here, set by an admin, and never comes from workflow, ticket,
 * issue or pull request text. The server cannot see the folder: the worker checks it when a step starts.
 * A run works in its own git worktree of the folder, which the worker reports and this file records.
 */
export const LOCAL_FOLDER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface LocalFolder {
  name: string;
  path: string;
  created_at: string;
}

export interface RunWorktree {
  folder: string;
  path: string;
  branch: string;
  base_sha: string;
  worker_id: string | null;
  created_at: string;
  removed_at: string | null;
}

/** Why a path cannot be a local folder, or undefined when it is fine. Absolute on Windows or POSIX: the worker may run either. */
export function folderPathProblem(path: string): string | undefined {
  if (!path || path.length > 1024) return 'the path must be 1 to 1024 characters';
  if (path.includes('\0')) return 'the path contains a NUL character';
  if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('/')) return 'the path must be absolute (for example C:\\code\\api or /home/me/code/api)';
  if (path.split(/[\\/]/).includes('..')) return "the path may not contain '..'";
  return undefined;
}

/** A path as compared between machines: forward slashes, no trailing slash, lower case when it has a drive letter. */
const comparable = (p: string) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
};

/** True when `child` is `parent` or inside it. */
export function pathWithin(parent: string, child: string): boolean {
  const a = comparable(parent);
  const b = comparable(child);
  return b === a || b.startsWith(`${a}/`);
}

export async function listLocalFolders(ctx: AppContext, workspaceId: string): Promise<LocalFolder[]> {
  return (await ctx.pool.query(`SELECT name, path, created_at FROM local_folders WHERE workspace_id=$1 ORDER BY name`, [workspaceId])).rows as LocalFolder[];
}

export async function localFolderPath(ctx: AppContext, workspaceId: string, name: string): Promise<string | undefined> {
  return (await ctx.pool.query(`SELECT path FROM local_folders WHERE workspace_id=$1 AND name=$2`, [workspaceId, name])).rows[0]?.path as string | undefined;
}

export async function setLocalFolder(ctx: AppContext, workspaceId: string, name: string, path: string, userId: string): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO local_folders(workspace_id, name, path, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, name) DO UPDATE SET path=EXCLUDED.path, created_by=EXCLUDED.created_by, created_at=now()`,
    [workspaceId, name, path, userId],
  );
}

export async function deleteLocalFolder(ctx: AppContext, workspaceId: string, name: string): Promise<boolean> {
  return ((await ctx.pool.query(`DELETE FROM local_folders WHERE workspace_id=$1 AND name=$2`, [workspaceId, name])).rowCount ?? 0) > 0;
}

/** Online workers that were started with local folders allowed. */
export async function localFolderWorkers(ctx: AppContext, workspaceId: string): Promise<string[]> {
  const rows = (await ctx.pool.query(`SELECT name, capabilities FROM workers WHERE workspace_id=$1 AND last_heartbeat > now() - interval '30 seconds' ORDER BY name`, [workspaceId])).rows as Array<{ name: string; capabilities: { features?: string[] } }>;
  return rows.filter((w) => w.capabilities?.features?.includes('workspace_local')).map((w) => w.name);
}

/**
 * Records the worktree a worker made for a run. A later step of the same run reports it again: the
 * row is kept and only the first report adds a run event.
 */
export async function recordWorktree(ctx: AppContext, workspaceId: string, runId: string, nodeId: string | undefined, w: { folder: string; path: string; branch: string; base_sha: string; worker_id?: string }): Promise<{ created: boolean }> {
  const r = await ctx.pool.query(
    `INSERT INTO run_worktrees(workspace_id, run_id, folder, path, branch, base_sha, worker_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (run_id, folder) DO NOTHING`,
    [workspaceId, runId, w.folder, w.path, w.branch, w.base_sha, w.worker_id ?? null],
  );
  const created = (r.rowCount ?? 0) > 0;
  if (created) {
    await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, node_id, data) VALUES ($1,$2,'run.worktree',$3,$4)`, [workspaceId, runId, nodeId ?? null, JSON.stringify({ folder: w.folder, path: w.path, branch: w.branch, base_sha: w.base_sha })]);
  } else {
    // The folder was removed and a later step made it again.
    await ctx.pool.query(`UPDATE run_worktrees SET removed_at=NULL, path=$3 WHERE run_id=$1 AND folder=$2 AND removed_at IS NOT NULL`, [runId, w.folder, w.path]);
  }
  return { created };
}

export async function markWorktreeRemoved(ctx: AppContext, workspaceId: string, runId: string, folder: string): Promise<boolean> {
  const r = await ctx.pool.query(`UPDATE run_worktrees SET removed_at=now() WHERE workspace_id=$1 AND run_id=$2 AND folder=$3 AND removed_at IS NULL`, [workspaceId, runId, folder]);
  if (!r.rowCount) return false;
  await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, data) VALUES ($1,$2,'run.worktree_removed',$3)`, [workspaceId, runId, JSON.stringify({ folder })]);
  return true;
}

export async function runWorktrees(ctx: AppContext, runId: string): Promise<RunWorktree[]> {
  return (await ctx.pool.query(`SELECT folder, path, branch, base_sha, worker_id, created_at, removed_at FROM run_worktrees WHERE run_id=$1 ORDER BY created_at, folder`, [runId])).rows as RunWorktree[];
}

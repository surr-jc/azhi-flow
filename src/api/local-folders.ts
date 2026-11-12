import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { LOCAL_FOLDER_NAME, deleteLocalFolder, folderPathProblem, listLocalFolders, localFolderPath, localFolderWorkers, markWorktreeRemoved, pathWithin, recordWorktree, setLocalFolder } from '../server/local-folders.js';
import { requireRole } from './auth.js';

/**
 * Local folders (docs/local-workspaces.md): the registry a workflow's `workspace.local` names, and the
 * worktrees workers make of them. Reading needs any user; changing the registry needs admin and is audited.
 */
function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

const folderName = (req: FastifyRequest) => {
  const name = (req.params as { name: string }).name;
  if (!LOCAL_FOLDER_NAME.test(name)) throw new AzhiError(ErrorClass.invalidInput, 'a local folder name is lower-case letters, digits and hyphens (up to 63 characters)');
  return name;
};

export function registerLocalFolderRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/local-folders', async (req) => {
    const p = user(req);
    const [folders, workers] = await Promise.all([listLocalFolders(ctx, p.workspaceId), localFolderWorkers(ctx, p.workspaceId)]);
    return { folders, workers };
  });

  app.put('/v1/local-folders/:name', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const name = folderName(req);
    const b = z.object({ path: z.string().trim() }).parse(req.body);
    const problem = folderPathProblem(b.path);
    if (problem) throw new AzhiError(ErrorClass.invalidInput, problem);
    await setLocalFolder(ctx, p.workspaceId, name, b.path, p.userId);
    await audit(ctx, p.workspaceId, p.userId, 'local_folder.set', { name, path: b.path });
    return { name, path: b.path };
  });

  app.delete('/v1/local-folders/:name', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const name = folderName(req);
    const removed = await deleteLocalFolder(ctx, p.workspaceId, name);
    if (removed) await audit(ctx, p.workspaceId, p.userId, 'local_folder.removed', { name });
    return { removed };
  });

  // A harness reports the worktree it made for its run, with the run token. The folder must be registered,
  // and the worktree may not be the folder itself or inside it: a run never works in the person's own checkout.
  app.post('/v1/gateway/worktree', async (req) => {
    if (req.principal.kind !== 'run') throw new AzhiError(ErrorClass.authorization, 'worktrees need a run-scoped token');
    const c = req.principal.claims;
    const b = z
      .object({ folder: z.string().regex(LOCAL_FOLDER_NAME), path: z.string().max(1024), branch: z.string().min(1).max(200), base_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), worker_id: z.string().max(200).optional() })
      .parse(req.body);
    const registered = await localFolderPath(ctx, c.ws, b.folder);
    if (!registered) throw new AzhiError(ErrorClass.invalidInput, `local folder '${b.folder}' is not registered in this workspace`);
    const problem = folderPathProblem(b.path);
    if (problem) throw new AzhiError(ErrorClass.invalidInput, `worktree path: ${problem}`);
    if (pathWithin(registered, b.path)) throw new AzhiError(ErrorClass.invalidInput, 'a worktree may not be the local folder itself or inside it');
    return recordWorktree(ctx, c.ws, c.run, c.node, b);
  });

  // `azhi worktree remove` tells the server the folder is gone, so the run page stops offering it.
  app.post('/v1/runs/:id/worktrees/:folder/removed', async (req) => {
    const p = user(req);
    requireRole(p, 'operator');
    const { id, folder } = req.params as { id: string; folder: string };
    return { removed: await markWorktreeRemoved(ctx, p.workspaceId, id, folder) };
  });
}

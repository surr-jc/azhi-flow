import type { PackageManifest } from '../definition/package.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import type { AppContext } from './context.js';

const manifests = new Map<string, PackageManifest>();

export async function packageManifest(ctx: AppContext, workspaceId: string, packageHash: string): Promise<PackageManifest> {
  const key = `${workspaceId}:${packageHash}`;
  const cached = manifests.get(key);
  if (cached) return cached;
  const r = await ctx.pool.query(`SELECT manifest FROM workflow_versions WHERE workspace_id=$1 AND package_hash=$2 LIMIT 1`, [workspaceId, packageHash]);
  if (!r.rows[0]) throw new AzhiError(ErrorClass.internal, `package ${packageHash} not found`);
  manifests.set(key, r.rows[0].manifest);
  return r.rows[0].manifest;
}

/**
 * Makes a package that is not stored as a version readable by packageFile (the workflow builder
 * run-plans a proposal before it is saved): its files go to the content-addressed artifact store,
 * as an upload would put them, and its manifest is remembered by hash.
 */
export function stagePackage(ctx: AppContext, workspaceId: string, packageHash: string, manifest: PackageManifest, files: Map<string, Buffer>): void {
  for (const data of files.values()) ctx.artifacts.put(data);
  manifests.set(`${workspaceId}:${packageHash}`, manifest);
}

/** Reads one file of a stored package; package files live in the artifact store by content hash. */
export async function packageFile(ctx: AppContext, workspaceId: string, packageHash: string, path: string): Promise<Buffer> {
  const manifest = await packageManifest(ctx, workspaceId, packageHash);
  const entry = manifest.files.find((f) => f.path === path.replace(/^\.\//, ''));
  if (!entry) throw new AzhiError(ErrorClass.contractViolation, `${path} is not in package ${packageHash}`);
  const data = ctx.artifacts.get(`sha256:${entry.sha256}`);
  if (!data) throw new AzhiError(ErrorClass.internal, `package file ${path} (${entry.sha256}) is missing from the artifact store`);
  return data;
}

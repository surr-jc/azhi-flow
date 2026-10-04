import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { contentHash, sha256 } from '../lib/hash.js';

/**
 * A package is a workflow definition plus its scripts, schemas, templates and lockfiles
 * (spec section 5). Its identity is the hash of its manifest; credentials never enter it.
 */
export interface PackageManifest {
  format: 'azhi-package/1';
  workflow: string;
  files: Array<{ path: string; sha256: string; size: number }>;
}

export interface PackageSource {
  manifest: PackageManifest;
  hash: string;
  read(path: string): Buffer | undefined;
  readText(path: string): string | undefined;
}

const IGNORED = new Set(['node_modules', '.venv', '__pycache__', '.git', '.azhi', 'fixtures']);
const WORKFLOW_FILES = ['workflow.yaml', 'workflow.yml', 'azhi.yaml'];

export function packageFromDirectory(dir: string): PackageSource {
  const files = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.') || IGNORED.has(name)) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.set(relative(dir, full).split(sep).join('/'), readFileSync(full));
    }
  };
  walk(dir);
  const workflow = WORKFLOW_FILES.find((f) => files.has(f));
  if (!workflow) throw new Error(`no workflow.yaml in ${dir}`);
  return packageFromFiles(workflow, files);
}

export function packageFromFiles(workflow: string, files: Map<string, Buffer>): PackageSource {
  const manifest: PackageManifest = {
    format: 'azhi-package/1',
    workflow,
    files: [...files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, data]) => ({ path, sha256: sha256(data), size: data.length })),
  };
  return {
    manifest,
    hash: contentHash(manifest),
    read: (p) => files.get(normalise(p)),
    readText: (p) => files.get(normalise(p))?.toString('utf8'),
  };
}

function normalise(p: string): string {
  return p.replace(/^\.\//, '');
}

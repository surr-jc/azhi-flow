import type pg from 'pg';
import { tx } from '../db/pool.js';
import { sha256 } from '../lib/hash.js';
import { newId } from '../lib/ids.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { datasetAllows } from '../plan/run-plan.js';
import type { AppContext } from '../server/context.js';
import { CHUNKER, chunkDocument, normalise, PARSER } from './chunk.js';
import { DIMENSIONS, EMBEDDER, embed, tokens, toPgVector } from './embed.js';

/**
 * Knowledge datasets (spec section 11): documents are added, then published as an immutable
 * index revision. Tags such as `approved` point at a revision and are resolved when a run is
 * created. Retrieval is hybrid: PostgreSQL full text and pgvector, fused by reciprocal rank.
 */
export const CANDIDATES = 20;
export const DEFAULT_TOP_K = 6;
const RRF_K = 60;

export interface DatasetRow {
  id: string;
  name: string;
  trusted: boolean;
  acl: { roles?: string[]; users?: string[] };
}

export interface Citation {
  citation_id: string;
  dataset: string;
  revision: number;
  document: string;
  heading: string;
  text: string;
  start: number;
  end: number;
  score: number;
}

export async function getDataset(ctx: AppContext, workspaceId: string, name: string): Promise<DatasetRow | undefined> {
  return (await ctx.pool.query(`SELECT id, name, trusted, acl FROM datasets WHERE workspace_id=$1 AND name=$2`, [workspaceId, name])).rows[0];
}

async function requireDataset(ctx: AppContext, workspaceId: string, name: string) {
  const d = await getDataset(ctx, workspaceId, name);
  if (!d) throw new AzhiError(ErrorClass.invalidInput, `dataset ${name} not found`);
  return d;
}

export async function createDataset(ctx: AppContext, workspaceId: string, o: { name: string; trusted?: boolean; acl?: DatasetRow['acl'] }) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(o.name)) throw new AzhiError(ErrorClass.invalidInput, `invalid dataset name '${o.name}'`);
  const id = newId('ds');
  await ctx.pool.query(`INSERT INTO datasets(id, workspace_id, name, trusted, acl) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, name) DO UPDATE SET trusted=$4, acl=$5`, [
    id,
    workspaceId,
    o.name,
    o.trusted ?? true,
    JSON.stringify(o.acl ?? { roles: ['viewer'] }),
  ]);
  return (await getDataset(ctx, workspaceId, o.name))!;
}

export async function listDatasets(ctx: AppContext, workspaceId: string) {
  return (
    await ctx.pool.query(
      `SELECT d.name, d.trusted, d.acl,
         (SELECT max(revision) FROM dataset_revisions r WHERE r.dataset_id = d.id) AS latest_revision,
         (SELECT coalesce(jsonb_object_agg(tag, revision), '{}') FROM dataset_tags t WHERE t.dataset_id = d.id) AS tags,
         (SELECT count(*)::int FROM dataset_documents x WHERE x.dataset_id = d.id AND NOT x.revoked) AS documents
       FROM datasets d WHERE d.workspace_id=$1 ORDER BY d.name`,
      [workspaceId],
    )
  ).rows;
}

const mediaTypeOf = (path: string): 'text/markdown' | 'text/plain' | undefined =>
  /\.(md|markdown)$/i.test(path) ? 'text/markdown' : /\.(txt|text)$/i.test(path) ? 'text/plain' : undefined;

/** Adds or replaces documents. Markdown and plain text only in the alpha. */
export async function addDocuments(ctx: AppContext, workspaceId: string, name: string, docs: Array<{ path: string; content: string }>) {
  const d = await requireDataset(ctx, workspaceId, name);
  const out: Array<{ path: string; changed: boolean }> = [];
  for (const doc of docs) {
    const mediaType = mediaTypeOf(doc.path);
    if (!mediaType) throw new AzhiError(ErrorClass.unsupportedCapability, `${doc.path}: only Markdown (.md) and plain text (.txt) are supported in the alpha`);
    const text = normalise(doc.content);
    const hash = `sha256:${sha256(text)}`;
    const a = ctx.artifacts.put(text);
    await ctx.pool.query(`INSERT INTO artifacts(workspace_id, hash, size, media_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [workspaceId, a.hash, a.size, mediaType]);
    const prev = (await ctx.pool.query(`SELECT content_hash, revoked FROM dataset_documents WHERE dataset_id=$1 AND path=$2`, [d.id, doc.path])).rows[0];
    await ctx.pool.query(
      `INSERT INTO dataset_documents(dataset_id, path, content_hash, artifact, media_type) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (dataset_id, path) DO UPDATE SET content_hash=$3, artifact=$4, media_type=$5, revoked=false, added_at=now()`,
      [d.id, doc.path, hash, a.hash, mediaType],
    );
    out.push({ path: doc.path, changed: !prev || prev.content_hash !== hash || prev.revoked });
  }
  return out;
}

/** Revoked documents stop being retrievable at once, from every revision. */
export async function revokeDocument(ctx: AppContext, workspaceId: string, name: string, path: string) {
  const d = await requireDataset(ctx, workspaceId, name);
  const r = await ctx.pool.query(`UPDATE dataset_documents SET revoked=true WHERE dataset_id=$1 AND path=$2`, [d.id, path]);
  if (!r.rowCount) throw new AzhiError(ErrorClass.invalidInput, `dataset ${name} has no document ${path}`);
}

/** Parse, deduplicate, chunk and embed every current document into a new immutable revision. */
export async function publishRevision(ctx: AppContext, workspaceId: string, name: string, tag?: string) {
  const d = await requireDataset(ctx, workspaceId, name);
  const docs = (await ctx.pool.query(`SELECT path, content_hash, artifact, media_type FROM dataset_documents WHERE dataset_id=$1 AND NOT revoked ORDER BY path`, [d.id])).rows;
  if (!docs.length) throw new AzhiError(ErrorClass.invalidInput, `dataset ${name} has no documents to publish`);
  return tx(ctx.db, async (c: pg.PoolClient) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [d.id]);
    const revision = ((await c.query(`SELECT coalesce(max(revision), 0) + 1 AS r FROM dataset_revisions WHERE dataset_id=$1`, [d.id])).rows[0].r as number);
    const seen = new Set<string>();
    let chunkCount = 0;
    let docCount = 0;
    for (const doc of docs) {
      if (seen.has(doc.content_hash)) continue; // identical content under two paths is indexed once
      seen.add(doc.content_hash);
      docCount++;
      const text = ctx.artifacts.get(doc.artifact)?.toString('utf8');
      if (text === undefined) throw new AzhiError(ErrorClass.internal, `document ${doc.path} is missing from the artifact store`);
      for (const ch of chunkDocument(text, doc.media_type)) {
        const id = `c_${sha256(`${d.id}:${revision}:${doc.path}:${ch.start}`).slice(0, 20)}`;
        const indexed = `${ch.heading}\n${ch.text}`;
        await c.query(
          `INSERT INTO chunks(id, dataset_id, revision, path, content_hash, heading, text, start_offset, end_offset, tsv, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, setweight(to_tsvector('english', $6), 'A') || to_tsvector('english', $7), $10::vector)`,
          [id, d.id, revision, doc.path, doc.content_hash, ch.heading, ch.text, ch.start, ch.end, toPgVector(embed(indexed))],
        );
        chunkCount++;
      }
    }
    await c.query(`INSERT INTO dataset_revisions(dataset_id, revision, parser, chunker, embedder, dimensions, documents, chunks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      d.id,
      revision,
      PARSER,
      CHUNKER,
      EMBEDDER,
      DIMENSIONS,
      docCount,
      chunkCount,
    ]);
    await c.query(`INSERT INTO dataset_tags(dataset_id, tag, revision) VALUES ($1,'latest',$2) ON CONFLICT (dataset_id, tag) DO UPDATE SET revision=$2, updated_at=now()`, [d.id, revision]);
    if (tag) await c.query(`INSERT INTO dataset_tags(dataset_id, tag, revision) VALUES ($1,$2,$3) ON CONFLICT (dataset_id, tag) DO UPDATE SET revision=$3, updated_at=now()`, [d.id, tag, revision]);
    return { revision, documents: docCount, chunks: chunkCount, embedder: EMBEDDER };
  });
}

export async function tagRevision(ctx: AppContext, workspaceId: string, name: string, tag: string, revision: number) {
  const d = await requireDataset(ctx, workspaceId, name);
  const exists = (await ctx.pool.query(`SELECT 1 FROM dataset_revisions WHERE dataset_id=$1 AND revision=$2`, [d.id, revision])).rowCount;
  if (!exists) throw new AzhiError(ErrorClass.invalidInput, `dataset ${name} has no revision ${revision}`);
  await ctx.pool.query(`INSERT INTO dataset_tags(dataset_id, tag, revision) VALUES ($1,$2,$3) ON CONFLICT (dataset_id, tag) DO UPDATE SET revision=$3, updated_at=now()`, [d.id, tag, revision]);
}

/** `name`, `name@tag` or `name@3` to a pinned revision; undefined when it does not resolve. */
export async function resolveDatasetRef(ctx: AppContext, workspaceId: string, ref: string): Promise<{ dataset: DatasetRow; revision: number } | undefined> {
  const [name, tag = 'latest'] = ref.split('@') as [string, string?];
  const d = await getDataset(ctx, workspaceId, name);
  if (!d) return undefined;
  const r = /^\d+$/.test(tag!)
    ? (await ctx.pool.query(`SELECT revision FROM dataset_revisions WHERE dataset_id=$1 AND revision=$2`, [d.id, Number(tag)])).rows[0]
    : (await ctx.pool.query(`SELECT revision FROM dataset_tags WHERE dataset_id=$1 AND tag=$2`, [d.id, tag])).rows[0];
  return r ? { dataset: d, revision: r.revision } : undefined;
}

/**
 * Hybrid retrieval over pinned revisions: up to 20 full-text and 20 vector candidates per
 * dataset, fused with reciprocal rank fusion, top k returned. ACL is checked before ranking.
 */
export async function retrieve(
  ctx: AppContext,
  workspaceId: string,
  o: { pinned: Array<{ ref: string; revision: number }>; query: string; topK?: number; principal?: { userId: string; role: string } },
): Promise<Citation[]> {
  const q = tokens(o.query);
  if (!q.length) return [];
  const tsquery = [...new Set(q)].map((t) => `${t}:*`).join(' | ');
  const qvec = toPgVector(embed(o.query));
  const scores = new Map<string, { score: number; row: any; dataset: string }>();
  for (const p of o.pinned) {
    const name = p.ref.split('@')[0]!;
    const d = await getDataset(ctx, workspaceId, name);
    if (!d) throw new AzhiError(ErrorClass.invalidInput, `dataset ${name} not found`);
    if (o.principal && !datasetAllows(d.acl, o.principal)) throw new AzhiError(ErrorClass.authorization, `${o.principal.userId} has no access to dataset ${name}`);
    const live = `c.dataset_id=$1 AND c.revision=$2 AND EXISTS (SELECT 1 FROM dataset_documents x WHERE x.dataset_id=c.dataset_id AND x.path=c.path AND NOT x.revoked)`;
    const lexical = (
      await ctx.pool.query(
        `SELECT c.id, c.path, c.heading, c.text, c.start_offset, c.end_offset FROM chunks c
         WHERE ${live} AND c.tsv @@ to_tsquery('english', $3)
         ORDER BY ts_rank_cd(c.tsv, to_tsquery('english', $3)) DESC, c.id LIMIT ${CANDIDATES}`,
        [d.id, p.revision, tsquery],
      )
    ).rows;
    const semantic = (
      await ctx.pool.query(
        `SELECT c.id, c.path, c.heading, c.text, c.start_offset, c.end_offset FROM chunks c
         WHERE ${live} ORDER BY c.embedding <=> $3::vector, c.id LIMIT ${CANDIDATES}`,
        [d.id, p.revision, qvec],
      )
    ).rows;
    for (const list of [lexical, semantic]) {
      list.forEach((row, rank) => {
        const key = `${p.ref}:${row.id}`;
        const prev = scores.get(key);
        scores.set(key, { score: (prev?.score ?? 0) + 1 / (RRF_K + rank + 1), row, dataset: `${name}@${p.revision}` });
      });
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
    .slice(0, o.topK ?? DEFAULT_TOP_K)
    .map(({ score, row, dataset }) => ({
      citation_id: row.id,
      dataset: dataset.split('@')[0]!,
      revision: Number(dataset.split('@')[1]),
      document: row.path,
      heading: row.heading ?? '',
      text: row.text,
      start: row.start_offset,
      end: row.end_offset,
      score: Number(score.toFixed(6)),
    }));
}

/** Resolves every dataset ref a plan uses, for the run snapshot (tags resolve at run creation). */
export async function pinDatasets(ctx: AppContext, workspaceId: string, refs: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const ref of new Set(refs)) {
    const r = await resolveDatasetRef(ctx, workspaceId, ref);
    if (!r) throw new AzhiError(ErrorClass.invalidInput, `dataset ${ref} does not resolve to a published revision`);
    out[ref] = r.revision;
  }
  return out;
}

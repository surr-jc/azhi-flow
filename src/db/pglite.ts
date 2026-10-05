import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { PGlite, type Results } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type pg from 'pg';

/**
 * Local mode's database: PostgreSQL embedded in this process (PGlite), behind the subset of the
 * `pg` Pool interface the server uses. `pglite://<dir>` keeps data in a folder; `pglite://memory`
 * keeps it in memory. PGlite has one connection, so a transaction holds it exclusively: other
 * queries wait, and queries made inside the transaction's async flow (including nested
 * transactions, run as savepoints) join it instead of deadlocking.
 */
export const isPgliteUrl = (url: string) => url.startsWith('pglite:');

export function pgliteDataDir(url: string): string | undefined {
  const path = url.replace(/^pglite:(\/\/)?/, '');
  if (path === '' || path === 'memory') return undefined;
  return path.replace(/^~(?=[/\\]|$)/, homedir());
}

interface Session {
  depth: number;
}

type QueryConfig = { text: string; values?: unknown[]; rowMode?: 'array' };

// Match node-postgres: int8 as a string, bytea as a Buffer.
const PARSERS = {
  20: (v: string) => v,
  17: (v: string) => Buffer.from(v.startsWith('\\x') ? v.slice(2) : v, 'hex'),
};

export class PglitePool {
  private readonly ready: Promise<PGlite>;
  private readonly session = new AsyncLocalStorage<Session>();
  private queue: Promise<void> = Promise.resolve();

  constructor(url: string) {
    const dir = pgliteDataDir(url);
    if (dir) mkdirSync(dir, { recursive: true });
    this.ready = PGlite.create({ ...(dir ? { dataDir: dir } : {}), extensions: { vector }, parsers: PARSERS });
  }

  /** Waits for the connection, then runs `fn` with it held; re-entrant within one async flow. */
  private async exclusive<T>(fn: (db: PGlite) => Promise<T>): Promise<T> {
    const db = await this.ready;
    if (this.session.getStore()) return fn(db);
    let release!: () => void;
    const prev = this.queue;
    this.queue = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await this.session.run({ depth: 0 }, () => fn(db));
    } finally {
      release();
    }
  }

  async query(text: string | QueryConfig, values?: unknown[]): Promise<pg.QueryResult> {
    const q = typeof text === 'string' ? { text, values } : text;
    return this.exclusive((db) => runQuery(db, q));
  }

  /** Runs `fn` in a transaction, or in a savepoint when called inside another transaction. */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.exclusive(async (db) => {
      const s = this.session.getStore()!;
      const sp = s.depth > 0 ? `azhi_sp_${s.depth}` : undefined;
      await db.exec(sp ? `SAVEPOINT ${sp}` : 'BEGIN');
      s.depth++;
      try {
        const result = await fn(this.client() as unknown as pg.PoolClient);
        await db.exec(sp ? `RELEASE SAVEPOINT ${sp}` : 'COMMIT');
        return result;
      } catch (err) {
        await db.exec(sp ? `ROLLBACK TO SAVEPOINT ${sp}` : 'ROLLBACK').catch(() => {});
        throw err;
      } finally {
        s.depth--;
      }
    });
  }

  /** A client for single queries and LISTEN; transactions go through `transaction`. */
  async connect(): Promise<pg.PoolClient> {
    return this.client() as unknown as pg.PoolClient;
  }

  private client() {
    const emitter = new EventEmitter();
    const unlisten: Array<() => Promise<void>> = [];
    return Object.assign(emitter, {
      query: async (text: string | QueryConfig, values?: unknown[]) => {
        const q = typeof text === 'string' ? { text, values } : text;
        const listen = /^\s*LISTEN\s+("?)(\w+)\1\s*;?\s*$/i.exec(q.text);
        if (listen) {
          const db = await this.ready;
          const channel = listen[2]!;
          unlisten.push(await db.listen(channel, (payload) => emitter.emit('notification', { channel, payload })));
          return { rows: [], rowCount: 0, fields: [], command: 'LISTEN', oid: 0 } as unknown as pg.QueryResult;
        }
        return this.query(q);
      },
      release: () => {
        for (const u of unlisten.splice(0)) u().catch(() => {});
      },
    });
  }

  async end() {
    const db = await this.ready;
    await db.close();
  }
}

async function runQuery(db: PGlite, q: QueryConfig): Promise<pg.QueryResult> {
  let r: Results<any>;
  if (q.values?.length || q.rowMode) {
    r = await db.query(q.text, (q.values ?? []).map(toParam), q.rowMode ? { rowMode: q.rowMode } : undefined);
  } else {
    // No parameters: allow several statements, as node-postgres does (migrations rely on it).
    const all = await db.exec(q.text);
    r = all[all.length - 1] ?? { rows: [], fields: [] };
  }
  return { rows: r.rows, rowCount: r.affectedRows || r.rows.length, fields: r.fields as any, command: '', oid: 0 };
}

function toParam(v: unknown) {
  return v === undefined ? null : v;
}

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { isPgliteUrl, PglitePool } from './pglite.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

export function databaseUrl(): string {
  return process.env.AZHI_DATABASE_URL ?? 'postgres://azhi:azhi@localhost:5432/azhi';
}

/** `postgres://` connects to a PostgreSQL server; `pglite://<dir>` embeds one (local mode). */
export function createDb(url = databaseUrl()): Db {
  const pool = isPgliteUrl(url) ? (new PglitePool(url) as unknown as pg.Pool) : new pg.Pool({ connectionString: url, max: Number(process.env.AZHI_DB_POOL ?? 10) });
  return drizzle(pool, { schema }) as Db;
}

/** Runs `fn` inside a transaction on a dedicated client. */
export async function tx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return transaction(db.$client, fn);
}

/** Runs `fn` inside a transaction on a dedicated client (a savepoint when nested on PGlite). */
export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (pool instanceof PglitePool) return pool.transaction(fn);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

export function databaseUrl(): string {
  return process.env.AZHI_DATABASE_URL ?? 'postgres://azhi:azhi@localhost:5432/azhi';
}

export function createDb(url = databaseUrl()): Db {
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.AZHI_DB_POOL ?? 10) });
  return drizzle(pool, { schema }) as Db;
}

/** Runs `fn` inside a transaction on a dedicated client. */
export async function tx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.$client.connect();
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

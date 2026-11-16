import { Pool, types, type PoolClient, type QueryResultRow } from "pg";
import { fromPgError } from "./errors";

// Dates stay as 'YYYY-MM-DD' strings; never convert a business date through a JS Date.
types.setTypeParser(1082, (v) => v);

declare global {
  // eslint-disable-next-line no-var
  var __dmPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!globalThis.__dmPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalThis.__dmPool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: true } : undefined,
    });
  }
  return globalThis.__dmPool;
}

export async function closePool(): Promise<void> {
  if (globalThis.__dmPool) {
    await globalThis.__dmPool.end();
    globalThis.__dmPool = undefined;
  }
}

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Db {
  query<R extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export const db: Db = {
  query: (text, params) => getPool().query(text, params as any[]) as any,
};

export async function q<R extends QueryResultRow = any>(d: Db, text: string, params?: unknown[]): Promise<R[]> {
  return (await d.query<R>(text, params)).rows;
}

export async function one<R extends QueryResultRow = any>(d: Db, text: string, params?: unknown[]): Promise<R | null> {
  return (await d.query<R>(text, params)).rows[0] ?? null;
}

/** Runs fn in a single transaction; any throw rolls everything back. */
export async function tx<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client as unknown as Db);
    await client.query("commit");
    return result;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* connection already broken */
    }
    // Constraint violations surface as typed conflicts (overlap, duplicate, double reservation).
    throw fromPgError(e) ?? e;
  } finally {
    client.release();
  }
}

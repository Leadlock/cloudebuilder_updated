/**
 * Database client singleton — import this in server-side code only.
 * Never import in React components or client-side modules.
 *
 * The client is initialised lazily on first use so that the Next.js build
 * can collect route metadata without a live DATABASE_URL.
 */
import 'dotenv/config';
import postgres from '@prisma/orm-postgres/runtime';
import { Client as PgClient } from 'pg';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

// ─── Lazy singleton ───────────────────────────────────────────────────────────

type DbClient = ReturnType<typeof postgres<Contract>>;

declare global {
  var __cloudbuilder_db__: DbClient | undefined;
}

function createDb(): DbClient {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable is not set. ' +
      'Copy .env.example to .env and set the connection string.',
    );
  }
  return postgres<Contract>({ contractJson, url });
}

/**
 * Lazily-initialised DB proxy.
 * Accessing any property on `db` triggers the real client to be created.
 * Build-time `export const dynamic = 'force-dynamic'` in route files is
 * still required to prevent Next.js from attempting to run API routes
 * at build time.
 */
function makeLazyDb(): DbClient {
  let _client: DbClient | undefined;

  const getClient = () => {
    if (!_client) {
      if (global.__cloudbuilder_db__) {
        _client = global.__cloudbuilder_db__;
      } else {
        _client = createDb();
        global.__cloudbuilder_db__ = _client;
      }
    }
    return _client;
  };

  return new Proxy({} as DbClient, {
    get(_target, prop) {
      return (getClient() as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
}

export const db: DbClient = makeLazyDb();

/**
 * Execute a parameterised SQL statement directly via the pg driver.
 * Use ONLY for operations where the Prisma ORM abstraction is insufficient
 * (e.g. bulk DELETEs that must be guaranteed atomic).
 * Never use for SELECT queries that return data — use db.orm.* for those.
 * Never log the sql or params arguments.
 */
export async function rawExec(sql: string, params: unknown[]): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL not set');
  const client = new PgClient({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql, params as string[]);
  } finally {
    await client.end();
  }
}

/**
 * Run a sequence of parameterised statements atomically on a single connection
 * (BEGIN ... COMMIT, with ROLLBACK on any failure). Use for multi-statement
 * writes that must not be left partially applied if the process dies mid-way
 * (e.g. delete-then-reinsert of an architecture's resources/connections).
 * Never log statement text or params.
 */
export async function rawTransaction<T>(
  fn: (query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>,
): Promise<T> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL not set');
  const client = new PgClient({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await fn((sql, params) => client.query(sql, (params ?? []) as string[]));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // rollback failure is secondary to the original error — swallow it
    }
    throw err;
  } finally {
    await client.end();
  }
}

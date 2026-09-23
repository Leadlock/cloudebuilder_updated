/**
 * CloudCraft — durable job queue (pg-boss on the existing Postgres DB)
 *
 * Replaces the fire-and-forget in-process Promise that discovery previously
 * ran as (see the removed "RELIABILITY LIMITATION" note that used to live in
 * app/api/cloud-accounts/[id]/discover/route.ts). That approach could lose a
 * job mid-flight if the Node process serving the HTTP request was frozen or
 * evicted after the response was sent — there was no persistence and no retry.
 *
 * pg-boss stores queued/in-flight/failed jobs as rows in this same Postgres
 * database (its own `pgboss` schema, created automatically on first start —
 * no separate infrastructure to provision). A job survives the producer
 * process dying, and is only removed once a worker explicitly completes or
 * exhausts its retries.
 *
 * Producer side (e.g. the Next.js API route handling POST /discover) and
 * consumer side (workers/discoveryWorker.ts, a separate long-running Node
 * process) each get their OWN PgBoss instance via getQueue() — they
 * coordinate through the database, not shared memory, which is what makes
 * this work whether the app is deployed serverless or as a long-running
 * server: only the worker process needs to be long-running.
 */
import { PgBoss } from 'pg-boss';

declare global {
  // eslint-disable-next-line no-var
  var __cloudcraft_boss__: Promise<PgBoss> | undefined;
}

function createBoss(): PgBoss {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable is not set — required for the job queue (pg-boss uses the same Postgres database).',
    );
  }
  return new PgBoss(url);
}

/**
 * Returns a started PgBoss instance for the current process, creating and
 * starting it on first call. Safe to call from multiple places within the
 * same process — the underlying instance and its startup Promise are memoized.
 */
export function getQueue(): Promise<PgBoss> {
  let pending = global.__cloudcraft_boss__;
  if (!pending) {
    const boss = createBoss();
    pending = boss.start().then(() => boss);
    global.__cloudcraft_boss__ = pending;
  }
  return pending;
}

/**
 * Stops the current process's PgBoss instance, if one was started. Call this
 * on graceful shutdown (SIGTERM/SIGINT) in long-running processes such as
 * the worker script — never in a request-scoped Next.js API route, since
 * stopping there would tear down the queue connection for the whole server.
 */
export async function stopQueue(): Promise<void> {
  if (global.__cloudcraft_boss__) {
    const boss = await global.__cloudcraft_boss__;
    await boss.stop({ graceful: true, timeout: 30_000 });
    global.__cloudcraft_boss__ = undefined;
  }
}

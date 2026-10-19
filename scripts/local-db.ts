/**
 * Starts a local PostgreSQL (docker-compose.yml) and creates CloudBuilder's tables in it, so development does not wait on a remote
 * database: a query to a database in another continent costs a quarter of a second; a local one costs about a millisecond.
 *
 *   npm run db:local
 *
 * It does NOT touch your .env or your existing database. When it finishes it prints the one line to put in .env to use the local
 * database (and how to go back). The local database starts empty: sign in again and re-create what you need.
 */
import { spawnSync } from 'node:child_process';

// A database of its own inside the container. The container's default database (cloudcraft_dev) may hold older data from earlier
// work, at a schema this code does not recognise; it is left exactly as it is.
const DB_NAME = 'cloudbuilder_app';
const LOCAL_URL = `postgresql://cloudcraft:cloudbuilder@localhost:5432/${DB_NAME}`;

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  return r.status ?? 1;
}
function ok(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
}

async function main(): Promise<void> {
  if (!ok('docker', ['info'])) {
    console.error('Docker is not running. Start Docker Desktop, wait until it says it is running, then run this again.');
    console.error('(Docker Desktop needs roughly 1-2 GB of memory; on a small machine close other programs first.)');
    process.exit(1);
  }
  console.log('Starting local PostgreSQL…');
  if (run('docker', ['compose', 'up', '-d', 'postgres']) !== 0) process.exit(1);

  process.stdout.write('Waiting for it to accept connections');
  for (let i = 0; i < 40; i++) {
    if (ok('docker', ['exec', 'cloudcraft_postgres', 'pg_isready', '-U', 'cloudbuilder', '-d', 'cloudcraft_dev'])) break;
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1500));
    if (i === 39) { console.error('\nPostgreSQL did not become ready in time.'); process.exit(1); }
  }
  console.log(' ready.');

  // (No arguments with spaces: on Windows they would be split by the shell.)
  const exists = ok('docker', ['exec', 'cloudcraft_postgres', 'psql', '-U', 'cloudbuilder', '-d', DB_NAME, '-c', '\q']);
  if (!exists) {
    console.log(`Creating the database "${DB_NAME}"…`);
    if (run('docker', ['exec', 'cloudcraft_postgres', 'createdb', '-U', 'cloudbuilder', DB_NAME]) !== 0) process.exit(1);
  }

  console.log('Creating the tables (prisma db migrate) in the local database…');
  if (run('npx', ['prisma', 'db', 'migrate'], { ...process.env, DATABASE_URL: LOCAL_URL }) !== 0) process.exit(1);

  console.log(`
Local database is ready. Your .env was not changed.

To use it, set this line in .env and restart "npm run dev":
  DATABASE_URL="${LOCAL_URL}"

To go back to the remote database, put your previous DATABASE_URL line back (keep a copy of it first).
The local database starts empty, so sign in again and re-create your projects there.
Stop it any time with:  docker compose stop postgres
`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });

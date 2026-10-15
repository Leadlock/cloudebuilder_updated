/**
 * Starts every database engine from the files Container Templates generates and checks, for real:
 *  1. docker compose: it becomes healthy, the password is required, data written survives `down` + `up` (the volume works);
 *  2. the exact `docker run` line a virtual machine would run: same checks, and the data survives the container being replaced (the volume works).
 * Needs Docker. Not part of `npm test`: it pulls the official images. Run: npx tsx --tsconfig tsconfig.json scripts/verify-databases.ts [engine ...]
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { defaultConfig, generateContainerFiles, withDeployTarget } from '../lib/engines/containers/dockerTemplates';
import { applyDatabase, DB_ENGINES, DB_ENGINE_IDS, type DbEngineId } from '../lib/engines/containers/databases';

const only = process.argv.slice(2) as DbEngineId[];
const engines = DB_ENGINE_IDS.filter((e) => only.length === 0 || only.includes(e));
const root = mkdtempSync(join(tmpdir(), 'verify-db-'));

const run = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A host port that is not in use here (the engines' own ports often are: a developer may already run a database). */
let nextPort = 20000 + Math.floor(Math.random() * 20000);
const freePort = () => nextPort++;

/** What to write, what to read back, and what must be refused without the password. Each command runs inside the container, where the passwords are in the environment. */
const CHECKS: Record<DbEngineId, { write: string; read: string; expect: string; refused?: string }> = {
  postgres: {
    write: `PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "create table if not exists t(v text); insert into t values ('kept')"`,
    read: `PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select v from t"`, expect: 'kept',
    // Over the container's own network address: from 127.0.0.1 inside the container the official image trusts everyone, but a connection from outside arrives on this address and needs the password.
    refused: `PGPASSWORD=wrong psql -h "$(hostname -i)" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select 1"`,
  },
  mysql: {
    write: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -u "$MYSQL_USER" "$MYSQL_DATABASE" -e "create table if not exists t(v varchar(10)); insert into t values ('kept')"`,
    read: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -u "$MYSQL_USER" "$MYSQL_DATABASE" -N -e "select v from t"`, expect: 'kept',
    refused: `MYSQL_PWD=wrong mysql -h 127.0.0.1 -u "$MYSQL_USER" "$MYSQL_DATABASE" -e "select 1"`,
  },
  mongodb: {
    write: `mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.getSiblingDB('app').t.insertOne({v:'kept'}).acknowledged"`,
    read: `mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.getSiblingDB('app').t.findOne().v"`, expect: 'kept',
    refused: `mongosh --quiet --eval "db.getSiblingDB('app').t.findOne()"`,
  },
  redis: {
    write: `REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli set k kept`,
    read: `REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli get k`, expect: 'kept',
    refused: `redis-cli get k | grep -q NOAUTH && exit 1; exit 0`,
  },
  rabbitmq: {
    write: `rabbitmqctl add_vhost kept && rabbitmqctl authenticate_user "$RABBITMQ_DEFAULT_USER" "$RABBITMQ_DEFAULT_PASS"`,
    read: `rabbitmqctl list_vhosts`, expect: 'kept',
    refused: `rabbitmqctl authenticate_user "$RABBITMQ_DEFAULT_USER" wrong-password`,
  },
};

let failed = 0;
const fail = (what: string, detail: string) => { failed++; console.log(`FAIL  ${what}\n${detail.split('\n').slice(-18).join('\n')}`); };
const ok = (what: string) => console.log(`ok    ${what}`);

async function waitHealthy(name: string, healthCmd: string, seconds = 240): Promise<boolean> {
  // Like the compose start_period: the first command is not run while the container is still setting itself up (RabbitMQ's tool, run as root in the
  // first seconds, would create a cookie file the server cannot read).
  await sleep(15000);
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const r = run('docker', ['exec', name, 'sh', '-c', healthCmd.replace(/\$\$/g, '$')]);
    if (r.status === 0) return true;
    await sleep(3000);
  }
  return false;
}

const exec = (name: string, line: string) => run('docker', ['exec', name, 'sh', '-c', line]);

/**
 * No secret may be in the container's stored command or environment-free configuration: Compose substitutes $NAME in the file before the container starts, so a
 * password used in a command would be stored in clear text and printed by `docker inspect`. Returns the stored command when it leaks.
 */
const storedCommandLeak = (name: string, secret: string): string | null => {
  const r = run('docker', ['inspect', name, '--format', '{{json .Config.Cmd}}']);
  if (r.status !== 0) throw new Error(`docker inspect failed, so the password check cannot be trusted: ${out(r)}`);
  return r.stdout.includes(secret) ? r.stdout : null;
};

/** No secret may be in the arguments of any process of the container (`docker top` and `ps` show them to anyone who can run them). Returns the listing when it leaks. */
const argsLeak = (name: string, secret: string): string | null => {
  const top = run('docker', ['top', name, '-eo', 'pid,args']);
  // A failing `docker top` must not pass the check by saying nothing.
  if (top.status !== 0) throw new Error(`docker top failed, so the password check cannot be trusted: ${out(top)}`);
  return top.stdout.includes(secret) ? top.stdout : null;
};

async function viaCompose(id: DbEngineId): Promise<void> {
  const e = DB_ENGINES[id];
  const c = applyDatabase({ ...defaultConfig('node'), appName: `vdb-${id}` }, id);
  const res = generateContainerFiles(c);
  if (!res.ok) return fail(`${id} compose: generate`, res.errors.join('; '));
  const dir = join(root, `compose-${id}`);
  mkdirSync(dir, { recursive: true });
  for (const f of res.files) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    // Only the host side of the port is changed, so this machine's own databases do not get in the way.
    writeFileSync(p, f.path === 'docker-compose.yml' ? f.content.replace(`127.0.0.1:${c.port}:${c.port}`, `127.0.0.1:${freePort()}:${c.port}`) : f.content);
  }
  const password = randomBytes(12).toString('hex');
  writeFileSync(join(dir, '.env'), e.env.filter((v) => v.secret).map((v) => `${v.key}=${password}`).join('\n') + '\n');
  const up = run('docker', ['compose', '-p', `vdb-${id}`, 'up', '-d'], dir);
  if (up.status !== 0) return fail(`${id} compose: up`, out(up));
  try {
    const name = run('docker', ['compose', '-p', `vdb-${id}`, 'ps', '-q'], dir).stdout.trim();
    if (!(await waitHealthy(name, e.health))) return fail(`${id} compose: healthy`, out(run('docker', ['logs', '--tail', '40', name])));
    ok(`${id} compose: healthy`);
    if (argsLeak(name, password)) return fail(`${id} compose: the password is in a process's arguments`, out(run('docker', ['top', name, '-eo', 'pid,args'])).replace(password, '<password>'));
    ok(`${id} compose: the password is in no process's arguments`);
    if (storedCommandLeak(name, password)) return fail(`${id} compose: the password is in the container's stored command (docker inspect prints it)`, 'see storedCommandLeak');
    ok(`${id} compose: the password is not in the container's stored command`);
    const w = exec(name, CHECKS[id].write);
    if (w.status !== 0) return fail(`${id} compose: write`, out(w));
    if (CHECKS[id].refused) {
      const r = exec(name, CHECKS[id].refused!);
      if (r.status === 0) return fail(`${id} compose: the password is required`, `a login without the password was accepted:\n${out(r)}`);
      ok(`${id} compose: refuses a wrong or missing password`);
    }
    // The data must survive the container being removed and created again.
    run('docker', ['compose', '-p', `vdb-${id}`, 'down'], dir);
    const up2 = run('docker', ['compose', '-p', `vdb-${id}`, 'up', '-d'], dir);
    if (up2.status !== 0) return fail(`${id} compose: up again`, out(up2));
    const name2 = run('docker', ['compose', '-p', `vdb-${id}`, 'ps', '-q'], dir).stdout.trim();
    if (!(await waitHealthy(name2, e.health))) return fail(`${id} compose: healthy again`, out(run('docker', ['logs', '--tail', '40', name2])));
    const r2 = exec(name2, CHECKS[id].read);
    if (!out(r2).includes(CHECKS[id].expect)) return fail(`${id} compose: data survives down and up`, out(r2));
    ok(`${id} compose: data survives the container being replaced`);
  } finally {
    run('docker', ['compose', '-p', `vdb-${id}`, 'down', '-v'], dir);
  }
}

/** The exact line a virtual machine runs (from the generated user_data.sh), with a Docker volume of this machine. */
async function viaVmLine(id: DbEngineId): Promise<void> {
  const e = DB_ENGINES[id];
  const c = withDeployTarget(applyDatabase({ ...defaultConfig('node'), appName: `vmdb-${id}` }, id), 'ec2');
  const res = generateContainerFiles(c);
  if (!res.ok) return fail(`${id} VM line: generate`, res.errors.join('; '));
  const script = res.files.find((f) => f.path === 'ec2/user_data.sh')!.content;
  const line = script.split('\n').find((l) => l.startsWith('exec docker run'));
  if (!line) return fail(`${id} VM line: find the docker run line`, script);
  const dir = mkdtempSync(join(root, `vm-${id}-`));
  const password = randomBytes(12).toString('hex');
  const envFile = join(dir, 'env');
  writeFileSync(envFile, e.env.map((v) => `${v.key}=${v.secret ? password : v.value}`).join('\n') + '\n');
  const name = `vmdb-${id}`;
  const command = line.replace(/^exec docker run/, 'docker run -d').replace(`-p ${c.port}:${c.port}`, `-p 127.0.0.1:${freePort()}:${c.port}`).replace('"$ENV_FILE"', `"${envFile}"`).replace('"$IMAGE"', c.image);
  const start = () => run('bash', ['-c', command]);
  // Like the VM's systemd unit (ExecStop=docker stop): the database gets time to write its data out before the container is removed.
  const stop = () => { run('docker', ['stop', '-t', '60', name]); return run('docker', ['rm', '-f', name]); };
  const volume = `${c.appName}-data`;
  try {
    stop();
    const s1 = start();
    if (s1.status !== 0) return fail(`${id} VM line: start`, `${command}\n${out(s1)}`);
    if (!(await waitHealthy(name, e.health))) return fail(`${id} VM line: healthy`, out(run('docker', ['logs', '--tail', '40', name])));
    ok(`${id} VM line: healthy`);
    if (argsLeak(name, password)) return fail(`${id} VM line: the password is in a process's arguments`, out(run('docker', ['top', name, '-eo', 'pid,args'])).replace(password, '<password>'));
    ok(`${id} VM line: the password is in no process's arguments`);
    if (storedCommandLeak(name, password)) return fail(`${id} VM line: the password is in the container's stored command (docker inspect prints it)`, 'see storedCommandLeak');
    ok(`${id} VM line: the password is not in the container's stored command`);
    const w = exec(name, CHECKS[id].write);
    if (w.status !== 0) return fail(`${id} VM line: write`, out(w));
    stop();
    const s2 = start();
    if (s2.status !== 0) return fail(`${id} VM line: start again`, out(s2));
    if (!(await waitHealthy(name, e.health))) return fail(`${id} VM line: healthy again`, out(run('docker', ['logs', '--tail', '40', name])));
    const r = exec(name, CHECKS[id].read);
    if (!out(r).includes(CHECKS[id].expect)) return fail(`${id} VM line: data survives a replaced container`, out(r));
    ok(`${id} VM line: data survives the container being replaced`);
  } finally {
    stop();
    run('docker', ['volume', 'rm', volume]);
  }
}

(async () => {
  if (run('docker', ['info']).status !== 0) { console.log('Docker is not running.'); process.exit(2); }
  for (const id of engines) { await viaCompose(id); await viaVmLine(id); }
  rmSync(root, { recursive: true, force: true });
  console.log(failed === 0 ? 'All databases verified.' : `${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();

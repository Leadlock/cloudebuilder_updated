/**
 * Databases as containers of their own: PostgreSQL, MySQL, MongoDB, Redis and RabbitMQ, run from their official images.
 *
 * A database always uses a ready-made image, so it reuses everything the ready-made-image path already does (compose file, EC2 and Azure VM
 * Terraform, passwords read from SSM / Key Vault and never written to Terraform). What is different, and handled here and in the generators:
 *  - its data lives in a volume that survives restarts;
 *  - it is never published to the internet (compose binds it to localhost; a VM opens its port only to a range you choose, never to everyone);
 *  - it runs on a virtual machine or locally with Docker Compose. A managed container service (ECS, Container Apps, Kubernetes) needs persistent
 *    storage and a non-HTTP health check that these templates do not set up, so they refuse a database and point to the cloud's managed database.
 */
import type { ContainerConfig, DeployTarget, EnvVar } from './dockerTemplates';

export type DbEngineId = 'postgres' | 'mysql' | 'mongodb' | 'redis' | 'rabbitmq';

export interface DbEngine {
  id: DbEngineId;
  label: string;
  /** Docker image name (without the tag). */
  image: string;
  versions: string[];
  /** The part added to the version to make the tag ("-alpine"). */
  tagSuffix: string;
  port: number;
  /** Where the image keeps its data: this folder is the volume. */
  dataPath: string;
  /** Variables the database needs. A secret one is read from the secret store on a VM and from .env locally; its value is never in a generated file. */
  env: EnvVar[];
  /** The command inside the container (a shell line), for an image that needs arguments to use a password. */
  command?: string;
  /** A shell line that succeeds when the database is ready, run inside the container (compose health check). */
  health: string;
  memory: string;
  /** A line that backs it up into one file (run on the host with docker exec); the README explains it. */
  backup: (app: string) => string;
  /** Shown in the README: how an application connects. */
  connection: (host: string) => string;
}

const secret = (key: string): EnvVar => ({ key, value: '', secret: true });
const plain = (key: string, value: string): EnvVar => ({ key, value });

export const DB_ENGINES: Record<DbEngineId, DbEngine> = {
  postgres: {
    id: 'postgres', label: 'PostgreSQL', image: 'postgres', versions: ['17', '16', '15', '14'], tagSuffix: '-alpine', port: 5432, dataPath: '/var/lib/postgresql/data',
    env: [plain('POSTGRES_USER', 'app'), plain('POSTGRES_DB', 'app'), secret('POSTGRES_PASSWORD')],
    health: 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"', memory: '1g',
    backup: (a) => `docker exec ${a} sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > ${a}-backup.sql`,
    connection: (h) => `postgresql://app:<POSTGRES_PASSWORD>@${h}:5432/app`,
  },
  mysql: {
    id: 'mysql', label: 'MySQL', image: 'mysql', versions: ['8.4', '8.0'], tagSuffix: '', port: 3306, dataPath: '/var/lib/mysql',
    env: [plain('MYSQL_DATABASE', 'app'), plain('MYSQL_USER', 'app'), secret('MYSQL_PASSWORD'), secret('MYSQL_ROOT_PASSWORD')],
    health: 'MYSQL_PWD="$$MYSQL_ROOT_PASSWORD" mysqladmin ping -h 127.0.0.1 -u root --silent', memory: '1g',
    backup: (a) => `docker exec ${a} sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -u root --all-databases' > ${a}-backup.sql`,
    connection: (h) => `mysql://app:<MYSQL_PASSWORD>@${h}:3306/app`,
  },
  mongodb: {
    id: 'mongodb', label: 'MongoDB', image: 'mongo', versions: ['7.0', '8.0'], tagSuffix: '', port: 27017, dataPath: '/data/db',
    env: [plain('MONGO_INITDB_ROOT_USERNAME', 'app'), secret('MONGO_INITDB_ROOT_PASSWORD')],
    health: `mongosh --quiet --eval "db.adminCommand('ping').ok" | grep -q 1`, memory: '1g',
    backup: (a) => `docker exec ${a} sh -c 'mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive' > ${a}-backup.archive`,
    connection: (h) => `mongodb://app:<MONGO_INITDB_ROOT_PASSWORD>@${h}:27017/?authSource=admin`,
  },
  redis: {
    id: 'redis', label: 'Redis', image: 'redis', versions: ['7.4', '7.2'], tagSuffix: '-alpine', port: 6379, dataPath: '/data',
    env: [secret('REDIS_PASSWORD')],
    command: 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes',
    health: 'REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping | grep -q PONG', memory: '512m',
    backup: (a) => `docker exec ${a} sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --rdb /data/backup.rdb' && docker cp ${a}:/data/backup.rdb ./${a}-backup.rdb`,
    connection: (h) => `redis://:<REDIS_PASSWORD>@${h}:6379`,
  },
  rabbitmq: {
    id: 'rabbitmq', label: 'RabbitMQ', image: 'rabbitmq', versions: ['4.0', '3.13', '3.12'], tagSuffix: '-alpine', port: 5672, dataPath: '/var/lib/rabbitmq',
    // The node name is fixed, so the data is found again after the container is replaced (by default it follows the container's random host name).
    env: [plain('RABBITMQ_DEFAULT_USER', 'app'), plain('RABBITMQ_NODENAME', 'rabbit@localhost'), secret('RABBITMQ_DEFAULT_PASS')],
    // check_running waits for the broker itself; plain "ping" already succeeds while it is still starting.
    health: 'rabbitmq-diagnostics -q check_running', memory: '1g',
    backup: (a) => `docker exec ${a} rabbitmqctl export_definitions /tmp/definitions.json && docker cp ${a}:/tmp/definitions.json ./${a}-definitions.json`,
    connection: (h) => `amqp://app:<RABBITMQ_DEFAULT_PASS>@${h}:5672`,
  },
};

export const DB_ENGINE_IDS = Object.keys(DB_ENGINES) as DbEngineId[];

export const isDbEngineId = (v: unknown): v is DbEngineId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(DB_ENGINES, v);

/** The engine a configuration runs, or null when it is an ordinary application. */
export const databaseOf = (c: { database?: string }): DbEngine | null => (c.database && isDbEngineId(c.database) ? DB_ENGINES[c.database] : null);

export const dbImage = (e: DbEngine, version: string): string => `${e.image}:${version}${e.tagSuffix}`;

/** What a database adds to the `docker run` line of a VM: the data volume, and the command for an image that needs one. Both empty for an application. */
export const dbRunArgs = (c: { database?: string }, app: string): { volume: string; command: string } => {
  const e = databaseOf(c);
  return { volume: e ? ` -v ${app}-data:${e.dataPath}` : '', command: e?.command ? ` sh -c '${e.command}'` : '' };
};

/** The README line of a VM deployment of a database. */
export const DB_SINGLE_MACHINE_NOTE = '- This is a single machine: no automatic replacement or failover if it fails. It is a database, so it is never served over HTTP.';

/** The configuration for a database: the image, port, variables, data and limits of the engine; the deployment settings are kept, but never open to everyone. */
export function applyDatabase(c: ContainerConfig, id: DbEngineId, version?: string): ContainerConfig {
  const e = DB_ENGINES[id];
  const v = version && e.versions.includes(version) ? version : e.versions[0]!;
  // The person's own passwords and edits carry over when only the version changes; a different engine starts from its own variables.
  const keep = c.database === id ? c.env : [];
  const env = e.env.map((d) => keep.find((x) => x.key === d.key) ?? d);
  const privateRange = (cidr: string) => (cidr === '0.0.0.0/0' ? '10.0.0.0/16' : cidr);
  return {
    ...c,
    database: id, image: dbImage(e, v), version: v, port: e.port, healthPath: '/', env,
    memoryLimit: e.memory, cpuLimit: '1.0', restart: 'unless-stopped',
    postgres: false, redis: false, mysql: false, mongodb: false, rabbitmq: false, proxy: false, includeSample: false,
    ec2: { ...c.ec2, allowedCidr: privateRange(c.ec2.allowedCidr) },
    azvm: { ...c.azvm, allowedCidr: privateRange(c.azvm.allowedCidr) },
    // A place a database cannot go is switched off (the form offers only none, EC2 and Azure VM), so no error about it is left behind.
    ecs: { ...c.ecs, enabled: false }, aca: { ...c.aca, enabled: false }, k8s: { ...c.k8s, enabled: false }, aks: { ...c.aks, enabled: false },
  };
}

const PREFIX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
/** Whether a range is wide enough to count as "the internet" for a database (anything bigger than a /8). */
export const isInternetWide = (cidr: string): boolean => { const m = PREFIX.exec(cidr); return !!m && Number(m[5]) < 8; };

/** The places a database can be deployed to: a virtual machine, or nowhere (just the Docker Compose files). Everything else refuses it. */
export const DB_TARGETS: ReadonlySet<DeployTarget> = new Set<DeployTarget>(['none', 'ec2', 'azure-vm']);

/** Everything wrong with a database configuration (empty when it is fine or when this is not a database). */
export function validateDatabase(c: ContainerConfig): string[] {
  if (!c.database) return [];
  const e = databaseOf(c);
  if (!e) return [`Database: "${String(c.database).slice(0, 30)}" is not one of PostgreSQL, MySQL, MongoDB, Redis or RabbitMQ.`];
  const out: string[] = [];
  if (!e.versions.includes(c.version)) out.push(`${e.label}: version ${c.version} is not offered. Choose ${e.versions.join(', ')}.`);
  else if (c.image !== dbImage(e, c.version)) out.push(`${e.label}: the image is set by the version (${dbImage(e, c.version)}).`);
  if (c.port !== e.port) out.push(`${e.label}: the port is ${e.port}.`);
  for (const need of e.env.filter((v) => v.secret)) {
    const have = c.env.find((v) => v.key === need.key);
    if (!have) out.push(`${e.label}: add the variable ${need.key} (a password). It is read from the secret store and never written to a file.`);
    else if (!have.secret) out.push(`${e.label}: ${need.key} must be a secret, so its value stays out of the files.`);
  }
  for (const [on, name] of [[c.ecs.enabled, 'ECS Fargate'], [c.aca.enabled, 'Azure Container Apps'], [c.k8s.enabled, 'Kubernetes'], [c.aks.enabled, 'Azure AKS']] as const) {
    if (on) out.push(`${name}: a database cannot be deployed here. It needs persistent storage and a non-HTTP health check that this template does not set up. Run it on a virtual machine (EC2 or Azure VM) or use your cloud's managed database (Amazon RDS, Azure Database).`);
  }
  for (const [name, on, cidr] of [['EC2', c.ec2.enabled, c.ec2.allowedCidr], ['Azure VM', c.azvm.enabled, c.azvm.allowedCidr]] as const) {
    if (on && isInternetWide(cidr)) out.push(`${name}: a database must not be open to the internet. Use your own network range (for example 10.0.0.0/16 or your office's address), not ${cidr}.`);
  }
  return out;
}

/** Warnings that come with running a database on one machine. */
export function databaseWarnings(c: ContainerConfig): string[] {
  const e = databaseOf(c);
  if (!e) return [];
  const w: string[] = [];
  if (e.id === 'mongodb' && c.version === '8.0') w.push('MongoDB 8.0 refuses to start on Linux kernels 6.19 and newer (a known MongoDB issue). If it does not start on your machine, use version 7.0.');
  if (c.ec2.enabled || c.azvm.enabled) {
    w.push(`${e.label} runs on one machine, with its data on that machine's disk. If the machine is deleted the data goes with it, and there is no automatic failover. Take backups (the README shows the command) or use ${c.azvm.enabled ? 'Azure Database' : 'Amazon RDS / ElastiCache'} for production.`);
    w.push('Changing a setting here and deploying again does not restart the database or replace the machine, so the data is safe. To apply a change, connect to the machine and restart the container by hand, or replace the machine on purpose after taking a backup.');
  }
  return w;
}

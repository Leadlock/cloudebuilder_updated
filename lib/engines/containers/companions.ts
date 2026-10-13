/**
 * The services that can run next to the app in docker-compose.yml: PostgreSQL, Redis, MySQL, MongoDB, RabbitMQ, and a Caddy reverse
 * proxy that serves HTTPS. Pure text generation from the form state, kept apart from dockerTemplates.ts so that file stays about the app.
 *
 * Every password comes from the environment (`${NAME:?set NAME}`), never from a value in a file, and none of these services publishes a
 * port to the host: the app reaches them over the compose network. Only the proxy publishes (80 and 443).
 */
import type { ContainerConfig } from './dockerTemplates';

/** Hostname or "localhost". The proxy asks Let's Encrypt for a certificate for it (localhost gets a local one). */
export const PROXY_DOMAIN = /^(?:localhost|(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

export const dbName = (c: ContainerConfig) => c.appName.replace(/-/g, '_');

/** Human names of the companion services that are switched on. */
export function companionServices(c: ContainerConfig): string[] {
  return [c.postgres && 'PostgreSQL', c.redis && 'Redis', c.mysql && 'MySQL', c.mongodb && 'MongoDB', c.rabbitmq && 'RabbitMQ'].filter((s): s is string => !!s);
}

/** Names of the compose services the app waits for. */
export function companionDependencies(c: ContainerConfig): string[] {
  return [c.postgres && 'postgres', c.redis && 'redis', c.mysql && 'mysql', c.mongodb && 'mongodb', c.rabbitmq && 'rabbitmq'].filter((s): s is string => !!s);
}

/** Environment lines (YAML "KEY: value") that tell the app where its companions are. */
export function companionEnv(c: ContainerConfig): string[] {
  const db = dbName(c);
  return [
    ...(c.postgres ? [`DATABASE_URL: "postgres://${db}:\${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@postgres:5432/${db}"`] : []),
    ...(c.redis ? ['REDIS_URL: "redis://redis:6379"'] : []),
    ...(c.mysql ? [`MYSQL_URL: "mysql://${db}:\${MYSQL_PASSWORD:?set MYSQL_PASSWORD}@mysql:3306/${db}"`] : []),
    ...(c.mongodb ? [`MONGODB_URL: "mongodb://${db}:\${MONGODB_PASSWORD:?set MONGODB_PASSWORD}@mongodb:27017/${db}?authSource=admin"`] : []),
    ...(c.rabbitmq ? [`RABBITMQ_URL: "amqp://${db}:\${RABBITMQ_PASSWORD:?set RABBITMQ_PASSWORD}@rabbitmq:5672"`] : []),
  ];
}

/** Variables the person has to fill in .env for the companions. */
export function companionSecrets(c: ContainerConfig): string[] {
  return [c.postgres && 'POSTGRES_PASSWORD', c.mysql && 'MYSQL_PASSWORD', c.mongodb && 'MONGODB_PASSWORD', c.rabbitmq && 'RABBITMQ_PASSWORD'].filter((s): s is string => !!s);
}

/** The compose service blocks (each starting with a blank line). */
export function companionBlocks(c: ContainerConfig): string {
  const db = dbName(c);
  const r = c.restart;
  const hc = (test: string) => `    healthcheck:\n      test: ${test}\n      interval: 10s\n      timeout: 5s\n      retries: 5\n`;
  return [
    c.postgres ? `
  postgres:
    image: postgres:16-alpine
    restart: ${r}
    environment:
      POSTGRES_DB: ${db}
      POSTGRES_USER: ${db}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
${hc(`["CMD-SHELL", "pg_isready -U ${db} -d ${db}"]`)}` : '',
    c.redis ? `
  redis:
    image: redis:7-alpine
    restart: ${r}
${hc('["CMD", "redis-cli", "ping"]')}` : '',
    c.mysql ? `
  mysql:
    image: mysql:8.4
    restart: ${r}
    environment:
      MYSQL_DATABASE: ${db}
      MYSQL_USER: ${db}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD:?set MYSQL_PASSWORD}
      MYSQL_RANDOM_ROOT_PASSWORD: "yes"
    volumes:
      - mysqldata:/var/lib/mysql
${hc('["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -u\\"$$MYSQL_USER\\" -p\\"$$MYSQL_PASSWORD\\" --silent"]')}` : '',
    c.mongodb ? `
  mongodb:
    image: mongo:7
    restart: ${r}
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${db}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGODB_PASSWORD:?set MONGODB_PASSWORD}
    volumes:
      - mongodata:/data/db
${hc('["CMD-SHELL", "mongosh --quiet --eval \\"db.adminCommand(\'ping\').ok\\" | grep -q 1"]')}` : '',
    c.rabbitmq ? `
  rabbitmq:
    image: rabbitmq:3.13-alpine
    restart: ${r}
    environment:
      RABBITMQ_DEFAULT_USER: ${db}
      RABBITMQ_DEFAULT_PASS: \${RABBITMQ_PASSWORD:?set RABBITMQ_PASSWORD}
    volumes:
      - rabbitdata:/var/lib/rabbitmq
${hc('["CMD", "rabbitmq-diagnostics", "-q", "ping"]')}` : '',
    c.proxy ? `
  proxy:
    image: caddy:2-alpine
    restart: ${r}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      DOMAIN: ${JSON.stringify(c.proxyDomain)}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      ${c.appName}:
        condition: ${c.image !== '' ? 'service_started' : 'service_healthy'}
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
` : '',
  ].join('');
}

/** The top-level volumes section ("" when nothing needs one). */
export function companionVolumes(c: ContainerConfig): string {
  const v = [c.postgres && 'pgdata', c.mysql && 'mysqldata', c.mongodb && 'mongodata', c.rabbitmq && 'rabbitdata', c.proxy && 'caddy_data', c.proxy && 'caddy_config'].filter((s): s is string => !!s);
  return v.length ? `\nvolumes:\n${v.map((n) => `  ${n}:`).join('\n')}\n` : '';
}

export function caddyfile(c: ContainerConfig): string {
  return `# Caddy serves ${c.proxyDomain} over HTTPS and forwards to the app.
# A real domain gets a free Let's Encrypt certificate automatically: its DNS must point at this machine and ports 80 and 443 must be open to it.
# "localhost" gets a certificate from Caddy's own local authority (your browser will warn until you trust it: docker compose exec proxy caddy trust).
{$DOMAIN} {
	encode zstd gzip
	reverse_proxy ${c.appName}:${c.port}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		-Server
	}
}
`;
}

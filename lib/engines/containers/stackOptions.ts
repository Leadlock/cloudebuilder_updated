/**
 * The Stack choice of Container Templates, in four groups (Frontend, Backend, API, Database), each with its own list.
 * Frontend, Backend and API options are presets of the existing stacks (Node, Python, Java, Go, .NET, Ruby, static); Database options are the
 * database engines of databases.ts. Picking one rewrites the configuration; the deployment settings and the person's variables are kept.
 */
import { defaultConfig, type ContainerConfig, type ContainerStack } from './dockerTemplates';
import { applyDatabase, DB_ENGINES, DB_ENGINE_IDS, databaseOf, type DbEngineId } from './databases';

export type StackCategory = 'frontend' | 'backend' | 'api' | 'database';
export const STACK_CATEGORIES: { id: StackCategory; label: string; hint: string }[] = [
  { id: 'frontend', label: 'Frontend', hint: 'Web pages and single-page apps.' },
  { id: 'backend', label: 'Backend', hint: 'Application servers.' },
  { id: 'api', label: 'API', hint: 'Services that answer requests from other programs.' },
  { id: 'database', label: 'Database', hint: 'A database or queue run from its official image.' },
];

export interface StackOption {
  id: string;
  category: StackCategory;
  label: string;
  /** Whether a configuration is this option. */
  matches: (c: ContainerConfig) => boolean;
  /** The configuration after picking this option. */
  apply: (c: ContainerConfig) => ContainerConfig;
}

/** A new stack from the defaults of that stack, keeping what belongs to the deployment and to the person. Leaving a database starts without its variables. */
export function switchStack(c: ContainerConfig, stack: ContainerStack, over: Partial<ContainerConfig> = {}): ContainerConfig {
  const wasDatabase = !!c.database;
  return {
    ...defaultConfig(stack), appName: c.appName, env: wasDatabase ? [] : c.env, runAsNonRoot: c.runAsNonRoot, restart: c.restart, azvm: c.azvm, aks: c.aks,
    postgres: c.postgres, redis: c.redis, mysql: c.mysql, mongodb: c.mongodb, rabbitmq: c.rabbitmq, proxy: c.proxy, proxyDomain: c.proxyDomain, ec2: c.ec2, ecs: c.ecs, aca: c.aca, k8s: c.k8s,
    ...over,
  };
}

const app = (id: string, category: StackCategory, label: string, stack: ContainerStack, matches: (c: ContainerConfig) => boolean, over: Partial<ContainerConfig> = {}): StackOption => ({
  id, category, label, matches: (c) => !c.database && c.stack === stack && matches(c), apply: (c) => switchStack(c, stack, over),
});

const db = (id: DbEngineId): StackOption => ({
  id: `db-${id}`, category: 'database', label: DB_ENGINES[id].label, matches: (c) => c.database === id, apply: (c) => applyDatabase(c.database ? c : switchStack(c, 'node', { env: [] }), id),
});

export const STACK_OPTIONS: StackOption[] = [
  // Frontend
  app('spa', 'frontend', 'React / Vue / Vite app (single page, built and served by nginx)', 'static', (c) => c.staticSpaFallback, { staticSpaFallback: true }),
  app('static-site', 'frontend', 'Static website (several pages, served by nginx)', 'static', (c) => !c.staticSpaFallback, { staticSpaFallback: false }),
  app('nextjs', 'frontend', 'Next.js', 'node', (c) => c.nextStandalone, { nextStandalone: true }),
  // Backend
  app('node', 'backend', 'Node.js (Express, Fastify, NestJS)', 'node', (c) => !c.nextStandalone),
  app('python', 'backend', 'Python (Django, Flask)', 'python', () => true, { pythonFramework: 'flask', pythonModule: 'app:app' }),
  app('java', 'backend', 'Java (Spring Boot)', 'java', () => true),
  app('go', 'backend', 'Go', 'go', () => true),
  app('dotnet', 'backend', '.NET (ASP.NET Core)', 'dotnet', () => true),
  app('ruby', 'backend', 'Ruby (Rails, Rack)', 'ruby', () => true),
  // API
  app('fastapi', 'api', 'Python FastAPI', 'python', (c) => c.pythonFramework === 'fastapi', { pythonFramework: 'fastapi', healthPath: '/health' }),
  app('express-api', 'api', 'Node.js REST API (Express)', 'node', (c) => !c.nextStandalone, { healthPath: '/health' }),
  app('spring-api', 'api', 'Java Spring Boot API', 'java', () => true, { healthPath: '/actuator/health' }),
  app('aspnet-api', 'api', '.NET Web API', 'dotnet', () => true, { healthPath: '/health' }),
  app('go-api', 'api', 'Go HTTP API', 'go', () => true, { healthPath: '/health' }),
  // Database
  ...DB_ENGINE_IDS.map(db),
];

export const optionsFor = (category: StackCategory): StackOption[] => STACK_OPTIONS.filter((o) => o.category === category);

/** The option a configuration is, preferring the group the person last used (a FastAPI service is both a Backend and an API option). */
export function currentOption(c: ContainerConfig, prefer?: StackCategory): StackOption | undefined {
  if (databaseOf(c)) return STACK_OPTIONS.find((o) => o.category === 'database' && o.matches(c));
  const preferred = prefer ? optionsFor(prefer).find((o) => o.matches(c)) : undefined;
  if (preferred) return preferred;
  // Without a preference: a static site or Next.js is a Frontend; everything else is a Backend.
  return STACK_OPTIONS.find((o) => (o.category === 'frontend' || o.category === 'backend') && o.matches(c));
}

/** Pick an option by id in a configuration. Unknown ids change nothing. */
export function pickStackOption(c: ContainerConfig, id: string): ContainerConfig {
  const o = STACK_OPTIONS.find((x) => x.id === id);
  return o ? o.apply(c) : c;
}

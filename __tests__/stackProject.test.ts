/**
 * A project of up to four services (Frontend, Backend, API, Database) made into ONE set of files. Every combination works, no part changes another,
 * one part is exactly what the single-service generator gives, and the secrets never reach a file.
 */
import { parse } from 'yaml';
import { generateContainerFiles } from '@/lib/engines/containers/dockerTemplates';
import { pickStackOption } from '@/lib/engines/containers/stackOptions';
import {
  defaultProject, enabledLayers, generateProjectFiles, LAYERS, layerOf, mapLayerConfigs, projectFromConfig, validateProject, type Layer, type StackProject,
} from '@/lib/engines/containers/stackProject';

const project = (on: Layer[], name = 'shop'): StackProject => {
  const p = defaultProject();
  p.name = name;
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  return p;
};
const gen = (on: Layer[], tweak?: (p: StackProject) => void) => {
  const p = project(on);
  tweak?.(p);
  const r = generateProjectFiles(p);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r;
};
const file = (r: ReturnType<typeof gen>, path: string) => r.files.find((f) => f.path === path)?.content ?? '';
const composeOf = (r: ReturnType<typeof gen>) => parse(file(r, 'docker-compose.yml')) as { services: Record<string, Record<string, unknown>>; volumes?: Record<string, unknown> };

const combos = (): Layer[][] => {
  const out: Layer[][] = [];
  for (let m = 1; m < 16; m++) out.push(LAYERS.filter((_, i) => m & (1 << i)));
  return out;
};

describe('the default project', () => {
  test('has only the Backend (Node.js) on, and the other three ready but off', () => {
    const p = defaultProject();
    expect(enabledLayers(p)).toEqual(['backend']);
    expect(layerOf(p.layers.backend.config)).toBe('backend');
    expect(layerOf(p.layers.frontend.config)).toBe('frontend');
    expect(layerOf(p.layers.database.config)).toBe('database');
  });
});

describe('every combination of parts', () => {
  test.each(combos().filter((c) => c.length > 1).map((c) => [c.join('+'), c] as const))('%s: one compose file with exactly those services', (_n, on) => {
    const r = gen(on);
    expect(r.files.filter((f) => f.path === 'docker-compose.yml')).toHaveLength(1);
    expect(r.files.filter((f) => f.path === 'README.md')).toHaveLength(1);
    expect(r.files.filter((f) => f.path === '.env.example')).toHaveLength(1);
    expect(Object.keys(composeOf(r).services).sort()).toEqual([...on].sort());
    // Per-service files live in that service's folder; none of them writes its own compose file.
    expect(r.files.filter((f) => f.path.endsWith('/docker-compose.yml'))).toHaveLength(0);
    for (const l of on.filter((x) => x !== 'database')) expect(r.files.some((f) => f.path === `${l}/Dockerfile`)).toBe(true);
    expect(r.files.some((f) => f.path === 'database/Dockerfile')).toBe(false);
  });

  test('ticking a part never changes another part\'s files', () => {
    const alone = gen(['backend', 'api']);
    const withMore = gen(['frontend', 'backend', 'api', 'database']);
    for (const path of ['backend/Dockerfile', 'api/Dockerfile', 'backend/.dockerignore']) expect(file(withMore, path)).toBe(file(alone, path));
  });
});

describe('one part is exactly the single-service result', () => {
  test.each(LAYERS.map((l) => [l] as const))('%s alone', (l) => {
    const p = project([l]);
    expect(generateProjectFiles(p)).toEqual(generateContainerFiles(p.layers[l].config));
  });
  test('a loaded single configuration becomes a project of just that part', () => {
    const c = pickStackOption(defaultProject().layers.backend.config, 'spa');
    const p = projectFromConfig(c);
    expect(enabledLayers(p)).toEqual(['frontend']);
    expect(p.layers.frontend.config).toBe(c);
  });
});

describe('how the parts are connected', () => {
  test('a static frontend forwards /api/ to the API in its own nginx config', () => {
    const r = gen(['frontend', 'api']);
    expect(file(r, 'frontend/nginx.conf')).toMatch(/location \/api\/ \{[^}]*proxy_pass http:\/\/api:8000\//);
    expect(composeOf(r).services.frontend!.depends_on).toEqual({ api: { condition: 'service_healthy' } });
  });
  test('without an API the frontend talks to the Backend', () => {
    const r = gen(['frontend', 'backend']);
    expect(file(r, 'frontend/nginx.conf')).toContain('proxy_pass http://backend:3000/');
  });
  test('a frontend alone has nothing to talk to, and says so', () => {
    const r = gen(['frontend', 'database']);
    expect(r.warnings.join(' ')).toMatch(/Frontend/);
    expect(file(r, 'frontend/nginx.conf')).not.toContain('location /api/');
  });
  test('the API reaches the Backend through BACKEND_URL and waits for it', () => {
    const svc = composeOf(gen(['backend', 'api'])).services.api!;
    expect(svc.environment).toMatchObject({ BACKEND_URL: 'http://backend:3000' });
    expect(svc.depends_on).toEqual({ backend: { condition: 'service_healthy' } });
  });
  test('the Backend and the API get the database address, built from the shared password', () => {
    const s = composeOf(gen(['backend', 'api', 'database'])).services;
    for (const n of ['backend', 'api']) {
      expect((s[n]!.environment as Record<string, string>).DATABASE_URL).toBe('postgresql://app:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@database:5432/app');
      expect(s[n]!.depends_on).toMatchObject({ database: { condition: 'service_healthy' } });
    }
  });
  test('a database nobody uses is reported', () => {
    expect(gen(['frontend', 'database']).warnings.join(' ')).toMatch(/Database/);
  });
});

describe('ports', () => {
  test('only the frontend is open to everyone; the rest are bound to this machine', () => {
    const s = composeOf(gen(['frontend', 'backend', 'api', 'database'])).services;
    expect(s.frontend!.ports).toEqual(['8080:8080']);
    for (const n of ['backend', 'api', 'database']) for (const port of s[n]!.ports as string[]) expect(port.startsWith('127.0.0.1:')).toBe(true);
  });
  test('two parts on the same port get different ports on this machine, the same inside', () => {
    const r = gen(['backend', 'api'], (p) => { p.layers.api.config = { ...p.layers.api.config, port: 3000 }; });
    const ports = Object.values(composeOf(r).services).map((s) => (s.ports as string[])[0]!);
    expect(new Set(ports).size).toBe(2);
    expect(ports.every((x) => x.endsWith(':3000'))).toBe(true);
  });
});

describe('secrets', () => {
  test('the password is never in a file, only a reference to it, and .env.example asks for it', () => {
    const r = gen(['backend', 'database']);
    expect(file(r, '.env.example')).toMatch(/^POSTGRES_PASSWORD=$/m);
    for (const f of r.files) expect(f.content).not.toMatch(/POSTGRES_PASSWORD=[^\s]/);
    expect(file(r, 'docker-compose.yml')).toContain('${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}');
  });
  test('a secret variable of any part is listed once, with no value', () => {
    const r = gen(['backend', 'api'], (p) => { p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }]; p.layers.api.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }]; });
    expect(file(r, '.env.example').match(/^JWT_SECRET=$/gm)).toHaveLength(1);
  });
});

describe('what is refused', () => {
  test('no part ticked', () => {
    const p = project([]);
    expect(validateProject(p).join(' ')).toMatch(/at least one/i);
    expect(generateProjectFiles(p).ok).toBe(false);
  });
  test.each(['Bad Name', '-x', '', 'a'.repeat(50)])('the project name %j', (name) => {
    const p = project(['frontend', 'backend'], name);
    expect(validateProject(p).join(' ')).toMatch(/Project name/);
    expect(generateProjectFiles(p).ok).toBe(false);
  });
  test('a part\'s own error is shown with the part\'s name', () => {
    const p = project(['frontend', 'backend']);
    p.layers.backend.config = { ...p.layers.backend.config, port: 0 };
    const r = generateProjectFiles(p);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/^Backend:/);
  });
  test('a part that is switched off is not checked', () => {
    const p = project(['frontend', 'backend']);
    p.layers.api.config = { ...p.layers.api.config, port: 0 };
    expect(generateProjectFiles(p).ok).toBe(true);
  });
});

describe('mapLayerConfigs', () => {
  test('changes every part, on or off, and keeps what is ticked', () => {
    const p = mapLayerConfigs(project(['backend', 'api']), (c) => ({ ...c, memoryLimit: '2g' }));
    expect(LAYERS.every((l) => p.layers[l].config.memoryLimit === '2g')).toBe(true);
    expect(enabledLayers(p)).toEqual(['backend', 'api']);
  });
});

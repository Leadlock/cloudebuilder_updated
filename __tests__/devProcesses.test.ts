import { DEV_PROCESSES, LinePrefixer, RestartPolicy, devHostArgs, selectDevProcesses, tsxArgs } from '@/lib/dev/devProcesses';

describe('which processes npm run dev starts', () => {
  test('the web server and every worker', () => {
    const names = selectDevProcesses({}).map((p) => p.name);
    expect(names).toEqual(['web', 'worker:discovery', 'worker:terraform-apply']);
  });
  test('CLOUDCRAFT_DEV_WORKERS=off starts only the web server', () => {
    expect(selectDevProcesses({ CLOUDCRAFT_DEV_WORKERS: 'off' }).map((p) => p.name)).toEqual(['web']);
  });
  test('only the web server is essential, and every worker has a script that exists', async () => {
    expect(DEV_PROCESSES.filter((p) => p.essential).map((p) => p.name)).toEqual(['web']);
    const fs = await import('fs');
    const path = await import('path');
    for (const p of DEV_PROCESSES.filter((x) => x.script)) expect(fs.existsSync(path.join(process.cwd(), p.script!))).toBe(true);
  });
  test('package.json: dev starts everything, dev:web is the plain Next.js server, on this machine only', async () => {
    const pkg = JSON.parse((await import('fs')).readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['dev']).toBe('tsx scripts/dev-all.ts');
    expect(pkg.scripts['dev:web']).toBe('next dev -H 127.0.0.1');
  });
});

describe('LinePrefixer', () => {
  test('labels whole lines and holds a partial line until it is finished', () => {
    const p = new LinePrefixer('web');
    expect(p.push('ready in 2s\nlist')).toEqual(['[web] ready in 2s']);
    expect(p.push('ening\n')).toEqual(['[web] listening']);
    expect(p.push('no newline')).toEqual([]);
    expect(p.end()).toEqual(['[web] no newline']);
    expect(p.end()).toEqual([]);
  });
  test('handles Windows line endings', () => {
    expect(new LinePrefixer('w').push('a\r\nb\r\n')).toEqual(['[w] a', '[w] b']);
  });
});

describe('RestartPolicy', () => {
  test('a crash is retried after a growing wait', () => {
    const p = new RestartPolicy();
    expect(p.onExit(1, 0)).toEqual({ restart: true, delayMs: 1000 });
    expect(p.onExit(1, 1000)).toEqual({ restart: true, delayMs: 2000 });
    expect(p.onExit(1, 2000)).toEqual({ restart: true, delayMs: 4000 });
  });
  test('a clean exit is not restarted', () => {
    expect(new RestartPolicy().onExit(0)).toEqual({ restart: false, delayMs: 0 });
  });
  test('a worker that keeps crashing is given up on, with a message', () => {
    const p = new RestartPolicy(3, 60_000);
    p.onExit(1, 0); p.onExit(1, 1000);
    const d = p.onExit(1, 2000);
    expect(d.restart).toBe(false);
    expect(d.giveUp).toMatch(/not being restarted/);
  });
  test('old crashes stop counting once the window has passed', () => {
    const p = new RestartPolicy(3, 60_000);
    p.onExit(1, 0); p.onExit(1, 1000);
    expect(p.onExit(1, 120_000).restart).toBe(true);
  });
  test('the wait never exceeds 15 seconds', () => {
    const p = new RestartPolicy(100, 1e9);
    let last = 0;
    for (let i = 0; i < 20; i++) last = p.onExit(1, i).delayMs;
    expect(last).toBe(15_000);
  });
});

describe('tsxArgs', () => {
  test('loads .env when there is one (workers need DATABASE_URL and the encryption key)', () => {
    expect(tsxArgs('workers/x.ts', true)).toEqual(['--env-file=.env', '--tsconfig', 'tsconfig.json', 'workers/x.ts']);
    expect(tsxArgs('workers/x.ts', false)).toEqual(['--tsconfig', 'tsconfig.json', 'workers/x.ts']);
  });
});

describe('devHostArgs', () => {
  it('listens only on this machine unless told otherwise', () => {
    expect(devHostArgs({})).toEqual(['-H', '127.0.0.1']);
    expect(devHostArgs({ CLOUDCRAFT_DEV_HOST: '' })).toEqual(['-H', '127.0.0.1']);
  });
  it('opens the server only on purpose, with a plain address or name', () => {
    expect(devHostArgs({ CLOUDCRAFT_DEV_HOST: '0.0.0.0' })).toEqual(['-H', '0.0.0.0']);
    expect(devHostArgs({ CLOUDCRAFT_DEV_HOST: 'my-laptop.local' })).toEqual(['-H', 'my-laptop.local']);
  });
  it('ignores a value that is not an address (nothing is passed to the command line from it)', () => {
    expect(devHostArgs({ CLOUDCRAFT_DEV_HOST: '0.0.0.0; rm -rf /' })).toEqual(['-H', '127.0.0.1']);
    expect(devHostArgs({ CLOUDCRAFT_DEV_HOST: '--inspect' })).toEqual(['-H', '127.0.0.1']);   // never a flag
    expect(devHostArgs({ CLOUDCRAFT_DEV_HOST: '-x' })).toEqual(['-H', '127.0.0.1']);
  });
});

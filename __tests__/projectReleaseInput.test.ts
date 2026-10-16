/**
 * The project's settings from the browser: only what the project has, with the right types, bounded, and no secret value.
 */
import { defaultProject, LAYERS } from '@/lib/engines/containers/stackProject';
import { coerceProject, ProjectInputError } from '@/lib/deploy/project/projectInput';

const valid = () => { const p = defaultProject(); p.name = 'shop'; for (const l of LAYERS) p.layers[l].enabled = true; p.deploy.target = 'azure-vm'; return JSON.parse(JSON.stringify(p)); };

describe('coerceProject', () => {
  test('a project the panel produces comes back unchanged', () => {
    const p = valid();
    p.layers.backend.config.env = [{ key: 'LOG_LEVEL', value: 'debug' }, { key: 'JWT_SECRET', value: '', secret: true }];
    p.deploy.azvm.software = ['nginx'];
    expect(coerceProject(p)).toEqual(p);
  });

  test('missing settings take the defaults', () => {
    const p = coerceProject({ name: 'shop' });
    expect(p.layers.backend.enabled).toBe(true);
    expect(p.deploy.target).toBe('none');
  });

  test('keys the project does not have are dropped, including prototype tricks', () => {
    const p = valid();
    p.extra = 'x'; p.layers.backend.config.evil = { a: 1 };
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}');
    const out = coerceProject({ ...p, ...raw }) as unknown as Record<string, unknown>;
    expect(out['extra']).toBeUndefined();
    expect((out['layers'] as Record<string, { config: Record<string, unknown> }>)['backend']!.config['evil']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(Object.keys(defaultProject()).sort());
  });

  test.each([
    ['a string where a number is expected', (p: any) => { p.layers.api.config.port = '8000'; }, /layers\.api\.config\.port: must be a number/],
    ['NaN', (p: any) => { p.layers.api.config.port = Number.NaN; }, /must be a number/],
    ['a number where text is expected', (p: any) => { p.name = 5; }, /project\.name: must be text/],
    ['a string where true or false is expected', (p: any) => { p.layers.api.enabled = 'yes'; }, /must be true or false/],
    ['an object where text is expected', (p: any) => { p.deploy.azvm.size = { a: 1 }; }, /must be text/],
    ['text where an object is expected', (p: any) => { p.deploy = 'x'; }, /project\.deploy: must be an object/],
    ['an array where an object is expected', (p: any) => { p.layers = []; }, /project\.layers: must be an object/],
    ['a very long text', (p: any) => { p.name = 'a'.repeat(2001); }, /longer than 2000/],
    ['a NUL character', (p: any) => { p.name = 'a\0b'; }, /not allowed/],
    ['too many variables', (p: any) => { p.layers.api.config.env = Array.from({ length: 101 }, () => ({ key: 'A', value: '' })); }, /at most 100/],
    ['a variable that is not an object', (p: any) => { p.layers.api.config.env = ['A=b']; }, /must be a variable/],
    ['a variable with a non-text name', (p: any) => { p.layers.api.config.env = [{ key: 1, value: '' }]; }, /\.key: must be text/],
    ['a non-boolean secret flag', (p: any) => { p.layers.api.config.env = [{ key: 'A', value: '', secret: 'yes' }]; }, /\.secret: must be true or false/],
    ['a list item that is not text', (p: any) => { p.deploy.azvm.software = [1]; }, /must be text/],
    ['a list that is not a list', (p: any) => { p.deploy.azvm.software = 'nginx'; }, /must be a list/],
  ])('%s is refused with where', (_n, mutate, why) => {
    const p = valid(); mutate(p);
    expect(() => coerceProject(p)).toThrow(why);
    expect(() => coerceProject(p)).toThrow(ProjectInputError);
  });

  test('a secret with a value is refused: the value is typed into the write-only form, never sent with the settings', () => {
    const p = valid();
    p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: 'sneaked-in', secret: true }];
    expect(() => coerceProject(p)).toThrow(/a secret has no value here/);
    try { coerceProject(p); } catch (e) { expect((e as Error).message).not.toContain('sneaked-in'); }
  });

  test('anything that is not an object is refused', () => {
    for (const bad of [null, undefined, 'x', 5, [], () => 1]) expect(() => coerceProject(bad)).toThrow(/project: must be an object/);
  });

  test('the result does not share objects with the input', () => {
    const p = valid();
    const out = coerceProject(p);
    out.layers.api.config.port = 1;
    expect(p.layers.api.config.port).not.toBe(1);
  });
});

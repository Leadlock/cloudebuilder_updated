/**
 * parseBody: invalid JSON and NUL characters are a 400 with a clear message, never a 500 from the database later.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { parseBody, containsNulCharacter } from '@/lib/api/response';

const schema = z.object({ name: z.string(), tags: z.array(z.string()).optional(), nested: z.object({ note: z.string() }).optional() });
const post = (raw: string) => new NextRequest('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
const message = async (r: { ok: boolean; response?: Response }) => ((await r.response!.json()) as { error: { message: string } }).error.message;

describe('containsNulCharacter', () => {
  test('finds a NUL in a string, an array, a nested object and an object key', () => {
    expect(containsNulCharacter('a\u0000b')).toBe(true);
    expect(containsNulCharacter(['ok', 'x\u0000'])).toBe(true);
    expect(containsNulCharacter({ a: { b: ['c', { d: '\u0000' }] } })).toBe(true);
    expect(containsNulCharacter({ ['k\u0000']: 'v' })).toBe(true);
  });
  test('does not flag ordinary text, numbers, null, or the characters backslash-u0000 written out', () => {
    expect(containsNulCharacter({ a: 'plain', b: 1, c: null, d: true, e: ['x'] })).toBe(false);
    expect(containsNulCharacter('the escape \\u0000 as text')).toBe(false);
  });
});

describe('parseBody', () => {
  test('returns the data of a valid body', async () => {
    const r = await parseBody(post('{"name":"app","tags":["a","b"]}'), schema);
    expect(r).toEqual({ ok: true, data: { name: 'app', tags: ['a', 'b'] } });
  });

  test.each([
    ['in a field', '{"name":"a\\u0000b"}'],
    ['in an array item', '{"name":"x","tags":["ok","\\u0000"]}'],
    ['in a nested field', '{"name":"x","nested":{"note":"\\u0000"}}'],
  ])('a NUL character %s is a 400 that says so', async (_where, raw) => {
    const r = await parseBody(post(raw), schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      expect(await message(r)).toBe('The request contains an invalid character.');
    }
  });

  test('text that merely writes out backslash-u0000 is allowed', async () => {
    const r = await parseBody(post('{"name":"docs: the escape \\\\u0000 is NUL"}'), schema);
    expect(r.ok).toBe(true);
  });

  test('invalid JSON and a body that fails the schema are still 400s with their own messages', async () => {
    const bad = await parseBody(post('not json'), schema);
    expect(bad.ok).toBe(false);
    if (!bad.ok) { expect(bad.response.status).toBe(400); expect(await message(bad)).toBe('Invalid JSON body'); }
    const wrong = await parseBody(post('{"name":5}'), schema);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) { expect(wrong.response.status).toBe(400); expect(await message(wrong)).toBe('Validation failed'); }
  });
});

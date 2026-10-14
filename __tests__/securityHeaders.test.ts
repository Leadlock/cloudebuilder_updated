/**
 * The site's response headers: the content security policy is enforced (not report-only), allows nothing from another origin, and the
 * other hardening headers are present.
 */

/** The configuration as it is in production (the development one adds eval and websockets for the dev server). */
async function headers(): Promise<Record<string, string>> {
  const env = process.env as Record<string, string | undefined>;
  const before = env['NODE_ENV'];
  env['NODE_ENV'] = 'production';
  let rules: Awaited<ReturnType<NonNullable<typeof import('../next.config').default.headers>>> = [];
  try {
    await jest.isolateModulesAsync(async () => { rules = await (await import('../next.config')).default.headers!(); });
  } finally { env['NODE_ENV'] = before; }
  return Object.fromEntries(rules.flatMap((r) => r.headers).map((h) => [h.key, h.value]));
}

describe('security headers', () => {
  test('the full content security policy is enforced, and there is no report-only copy to forget about', async () => {
    const h = await headers();
    expect(h['Content-Security-Policy']).toBeDefined();
    expect(h['Content-Security-Policy-Report-Only']).toBeUndefined();
  });

  test('every fetch-type directive is limited to this site, with no wildcard or remote origin', async () => {
    const csp = (await headers())['Content-Security-Policy']!;
    for (const d of ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'worker-src', 'manifest-src']) {
      const value = csp.split('; ').find((x) => x.startsWith(`${d} `));
      expect(value).toBeDefined();
      expect(value).toContain("'self'");
      expect(value).not.toMatch(/\*|https?:/);
    }
  });

  test('framing, plugins, a changed base address and forms posting elsewhere are blocked', async () => {
    const csp = (await headers())['Content-Security-Policy']!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  test('scripts may not be evaluated from strings in production', async () => {
    expect((await headers())['Content-Security-Policy']).not.toContain('unsafe-eval');
  });

  test('the other hardening headers are set', async () => {
    const h = await headers();
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBeDefined();
    expect(h['Permissions-Policy']).toBeDefined();
  });
});

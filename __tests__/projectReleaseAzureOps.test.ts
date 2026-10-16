/**
 * The Azure calls of a release, against a fake Azure: the right address, method, body and token for each, long operations followed to the end,
 * and every refusal turned into a short, safe message.
 */
import { createAzureOps, vaultName, AzureError } from '@/lib/deploy/project/azureOps';

type Handler = (req: { method: string; url: string; headers: Record<string, string>; body: string }) => { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

function fakeAzure(routes: Array<[RegExp, Handler]>) {
  const log: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const req = { method: init.method ?? 'GET', url: String(url), headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)), body: typeof init.body === 'string' ? init.body : init.body ? `<${(init.body as Uint8Array).length} bytes>` : '' };
    log.push(req);
    const h = routes.find(([re]) => re.test(`${req.method} ${req.url}`));
    if (!h) return new Response('no route', { status: 599 });
    const r = h[1](req);
    return new Response(r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : ''), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, log };
}

const scopes: string[] = [];
const base = { subscriptionId: 'sub-1', getToken: async (scope: string) => { scopes.push(scope); return `tok-for-${scope}`; }, sleep: async () => undefined, pollMs: 1 };

beforeEach(() => { scopes.length = 0; });

describe('secrets', () => {
  test('exists: 200 is yes, 404 is no, anything else is an error', async () => {
    const f = fakeAzure([[/GET https:\/\/kvshop\.vault\.azure\.net\/secrets\/JWT-SECRET/, () => ({ status: 200, json: { value: 'x' } })], [/GET https:\/\/kvshop\.vault\.azure\.net\/secrets\/NOPE/, () => ({ status: 404, json: { error: { code: 'SecretNotFound' } } })], [/secrets\/DENIED/, () => ({ status: 403, json: { error: { code: 'Forbidden', message: 'no' } } })]]);
    const ops = createAzureOps({ ...base, fetchImpl: f.fetchImpl });
    expect(await ops.secretExists('kvshop', 'JWT-SECRET')).toBe(true);
    expect(await ops.secretExists('kvshop', 'NOPE')).toBe(false);
    await expect(ops.secretExists('kvshop', 'DENIED')).rejects.toThrow(/Could not read secret DENIED: Forbidden: no/);
    expect(f.log[0]!.headers['Authorization']).toBe('Bearer tok-for-https://vault.azure.net/.default');
    expect(f.log[0]!.url).toContain('api-version=7.4');
  });

  test('put sends the value in the body to the vault only, with a vault token', async () => {
    const f = fakeAzure([[/PUT https:\/\/kvshop\.vault\.azure\.net\/secrets\/POSTGRES-PASSWORD/, () => ({ status: 200, json: {} })]]);
    await createAzureOps({ ...base, fetchImpl: f.fetchImpl }).putSecret('kvshop', 'POSTGRES-PASSWORD', 'pg.pass-2');
    expect(JSON.parse(f.log[0]!.body)).toEqual({ value: 'pg.pass-2' });
    expect(f.log[0]!.url).not.toContain('pg.pass-2');
    expect(scopes).toEqual(['https://vault.azure.net/.default']);
  });

  test('a refusal right after the role was assigned is retried, then succeeds', async () => {
    let n = 0;
    const f = fakeAzure([[/PUT .*secrets\//, () => (++n < 4 ? { status: 403, json: { error: { code: 'Forbidden' } } } : { status: 200, json: {} })]]);
    await createAzureOps({ ...base, fetchImpl: f.fetchImpl }).putSecret('kvshop', 'A', 'b');
    expect(n).toBe(4);
  });

  test('a refusal that goes on is reported with the role to fix it, and never with the value', async () => {
    const f = fakeAzure([[/PUT .*secrets\//, () => ({ status: 403, json: { error: { code: 'Forbidden', message: 'caller lacks permission' } } })]]);
    const err = await createAzureOps({ ...base, roleWaitMs: 0, fetchImpl: f.fetchImpl }).putSecret('kvshop', 'A', 'secret-value-1').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Could not store secret A: Forbidden: caller lacks permission \(the account needs the role Key Vault Secrets Officer/);
    expect((err as Error).message).not.toContain('secret-value-1');
  });

  test('names that could change the address are refused before any request', async () => {
    const f = fakeAzure([]);
    const ops = createAzureOps({ ...base, fetchImpl: f.fetchImpl });
    await expect(ops.putSecret('kv/../x', 'A', 'b')).rejects.toThrow(AzureError);
    await expect(ops.putSecret('kvshop', 'A/../B', 'b')).rejects.toThrow(AzureError);
    await expect(ops.secretExists('kvshop.evil.com#', 'A')).rejects.toThrow(AzureError);
    expect(f.log).toHaveLength(0);
  });

  test('a secret name in Key Vault uses hyphens', () => { expect(vaultName('POSTGRES_PASSWORD')).toBe('POSTGRES-PASSWORD'); });
});

describe('building an image in the registry', () => {
  const REG = 'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-shop/providers/Microsoft.ContainerRegistry/registries/acrshop';
  function registry(finalStatus: string, over: Array<[RegExp, Handler]> = []) {
    return fakeAzure([
      ...over,
      [/POST .*listBuildSourceUploadUrl/, () => ({ status: 200, json: { uploadUrl: 'https://store.blob.core.windows.net/up/abc?sig=SIGNED', relativePath: 'src/abc.tar.gz' } })],
      [/PUT https:\/\/store\.blob/, () => ({ status: 201 })],
      [/POST .*scheduleRun/, () => ({ status: 200, json: { properties: { runId: 'ca1', status: 'Queued' } } })],
      [/GET .*\/runs\/ca1\?/, (() => { let n = 0; return () => ({ status: 200, json: { properties: { status: ++n < 3 ? 'Running' : finalStatus } } }); })()],
      [/POST .*runs\/ca1\/listLogSasUrl/, () => ({ status: 200, json: { logLink: 'https://store.blob.core.windows.net/logs/ca1?sig=LOG' } })],
      [/GET https:\/\/store\.blob\.core\.windows\.net\/logs/, () => ({ status: 200, text: 'step 1\nstep 2\nERROR: npm ci failed\n' })],
    ]);
  }
  const args = { resourceGroup: 'rg-shop', registry: 'acrshop', image: 'shop-api:v1', source: Buffer.from('x'.repeat(100)) };

  test('uploads the source to the registry\'s own storage, schedules a Linux amd64 Docker build that pushes, and waits for it', async () => {
    const f = registry('Succeeded');
    const lines: string[] = [];
    await createAzureOps({ ...base, fetchImpl: f.fetchImpl }).acrBuild({ ...args, onLog: (l) => lines.push(l) });
    const up = f.log.find((r) => r.method === 'PUT')!;
    expect(up.url).toBe('https://store.blob.core.windows.net/up/abc?sig=SIGNED');
    expect(up.headers['x-ms-blob-type']).toBe('BlockBlob');
    expect(up.headers['Authorization']).toBeUndefined();                       // the signed address is the credential; the token must not go to storage
    expect(up.body).toBe('<100 bytes>');
    const sched = f.log.find((r) => r.url.includes('scheduleRun'))!;
    expect(sched.url).toBe(`${REG}/scheduleRun?api-version=2019-06-01-preview`);
    expect(JSON.parse(sched.body)).toEqual({ type: 'DockerBuildRequest', imageNames: ['shop-api:v1'], isPushEnabled: true, noCache: false, dockerFilePath: 'Dockerfile', sourceLocation: 'src/abc.tar.gz', platform: { os: 'Linux', architecture: 'amd64' } });
    expect(lines.at(-1)).toBe('shop-api:v1: built and pushed');
  });

  test.each(['Failed', 'Error', 'Canceled', 'Timeout'])('a build that ends %s fails with the end of its log', async (status) => {
    const f = registry(status);
    const err = await createAzureOps({ ...base, fetchImpl: f.fetchImpl }).acrBuild(args).catch((e: Error) => e);
    expect((err as Error).message).toContain(`The build of shop-api:v1 ${status.toLowerCase()}.`);
    expect((err as Error).message).toContain('ERROR: npm ci failed');
  });

  test('a build that never ends is given up on', async () => {
    const f = registry('Running');
    const ops = createAzureOps({ ...base, buildTimeoutMs: -1, fetchImpl: f.fetchImpl });
    await expect(ops.acrBuild(args)).rejects.toThrow(/did not finish in time/);
  });

  test('a refused upload address or upload is reported, and nothing is scheduled', async () => {
    const noUrl = fakeAzure([[/listBuildSourceUploadUrl/, () => ({ status: 403, json: { error: { code: 'AuthorizationFailed', message: 'denied' } } })]]);
    await expect(createAzureOps({ ...base, fetchImpl: noUrl.fetchImpl }).acrBuild(args)).rejects.toThrow(/Could not start the build: AuthorizationFailed: denied/);
    const badPut = registry('Succeeded', [[/PUT https:\/\/store\.blob/, () => ({ status: 403 })]]);
    await expect(createAzureOps({ ...base, fetchImpl: badPut.fetchImpl }).acrBuild(args)).rejects.toThrow(/Could not upload the source for shop-api:v1 \(HTTP 403\)/);
    expect(badPut.log.some((r) => r.url.includes('scheduleRun'))).toBe(false);
  });

  test('registry, group and image names that could change the address are refused first', async () => {
    const f = fakeAzure([]);
    const ops = createAzureOps({ ...base, fetchImpl: f.fetchImpl });
    for (const bad of [{ registry: 'acr/../x' }, { resourceGroup: 'rg/../x' }, { image: 'no-tag' }, { image: 'UPPER:1' }]) await expect(ops.acrBuild({ ...args, ...bad })).rejects.toThrow(AzureError);
    expect(f.log).toHaveLength(0);
  });
});

describe('the VM', () => {
  const VM = 'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-shop/providers/Microsoft.Compute/virtualMachines/vm-shop';

  test('a tag is added to the ones the VM already has (an update replaces the whole set)', async () => {
    const f = fakeAzure([[/GET .*virtualMachines\/vm-shop\?/, () => ({ status: 200, json: { tags: { acr: 'acrshop.azurecr.io', vault: 'kvshop', image_tag: 'v1' } } })], [/PATCH .*virtualMachines\/vm-shop\?/, () => ({ status: 200, json: {} })]]);
    await createAzureOps({ ...base, fetchImpl: f.fetchImpl }).setVmTag('rg-shop', 'vm-shop', 'image_tag', 'v2');
    const patch = f.log.find((r) => r.method === 'PATCH')!;
    expect(patch.url).toBe(`${VM}?api-version=2024-03-01`);
    expect(JSON.parse(patch.body)).toEqual({ tags: { acr: 'acrshop.azurecr.io', vault: 'kvshop', image_tag: 'v2' } });
  });

  test('a tag update that Azure accepts and finishes later is followed to the end', async () => {
    let polls = 0;
    const f = fakeAzure([
      [/GET .*virtualMachines\/vm-shop\?/, () => ({ status: 200, json: { tags: {} } })],
      [/PATCH /, () => ({ status: 202, headers: { 'azure-asyncoperation': 'https://management.azure.com/op/1' } })],
      [/GET https:\/\/management\.azure\.com\/op\/1/, () => ({ status: 200, json: { status: ++polls < 3 ? 'InProgress' : 'Succeeded' } })],
    ]);
    await createAzureOps({ ...base, fetchImpl: f.fetchImpl }).setVmTag('rg-shop', 'vm-shop', 'image_tag', 'v2');
    expect(polls).toBe(3);
  });

  test('a command is sent as a RunShellScript, followed through Location, and its output is returned', async () => {
    let polls = 0;
    const f = fakeAzure([
      [/POST .*runCommand/, () => ({ status: 202, headers: { location: 'https://management.azure.com/op/rc' } })],
      [/GET https:\/\/management\.azure\.com\/op\/rc/, () => (++polls < 2 ? { status: 202, headers: { location: 'https://management.azure.com/op/rc' } } : { status: 200, json: { value: [{ message: 'Enable succeeded: \n[stdout]\nrestarted\n__CC_EXIT=0\n[stderr]\n' }] } })],
    ]);
    const out = await createAzureOps({ ...base, fetchImpl: f.fetchImpl }).runShell('rg-shop', 'vm-shop', 'systemctl restart shop.service');
    const post = f.log.find((r) => r.method === 'POST')!;
    expect(post.url).toBe(`${VM}/runCommand?api-version=2024-03-01`);
    const body = JSON.parse(post.body) as { commandId: string; script: string[] };
    expect(body.commandId).toBe('RunShellScript');
    expect(body.script.join('\n')).toContain('systemctl restart shop.service');
    expect(out).toContain('restarted');
    expect(out).not.toContain('__CC_EXIT');
  });

  test('a command that exits with an error fails with its exit status and the end of its output', async () => {
    const f = fakeAzure([[/POST .*runCommand/, () => ({ status: 200, json: { value: [{ message: 'Enable succeeded: \n[stdout]\n\n[stderr]\nUnit shop.service not found.\n__CC_EXIT=5' }] } })]]);
    await expect(createAzureOps({ ...base, fetchImpl: f.fetchImpl }).runShell('rg-shop', 'vm-shop', 'x')).rejects.toThrow(/The command failed on the VM \(exit 5\)[\s\S]*not found/);
  });

  test('a command that reports no exit status is a failure, not a success', async () => {
    const f = fakeAzure([[/POST .*runCommand/, () => ({ status: 200, json: { value: [{ message: 'Enable succeeded' }] } })]]);
    await expect(createAzureOps({ ...base, fetchImpl: f.fetchImpl }).runShell('rg-shop', 'vm-shop', 'x')).rejects.toThrow(/did not report how the command ended/);
  });

  test('Azure refusing the command, or a VM name that could change the address', async () => {
    const f = fakeAzure([[/POST .*runCommand/, () => ({ status: 409, json: { error: { code: 'OperationNotAllowed', message: 'VM is not running' } } })]]);
    const ops = createAzureOps({ ...base, fetchImpl: f.fetchImpl });
    await expect(ops.runShell('rg-shop', 'vm-shop', 'x')).rejects.toThrow(/OperationNotAllowed: VM is not running/);
    await expect(ops.runShell('rg/../x', 'vm-shop', 'x')).rejects.toThrow(AzureError);
    await expect(ops.setVmTag('rg-shop', 'vm?x=1', 'a', 'b')).rejects.toThrow(AzureError);
    await expect(ops.setVmTag('rg-shop', 'vm-shop', 'bad key', 'b')).rejects.toThrow(AzureError);
  });
});

describe('the public address', () => {
  test('answers for a success status, not for an error, a refusal or a timeout; and never throws', async () => {
    const f = fakeAzure([[/GET http:\/\/up\//, () => ({ status: 200, text: 'ok' })], [/GET http:\/\/err\//, () => ({ status: 502 })]]);
    const ops = createAzureOps({ ...base, fetchImpl: f.fetchImpl });
    expect(await ops.httpOk('http://up/')).toBe(true);
    expect(await ops.httpOk('http://err/')).toBe(false);
    const throws = createAzureOps({ ...base, fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    expect(await throws.httpOk('http://down/')).toBe(false);
  });
});

describe('what never appears', () => {
  test('no token or secret value is in any URL', async () => {
    const f = fakeAzure([[/PUT .*secrets\//, () => ({ status: 200, json: {} })], [/GET .*secrets\//, () => ({ status: 200, json: {} })]]);
    const ops = createAzureOps({ ...base, fetchImpl: f.fetchImpl });
    await ops.putSecret('kvshop', 'A', 'value-123');
    await ops.secretExists('kvshop', 'A');
    for (const r of f.log) { expect(r.url).not.toContain('tok-for'); expect(r.url).not.toContain('value-123'); }
  });
});

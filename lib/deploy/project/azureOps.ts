/**
 * What a release does in Azure that is not Terraform: store a secret, build an image in the registry, set a tag on the VM, run a command on it,
 * and look at the public address. Behind one small interface so every step is tested with a fake; the real implementation talks to Azure's REST
 * APIs with an Azure AD token (the connected account's service principal), so no new SDK package is needed.
 *
 * Nothing here logs a secret value, a token or a source archive.
 */

export interface AzureOps {
  secretExists(vault: string, name: string): Promise<boolean>;
  /** Stores a secret. A brand-new role assignment can take a few minutes to apply, so a refusal is retried for a while. */
  putSecret(vault: string, name: string, value: string): Promise<void>;
  /** Builds `image` (name:tag) from the archive inside the registry and pushes it there. Resolves when the build succeeded; throws with the tail of its log otherwise. */
  acrBuild(a: { resourceGroup: string; registry: string; image: string; source: Buffer; onLog?: (line: string) => void }): Promise<void>;
  setVmTag(resourceGroup: string, vm: string, key: string, value: string): Promise<void>;
  /** Runs a shell script as root on the VM and returns what it printed. Throws when the script exits with an error. */
  runShell(resourceGroup: string, vm: string, script: string): Promise<string>;
  httpOk(url: string): Promise<boolean>;
  /** Whether a resource group is still there (a teardown that finished leaves none). */
  resourceGroupExists(resourceGroup: string): Promise<boolean>;
}

/** What a release on Azure Container Apps needs besides AzureOps. */
export interface AcaOps {
  /** Whether the secret holds a value somebody stored: a secret that is only the marker a release's Terraform leaves counts as not stored. */
  secretHasValue(vault: string, name: string): Promise<boolean>;
  /** Points a Container App at another image (a new revision) and waits until Azure has provisioned it. Nothing needs to run yet. */
  containerAppSetImage(a: { resourceGroup: string; app: string; image: string }): Promise<void>;
  /** Gives a Container App its minimum number of replicas and waits until its newest revision is ready and running. */
  containerAppStart(a: { resourceGroup: string; app: string; minReplicas: number; onLog?: (line: string) => void }): Promise<void>;
}

export interface AzureOpsDeps {
  subscriptionId: string;
  /** An Azure AD access token for a resource, for example "https://management.azure.com/.default". */
  getToken: (scope: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait between looks at a long operation, and the most it may take. */
  pollMs?: number;
  buildTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** How long a refused secret write is retried (a new role assignment taking effect). */
  roleWaitMs?: number;
}

const ARM = 'https://management.azure.com';
const ARM_SCOPE = `${ARM}/.default`;
const VAULT_SCOPE = 'https://vault.azure.net/.default';
const REGISTRY_API = '2019-06-01-preview';
const COMPUTE_API = '2024-03-01';
const APP_API = '2024-03-01';
const APP_NAME = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const APP_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VAULT_NAME = /^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/;
const SECRET_NAME = /^[A-Za-z0-9-]{1,127}$/;
const ACR_NAME = /^[a-z0-9]{5,50}$/;
const IMAGE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MARKER = '__CC_EXIT=';

/** A secret's name in Key Vault: letters, digits and "-" only. */
export const vaultName = (key: string) => key.replace(/_/g, '-');

export class AzureError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); this.name = 'AzureError'; }
}

/** The short reason in an Azure error body, never the whole body. */
function reason(body: unknown, fallback: string): string {
  const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
  return e?.message ? `${e.code ? `${e.code}: ` : ''}${String(e.message).slice(0, 300)}` : fallback;
}

export function createAzureOps(deps: AzureOpsDeps): AzureOps & AcaOps {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 5000;
  const base = `${ARM}/subscriptions/${encodeURIComponent(deps.subscriptionId)}`;

  const call = async (url: string, init: { method?: string; scope: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> }) => {
    const token = await deps.getToken(init.scope);
    const res = await f(url, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: the status is what matters */ }
    return { status: res.status, ok: res.ok, json, text, headers: res.headers };
  };

  /** A long operation: follow Location (the result) or Azure-AsyncOperation (a status) until it finishes. */
  const finish = async (first: Awaited<ReturnType<typeof call>>, what: string, timeoutMs: number): Promise<Awaited<ReturnType<typeof call>>> => {
    let res = first;
    const started = Date.now();
    // What to look at, kept from the first answer: later answers may not repeat it.
    let url = first.headers.get('location') ?? first.headers.get('azure-asyncoperation');
    const byStatus = !first.headers.get('location') && !!first.headers.get('azure-asyncoperation');
    while (res.status === 202) {
      if (!url) throw new AzureError(`${what}: Azure accepted the request but gave no way to follow it.`);
      if (Date.now() - started > timeoutMs) throw new AzureError(`${what} did not finish in time.`);
      await sleep(pollMs);
      res = await call(url, { scope: ARM_SCOPE });
      url = res.headers.get('location') ?? url;
      if (byStatus && res.ok) {
        const status = String((res.json as { status?: string } | null)?.status ?? '');
        if (status === 'Succeeded') return res;
        if (status === 'Failed' || status === 'Canceled') throw new AzureError(`${what} failed: ${reason({ error: (res.json as { error?: unknown } | null)?.error }, status)}`);
        res = { ...res, status: 202 };
      }
    }
    if (!res.ok) throw new AzureError(`${what} failed: ${reason(res.json, `HTTP ${res.status}`)}`, res.status);
    return res;
  };

  const vaultUrl = (vault: string, name: string) => {
    if (!VAULT_NAME.test(vault) || !SECRET_NAME.test(name)) throw new AzureError('The vault or secret name is not valid.');
    return `https://${vault}.vault.azure.net/secrets/${name}?api-version=7.4`;
  };
  const vmUrl = (rg: string, vm: string, tail = '') => {
    if (!NAME.test(rg) || !NAME.test(vm)) throw new AzureError('The resource group or VM name is not valid.');
    return `${base}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${vm}${tail}`;
  };

  return {
    async secretExists(vault, name) {
      const r = await call(vaultUrl(vault, name), { scope: VAULT_SCOPE });
      if (r.status === 404) return false;
      if (r.ok) return true;
      throw new AzureError(`Could not read secret ${name}: ${reason(r.json, `HTTP ${r.status}`)}`, r.status);
    },

    async putSecret(vault, name, value) {
      const url = vaultUrl(vault, name);
      const deadline = Date.now() + (deps.roleWaitMs ?? 5 * 60_000);
      for (;;) {
        const r = await call(url, { method: 'PUT', scope: VAULT_SCOPE, body: { value } });
        if (r.ok) return;
        // 401 and 403 right after the role was assigned mean "not yet": try again for a while.
        if ((r.status === 401 || r.status === 403) && Date.now() < deadline) { await sleep(pollMs); continue; }
        throw new AzureError(`Could not store secret ${name}: ${reason(r.json, `HTTP ${r.status}`)}${r.status === 403 ? ' (the account needs the role Key Vault Secrets Officer on the vault)' : ''}`, r.status);
      }
    },

    async acrBuild({ resourceGroup, registry, image, source, onLog }) {
      if (!NAME.test(resourceGroup) || !ACR_NAME.test(registry) || !IMAGE.test(image)) throw new AzureError('The registry, resource group or image name is not valid.');
      const reg = `${base}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${registry}`;
      const up = await call(`${reg}/listBuildSourceUploadUrl?api-version=${REGISTRY_API}`, { method: 'POST', scope: ARM_SCOPE });
      const target = up.json as { uploadUrl?: string; relativePath?: string } | null;
      if (!up.ok || !target?.uploadUrl || !target.relativePath) throw new AzureError(`Could not start the build: ${reason(up.json, `HTTP ${up.status}`)}`, up.status);
      // The upload address is a short-lived signed address of the registry's own storage: no Authorization header goes there.
      const put = await f(target.uploadUrl, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/gzip' }, body: new Uint8Array(source) });
      if (!put.ok) throw new AzureError(`Could not upload the source for ${image} (HTTP ${put.status}).`, put.status);

      const sched = await call(`${reg}/scheduleRun?api-version=${REGISTRY_API}`, {
        method: 'POST', scope: ARM_SCOPE,
        body: { type: 'DockerBuildRequest', imageNames: [image], isPushEnabled: true, noCache: false, dockerFilePath: 'Dockerfile', sourceLocation: target.relativePath, platform: { os: 'Linux', architecture: 'amd64' } },
      });
      const done = await finish(sched, `Build of ${image}`, deps.buildTimeoutMs ?? 20 * 60_000);
      const runId = (done.json as { properties?: { runId?: string } } | null)?.properties?.runId;
      if (!runId || !NAME.test(runId)) throw new AzureError(`The build of ${image} started but Azure did not name it.`);

      const started = Date.now();
      for (;;) {
        const r = await call(`${reg}/runs/${runId}?api-version=${REGISTRY_API}`, { scope: ARM_SCOPE });
        if (!r.ok) throw new AzureError(`Could not read the build of ${image}: ${reason(r.json, `HTTP ${r.status}`)}`, r.status);
        const status = String((r.json as { properties?: { status?: string } } | null)?.properties?.status ?? '');
        if (status === 'Succeeded') { onLog?.(`${image}: built and pushed`); return; }
        if (['Failed', 'Error', 'Canceled', 'Timeout'].includes(status)) {
          throw new AzureError(`The build of ${image} ${status.toLowerCase()}.${await logTail(reg, runId)}`);
        }
        if (Date.now() - started > (deps.buildTimeoutMs ?? 20 * 60_000)) throw new AzureError(`The build of ${image} did not finish in time.`);
        onLog?.(`${image}: ${status || 'working'}…`);
        await sleep(pollMs);
      }
    },

    async setVmTag(resourceGroup, vm, key, value) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || value.length > 256) throw new AzureError('The tag is not valid.');
      const cur = await call(`${vmUrl(resourceGroup, vm)}?api-version=${COMPUTE_API}`, { scope: ARM_SCOPE });
      if (!cur.ok) throw new AzureError(`Could not read the VM: ${reason(cur.json, `HTTP ${cur.status}`)}`, cur.status);
      // A tags update replaces the whole set, so the others are sent back with it.
      const tags = { ...((cur.json as { tags?: Record<string, string> } | null)?.tags ?? {}), [key]: value };
      const r = await call(`${vmUrl(resourceGroup, vm)}?api-version=${COMPUTE_API}`, { method: 'PATCH', scope: ARM_SCOPE, body: { tags } });
      await finish(r, 'Setting the VM tag', deps.commandTimeoutMs ?? 5 * 60_000);
    },

    async runShell(resourceGroup, vm, script) {
      // A run command reports no exit status of its own: the script says it.
      const wrapped = `set +e\n(\n${script}\n)\necho "${MARKER}$?"`;
      const r = await call(`${vmUrl(resourceGroup, vm, '/runCommand')}?api-version=${COMPUTE_API}`, { method: 'POST', scope: ARM_SCOPE, body: { commandId: 'RunShellScript', script: wrapped.split('\n') } });
      const done = await finish(r, 'Running the command on the VM', deps.commandTimeoutMs ?? 5 * 60_000);
      const message = ((done.json as { value?: Array<{ message?: string }> } | null)?.value ?? []).map((v) => v.message ?? '').join('\n');
      const m = new RegExp(`${MARKER}(\\d+)`).exec(message);
      if (!m) throw new AzureError('The VM did not report how the command ended.');
      const output = message.replace(new RegExp(`${MARKER}\\d+`), '').replace(/^Enable succeeded:\s*/, '').trim();
      if (m[1] !== '0') throw new AzureError(`The command failed on the VM (exit ${m[1]}): ${output.slice(-400)}`);
      return output;
    },

    async secretHasValue(vault, name) {
      const r = await call(vaultUrl(vault, name), { scope: VAULT_SCOPE });
      if (r.status === 404) return false;
      if (!r.ok) throw new AzureError(`Could not read secret ${name}: ${reason(r.json, `HTTP ${r.status}`)}`, r.status);
      return (r.json as { tags?: Record<string, string> } | null)?.tags?.['cloudcraft'] !== 'placeholder';
    },

    async containerAppSetImage({ resourceGroup, app, image }) {
      if (!NAME.test(resourceGroup) || !APP_NAME.test(app) || !APP_IMAGE.test(image)) throw new AzureError('The resource group, app or image name is not valid.');
      const url = appUrl(resourceGroup, app);
      const cur = await readApp(url, app);
      const template = cur.properties?.template as { containers?: Array<Record<string, unknown>> } | undefined;
      if (!template?.containers?.length) throw new AzureError(`The app ${app} has no container.`);
      const containers = template.containers.map((c, i) => (i === 0 ? { ...c, image } : c));
      const r = await call(url, { method: 'PATCH', scope: ARM_SCOPE, body: { properties: { template: { ...template, containers } } } });
      await finish(r, `Pointing ${app} at ${image}`, deps.commandTimeoutMs ?? 10 * 60_000);
      await waitApp(url, app, false);
    },

    async containerAppStart({ resourceGroup, app, minReplicas, onLog }) {
      if (!NAME.test(resourceGroup) || !APP_NAME.test(app) || !Number.isInteger(minReplicas) || minReplicas < 1 || minReplicas > 30) throw new AzureError('The resource group, app or replica count is not valid.');
      const url = appUrl(resourceGroup, app);
      const cur = await readApp(url, app);
      const template = cur.properties?.template as { scale?: Record<string, unknown> } | undefined;
      if (!template) throw new AzureError(`The app ${app} has no template.`);
      const r = await call(url, { method: 'PATCH', scope: ARM_SCOPE, body: { properties: { template: { ...template, scale: { ...(template.scale ?? {}), minReplicas } } } } });
      await finish(r, `Starting ${app}`, deps.commandTimeoutMs ?? 10 * 60_000);
      await waitApp(url, app, true, onLog);
    },

    async resourceGroupExists(resourceGroup) {
      if (!NAME.test(resourceGroup)) throw new AzureError('The resource group name is not valid.');
      const r = await call(`${base}/resourcegroups/${resourceGroup}?api-version=2021-04-01`, { scope: ARM_SCOPE });
      if (r.status === 404) return false;
      if (r.ok) return true;
      throw new AzureError(`Could not look for the resource group: ${reason(r.json, `HTTP ${r.status}`)}`, r.status);
    },

    async httpOk(url) {
      try {
        const res = await f(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
        return res.ok;
      } catch { return false; }
    },
  };

  function appUrl(rg: string, app: string) {
    if (!NAME.test(rg) || !APP_NAME.test(app)) throw new AzureError('The resource group or app name is not valid.');
    return `${base}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${app}?api-version=${APP_API}`;
  }

  async function readApp(url: string, app: string): Promise<{ properties?: Record<string, unknown> }> {
    const r = await call(url, { scope: ARM_SCOPE });
    if (!r.ok) throw new AzureError(`Could not read the app ${app}: ${reason(r.json, `HTTP ${r.status}`)}`, r.status);
    return r.json as { properties?: Record<string, unknown> };
  }

  /** Waits for Azure to finish provisioning the app and, when it must run, for its newest revision to be ready and running. */
  async function waitApp(url: string, app: string, mustRun: boolean, onLog?: (line: string) => void) {
    const started = Date.now();
    const timeout = deps.buildTimeoutMs ?? 20 * 60_000;
    let last = '';
    for (;;) {
      const p = (await readApp(url, app)).properties ?? {};
      const state = String(p['provisioningState'] ?? '');
      if (state === 'Failed') throw new AzureError(`Azure could not provision ${app}.`);
      const running = String((p['runningStatus'] as { runningState?: string } | undefined)?.runningState ?? '');
      const ready = p['latestReadyRevisionName'] && p['latestReadyRevisionName'] === p['latestRevisionName'];
      const line = `${app}: ${state || 'provisioning'}${mustRun ? `, revision ${ready ? 'ready' : 'not ready'}${running ? `, ${running}` : ''}` : ''}`;
      if (line !== last) { last = line; onLog?.(line); }
      if (state === 'Succeeded' && (!mustRun || (ready && (running === '' || running === 'Running')))) return;
      if (Date.now() - started > timeout) throw new AzureError(`${app} did not become ready in time (${line}).`);
      await sleep(pollMs);
    }
  }

  async function logTail(reg: string, runId: string): Promise<string> {
    try {
      const l = await call(`${reg}/runs/${runId}/listLogSasUrl?api-version=${REGISTRY_API}`, { method: 'POST', scope: ARM_SCOPE });
      const link = (l.json as { logLink?: string } | null)?.logLink;
      if (!link) return '';
      const text = await (await f(link)).text();
      return ` Last lines of its log:\n${text.trim().split('\n').slice(-12).join('\n').slice(-1200)}`;
    } catch { return ''; }
  }
}

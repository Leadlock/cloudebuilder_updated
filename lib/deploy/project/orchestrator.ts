/**
 * Runs a release: the steps of deploying a project, in order, each one safe to repeat.
 *
 *   infrastructure  Terraform creates the resource group, registry, vault and VM (the existing plan/approve/apply machinery, behind `InfraRunner`)
 *   secrets         the secrets must be in the vault. If they are not, the release WAITS: the person enters them in a write-only form, the API writes
 *                   each straight to the vault (provideSecrets) and the release is resumed. CloudBuilder never holds a value.
 *   build           every service built from source is built inside the cloud registry
 *   publish         the image tag and the compose file are put on the VM
 *   start           the service on the VM is restarted
 *   verify          the public address answers
 *
 * A failure in publish, start or verify puts the previous release back (its tag and compose file) and restarts it, so a bad release does not
 * leave the site down. A failure earlier stops and says which step; nothing created is removed automatically.
 * Nothing here handles a credential or logs a secret value.
 */
import { buildBundle, sourceFiles, type ProjectBundle, type SourceInput } from './bundle';
import type { AzureOps } from './azureOps';
import { azureDriver, writeComposeScript, type ReleaseDriver } from './driver';
import type { ReleaseStore } from './releaseStore';
import { sha256Hex, type SourceStore } from './sourceStore';
import { readZip, ZipError } from './zip';
import { STEP_ORDER, newSteps, type Release, type ReleaseOutputs, type StepName, type StepRecord } from './types';
import type { StackProject } from '@/lib/engines/containers/stackProject';

/** Creates (or finds) the infrastructure of a release and says what it made. The real one plans, asks for approval and applies with Terraform. */
export interface InfraRunner {
  apply(release: Release, onOutput: (line: string) => void): Promise<ReleaseOutputs>;
}

export interface OrchestratorDeps {
  store: ReleaseStore;
  /** What the release does in the cloud. Either this, or `ops` (Azure's operations, wrapped in the Azure driver). */
  driver?: ReleaseDriver;
  ops?: AzureOps;
  infra: InfraRunner;
  /** Where uploaded code is kept. Needed for a release that builds a service from the person's own code. */
  sources?: SourceStore;
  /** True when the operator has switched Terraform execution off: honoured between steps, also for a release that was already queued. */
  killSwitch?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One safe line of progress for the person (and the audit trail). Never a value, never a credential. */
  log?: (releaseId: string, line: string) => void;
  /** How long the public address is given to answer, and how often it is asked. */
  verifyWaitMs?: number;
  verifyEveryMs?: number;
}

export class ReleaseError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'ReleaseError'; }
}

type Outcome = { state: 'done'; message?: string } | { state: 'waiting'; message: string };

/** How many lines of progress a release keeps. */
const LOG_LINES = 60;
const SECRET_VALUE = /^[A-Za-z0-9._~-]{1,200}$/;
const SECRET_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, 300);

async function bundleOf(release: Release, sources?: SourceStore): Promise<ProjectBundle> {
  const own: Record<string, SourceInput> = {};
  for (const [layer, ref] of Object.entries(release.sources ?? {})) {
    if (!sources) throw new ReleaseError('The uploaded code of this release cannot be read here.', 500);
    const stored = await sources.get(ref.id);
    if (!stored) throw new ReleaseError(`The uploaded code for the ${layer} has expired. Upload it again and plan the release again.`, 410);
    // It must be the file that was approved, for this organization, project and service.
    if (stored.orgId !== release.orgId || stored.projectId !== release.projectId || stored.layer !== layer || stored.sha256 !== ref.sha256 || sha256Hex(stored.zip) !== ref.sha256) {
      throw new ReleaseError(`The uploaded code for the ${layer} is not the one that was approved. Plan the release again.`, 409);
    }
    try { own[layer] = { sha256: ref.sha256, files: readZip(stored.zip).files }; }
    catch (err) { throw new ReleaseError(`The uploaded code for the ${layer} cannot be used: ${err instanceof ZipError ? err.message : 'it could not be read'}`); }
  }
  const bundle = buildBundle(release.settings as StackProject, own);
  // What is run is what was approved: the files are generated again here and must hash to what the approval was for.
  if (bundle.bundleHash !== release.bundleHash) throw new ReleaseError('The deployment files no longer match what was approved. Plan the release again.', 409);
  return bundle;
}

function step(release: Release, name: StepName): StepRecord {
  const s = release.steps.find((x) => x.name === name);
  if (!s) throw new ReleaseError(`Unknown step ${name}.`, 500);
  return s;
}

export { writeComposeScript };

/** The cloud driver of a run: the one it was given, or the Azure driver around the operations it was given. */
export function driverOf(deps: Pick<OrchestratorDeps, 'driver' | 'ops'>): ReleaseDriver {
  if (deps.driver) return deps.driver;
  if (deps.ops) return azureDriver(deps.ops);
  throw new ReleaseError('No cloud was given to run the release in.', 500);
}

export function newRelease(input: {
  id: string; orgId: string; projectId: string; environment: string; cloudAccountId: string; project: StackProject; bundle: ProjectBundle; createdBy: string;
  previousReleaseId: string | null; planId?: string | null; planHash?: string | null; sources?: Record<string, { id: string; sha256: string }>; now: number;
}): Release {
  return {
    id: input.id, orgId: input.orgId, projectId: input.projectId, environment: input.environment, cloudAccountId: input.cloudAccountId, target: 'azure-vm',
    bundleHash: input.bundle.bundleHash, planId: input.planId ?? null, planHash: input.planHash ?? null,
    project: input.bundle.project, settings: structuredClone(input.project), imageTag: input.bundle.imageTag, compose: input.bundle.compose,
    built: input.bundle.built, secrets: input.bundle.secrets, sources: input.sources ?? {}, status: 'planned', steps: newSteps(input.bundle.built.length > 0), outputs: null,
    previousReleaseId: input.previousReleaseId, rollbackOf: null, createdBy: input.createdBy, createdAt: input.now, updatedAt: input.now, error: null, log: [],
  };
}

/** The release has been approved: only the exact release that was planned can be. */
export async function approveRelease(store: ReleaseStore, releaseId: string, expected: { bundleHash: string; planHash: string | null }, now: number): Promise<Release> {
  const r = await store.get(releaseId);
  if (!r) throw new ReleaseError('Release not found.', 404);
  if (r.status !== 'planned') throw new ReleaseError(`This release is ${r.status}; only a planned release can be approved.`, 409);
  if (r.bundleHash !== expected.bundleHash || r.planHash !== expected.planHash) throw new ReleaseError('The approval is for different files or a different plan than this release.', 409);
  r.status = 'approved'; r.updatedAt = now;
  await store.save(r);
  return r;
}

/**
 * A release that puts an earlier successful one back: its tag and compose file on the same VM, with nothing built and no plan. Only a release that
 * succeeded can be put back, in the same project and environment, and not the one that is already running.
 */
export async function createRollbackRelease(store: ReleaseStore, input: { targetId: string; newId: string; orgId: string; projectId: string; createdBy: string; now: number }): Promise<Release> {
  const target = await store.get(input.targetId);
  if (!target || target.orgId !== input.orgId || target.projectId !== input.projectId) throw new ReleaseError('Release not found.', 404);
  if (target.status !== 'succeeded' || !target.outputs) throw new ReleaseError(`Only a release that succeeded can be put back; this one is ${target.status}.`, 409);
  const running = await store.latestSucceeded(target.projectId, target.environment);
  if (running && running.id === target.id) throw new ReleaseError('This release is the one that is running now.', 409);
  const skipped = new Set<StepName>(['infrastructure', 'secrets', 'build']);
  return {
    ...structuredClone(target),
    id: input.newId, status: 'approved', planId: null, planHash: null, previousReleaseId: running?.id ?? null, rollbackOf: target.id, createdBy: input.createdBy,
    createdAt: input.now, updatedAt: input.now, error: null, log: [],
    steps: STEP_ORDER.map((name) => ({ name, state: skipped.has(name) ? ('skipped' as const) : ('pending' as const) })),
  };
}

/**
 * After a teardown: when the resource group is gone, the releases that ran in it are not running any more. Returns how many were marked.
 * It asks Azure rather than believing the caller.
 */
export async function reconcileDestroyed(deps: Pick<OrchestratorDeps, 'store' | 'ops' | 'driver' | 'now'>, release: Release): Promise<number> {
  if (!release.outputs) return 0;
  const driver = driverOf(deps);
  if (await driver.exists(release.outputs)) return 0;
  let n = 0;
  for (const r of await deps.store.list(release.projectId, release.environment, 100)) {
    if (r.orgId !== release.orgId || r.status === 'destroyed' || r.status === 'planned' || r.status === 'cancelled') continue;
    if (!r.outputs || !driver.same(r.outputs, release.outputs)) continue;
    r.status = 'destroyed'; r.updatedAt = (deps.now ?? Date.now)();
    await deps.store.save(r); n++;
  }
  return n;
}

export async function cancelRelease(store: ReleaseStore, releaseId: string, now: number): Promise<Release> {
  const r = await store.get(releaseId);
  if (!r) throw new ReleaseError('Release not found.', 404);
  if (['succeeded', 'failed', 'rolled_back', 'cancelled'].includes(r.status)) throw new ReleaseError(`This release is already ${r.status}.`, 409);
  r.status = 'cancelled'; r.updatedAt = now;
  await store.save(r);
  return r;
}

/** Which secrets of the release are not in the vault yet. */
export async function missingSecrets(release: Release, cloud: ReleaseDriver | AzureOps): Promise<string[]> {
  const driver = 'build' in cloud ? cloud : azureDriver(cloud);
  if (!release.outputs) throw new ReleaseError('The infrastructure is not created yet.', 409);
  const missing: string[] = [];
  for (const name of release.secrets) if (!(await driver.secretExists(release.outputs, name))) missing.push(name);
  return missing;
}

/**
 * Stores the secret values the release is waiting for. Each goes straight to the vault; none is kept, returned or logged.
 * Only names the release is waiting for are accepted, so this cannot be used to write anything else into the vault.
 */
export async function provideSecrets(deps: Pick<OrchestratorDeps, 'store' | 'ops' | 'driver' | 'now'>, releaseId: string, values: Record<string, string>): Promise<{ missing: string[] }> {
  const driver = driverOf(deps);
  const r = await deps.store.get(releaseId);
  if (!r) throw new ReleaseError('Release not found.', 404);
  if (r.status !== 'waiting' || step(r, 'secrets').state !== 'waiting') throw new ReleaseError('This release is not waiting for secrets.', 409);
  const missing = await missingSecrets(r, driver);
  for (const [name, value] of Object.entries(values)) {
    if (!SECRET_KEY.test(name) || !missing.includes(name)) throw new ReleaseError(`${clean(name)} is not a secret this release is waiting for.`);
    if (typeof value !== 'string' || !SECRET_VALUE.test(value)) throw new ReleaseError(`${name} may use only letters, digits and . _ ~ - (no spaces or other symbols), up to 200 characters.`);
  }
  for (const [name, value] of Object.entries(values)) await driver.putSecret(r.outputs!, name, value);
  return { missing: await missingSecrets(r, driver) };
}

const STEP_RUNNERS: Record<StepName, (release: Release, deps: Required<Pick<OrchestratorDeps, 'infra' | 'verifyWaitMs' | 'verifyEveryMs' | 'sleep'>> & { driver: ReleaseDriver; sources?: SourceStore; say: (l: string) => void; cancelled: () => Promise<boolean> }) => Promise<Outcome>> = {
  async infrastructure(release, d) {
    release.outputs = await d.infra.apply(release, d.say);
    return { state: 'done', message: `Created ${d.driver.describe(release.outputs)}` };
  },

  async secrets(release, d) {
    if (release.secrets.length === 0) return { state: 'done', message: 'No secrets are needed' };
    const missing = await missingSecrets(release, d.driver);
    if (missing.length > 0) return { state: 'waiting', message: `Waiting for ${missing.join(', ')}` };
    return { state: 'done', message: 'All secrets are stored' };
  },

  async build(release, d) {
    const out = release.outputs!;
    const bundle = await bundleOf(release, d.sources);
    for (const layer of release.built) {
      if (await d.cancelled()) return { state: 'done', message: 'Cancelled' };       // the run notices it right after this step
      d.say(`Building ${layer}`);
      await d.driver.build(out, { project: release.project, layer, tag: release.imageTag, files: sourceFiles(bundle, layer), onLog: d.say });
    }
    return { state: 'done', message: `Built ${release.built.join(', ')}` };
  },

  async publish(release, d) {
    const out = release.outputs!;
    await d.driver.publish(out, { project: release.project, tag: release.imageTag, compose: release.compose, built: release.built });
    return { state: 'done', message: `Tag ${release.imageTag} and the compose file are on the VM` };
  },

  async start(release, d) {
    const out = release.outputs!;
    await d.driver.start(out, { project: release.project });
    return { state: 'done', message: 'Restarted' };
  },

  async verify(release, d) {
    const url = release.outputs!.url;
    const end = Date.now() + d.verifyWaitMs;
    for (;;) {
      if (await d.cancelled()) return { state: 'done', message: 'Cancelled' };
      if (await d.driver.httpOk(url)) return { state: 'done', message: `${url} answers` };
      if (Date.now() >= end) throw new ReleaseError(`${url} did not answer within ${Math.round(d.verifyWaitMs / 60000)} minutes.`, 504);
      await d.sleep(d.verifyEveryMs);
    }
  },
};

/** Puts the previous release back on the VM and checks it answers. Returns whether it worked. */
async function restorePrevious(current: Release, previous: Release, deps: OrchestratorDeps, say: (l: string) => void): Promise<boolean> {
  const out = current.outputs;
  if (!out || !previous.outputs) return false;
  try {
    say(`Putting ${previous.imageTag} back`);
    const driver = driverOf(deps);
    await driver.publish(out, { project: previous.project, tag: previous.imageTag, compose: previous.compose, built: previous.built });
    await driver.start(out, { project: previous.project });
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const end = Date.now() + (deps.verifyWaitMs ?? 10 * 60_000);
    for (;;) {
      if (await driverOf(deps).httpOk(out.url)) return true;
      if (Date.now() >= end) return false;
      await sleep(deps.verifyEveryMs ?? 10_000);
    }
  } catch { return false; }
}

const ROLLBACK_FROM: StepName[] = ['publish', 'start', 'verify'];

/**
 * Runs the release from its first unfinished step until it succeeds, fails or has to wait. Calling it again for a release that was waiting
 * (after the secrets were provided) or that failed (to retry) continues from where it stopped. It never throws for a step's failure: that is
 * recorded on the release.
 */
export async function runRelease(deps: OrchestratorDeps, releaseId: string): Promise<Release> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const release = await deps.store.get(releaseId);
  if (!release) throw new ReleaseError('Release not found.', 404);
  if (!['approved', 'running', 'waiting', 'failed'].includes(release.status)) throw new ReleaseError(`A ${release.status} release cannot be run.`, 409);
  const say = (line: string) => {
    const safe = clean(line);
    deps.log?.(releaseId, safe);
    release.log = [...(release.log ?? []), safe].slice(-LOG_LINES);
  };
  const save = async () => { release.updatedAt = now(); await deps.store.save(release); };

  release.status = 'running'; release.error = null;
  await save();

  for (const name of STEP_ORDER) {
    const rec = step(release, name);
    if (rec.state === 'done' || rec.state === 'skipped') continue;

    // Between steps: the operator's switch, and a cancel from the person.
    if (deps.killSwitch?.()) { rec.state = 'failed'; rec.message = 'Terraform execution was switched off by the server operator.'; release.status = 'failed'; release.error = rec.message; await save(); return release; }
    const fresh = await deps.store.get(releaseId);
    if (fresh?.status === 'cancelled') { release.status = 'cancelled'; await save(); return release; }

    rec.state = 'running'; rec.startedAt = now(); rec.finishedAt = undefined; rec.message = undefined;
    await save();
    say(`${name}: started`);
    try {
      const outcome = await STEP_RUNNERS[name](release, {
        driver: driverOf(deps), infra: deps.infra, sources: deps.sources, sleep, say, cancelled: async () => (await deps.store.get(releaseId))?.status === 'cancelled', verifyWaitMs: deps.verifyWaitMs ?? 10 * 60_000, verifyEveryMs: deps.verifyEveryMs ?? 10_000,
      });
      rec.message = outcome.message ? clean(outcome.message) : undefined;
      // A cancel that arrived while the step ran must not be overwritten by this record.
      if ((await deps.store.get(releaseId))?.status === 'cancelled') {
        rec.state = outcome.state === 'waiting' ? 'waiting' : 'done'; rec.finishedAt = now();
        release.status = 'cancelled';
        await save(); say('Cancelled');
        return release;
      }
      if (outcome.state === 'waiting') {
        rec.state = 'waiting'; release.status = 'waiting';
        await save(); say(`${name}: ${rec.message}`);
        return release;
      }
      rec.state = 'done'; rec.finishedAt = now();
      await save(); say(`${name}: done`);
    } catch (err) {
      const message = clean(err instanceof Error ? err.message : String(err));
      rec.state = 'failed'; rec.finishedAt = now(); rec.message = message; release.error = `${name}: ${message}`;
      say(`${name}: failed: ${message}`);
      const previous = release.previousReleaseId ? await deps.store.get(release.previousReleaseId) : null;
      if (ROLLBACK_FROM.includes(name) && previous && previous.status !== 'cancelled') {
        const back = await restorePrevious(release, previous, deps, say);
        release.status = back ? 'rolled_back' : 'failed';
        for (const later of release.steps.filter((s) => ROLLBACK_FROM.includes(s.name) && s.state === 'done')) later.state = 'rolled_back';
        if (back) rec.message = `${message} The previous release (${previous.imageTag}) was put back and answers.`;
        else rec.message = `${message} Putting the previous release back did not work: check the VM.`;
        release.error = `${name}: ${rec.message}`;
      } else {
        release.status = 'failed';
      }
      await save();
      return release;
    }
  }
  release.status = 'succeeded';
  await save();
  say('The release is running');
  return release;
}

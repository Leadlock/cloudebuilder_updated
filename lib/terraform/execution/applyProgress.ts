/**
 * Real progress for `terraform apply`.
 *
 * The apply runs in a separate worker process, so what it is doing has to travel to the web server. This module has three parts:
 *
 *  1. ApplyProgressTracker — reads Terraform's own output ("aws_db_instance.db: Still creating... [3m0s elapsed]",
 *     "aws_vpc.main: Creation complete after 2s") and keeps, per resource, whether it is queued, running, done or failed.
 *  2. A small file store (in the OS temp directory, which the web server and the worker share, like plan records and project locks)
 *     holding one progress record per run, and a heartbeat file the worker refreshes every few seconds.
 *  3. diagnoseApply — plain-language reasons a run looks stuck: the worker is not running, it died mid-run, or Terraform has gone silent.
 *
 * Nothing secret is stored: only resource addresses, states, timings and the last lines of Terraform's output, which never contains
 * credential values (they reach Terraform through its environment).
 */
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

// ─── Parsing ──────────────────────────────────────────────────────────────────

export type ResourceState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface ProgressResource {
  address: string;
  type: string;
  state: ResourceState;
  action?: 'create' | 'update' | 'delete' | 'read';
  /** Epoch ms when Terraform started working on it. */
  startedAt?: number;
  finishedAt?: number;
  /** How long Terraform itself says it took (completed resources), else the latest "still creating" figure. */
  seconds?: number;
  /** The cloud provider's id for it, as Terraform printed it ("[id=vpc-0abc]"): what you search for in the console to find or delete it. */
  id?: string;
}

export interface ProgressCounts { total: number; queued: number; running: number; done: number; failed: number; stopped: number }

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** "1h2m3s" / "9m12s" / "45s" → seconds. Unknown shapes give undefined. */
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Math.round(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

const VERB_ACTION: Record<string, ProgressResource['action']> = { Creating: 'create', Modifying: 'update', Destroying: 'delete', Reading: 'read', Replacing: 'create' };
const NOUN_ACTION: Record<string, ProgressResource['action']> = { Creation: 'create', Modifications: 'update', Destruction: 'delete', Read: 'read' };

export type ParsedLine =
  | { kind: 'start'; address: string; action: ProgressResource['action'] }
  | { kind: 'still'; address: string; action: ProgressResource['action']; seconds?: number }
  | { kind: 'complete'; address: string; action: ProgressResource['action']; seconds?: number; id?: string }
  | { kind: 'error-address'; address: string }
  | { kind: 'error-start' }
  | { kind: 'other' };

const looksLikeAddress = (s: string) => /^[A-Za-z0-9_.\-[\]"'/: ]+$/.test(s) && s.includes('.') && !s.includes(' ');

export function parseApplyLine(raw: string): ParsedLine {
  const line = raw.replace(ANSI, '').replace(/\r$/, '');
  const trimmed = line.replace(/^[│|\s]+/, '');

  if (/^Error: /.test(trimmed)) return { kind: 'error-start' };
  const withAddr = /^with ((?:data\.)?[^\s,]+),?$/.exec(trimmed);
  if (withAddr && line.trimStart().startsWith('│')) return { kind: 'error-address', address: withAddr[1]! };
  if (withAddr) return { kind: 'error-address', address: withAddr[1]! };

  const m = /^(\S+): (.+)$/.exec(line);
  if (!m || !looksLikeAddress(m[1]!)) return { kind: 'other' };
  const address = m[1]!;
  const rest = m[2]!;

  const start = /^(Creating|Modifying|Destroying|Reading|Replacing)\.\.\./.exec(rest);
  if (start) return { kind: 'start', address, action: VERB_ACTION[start[1]!] };

  const still = /^Still (creating|modifying|destroying|reading)\.\.\. \[([^\]]*?) elapsed\]/.exec(rest);
  if (still) {
    const verb = still[1]![0]!.toUpperCase() + still[1]!.slice(1);
    return { kind: 'still', address, action: VERB_ACTION[verb], seconds: parseDuration(still[2]!) };
  }

  const done = /^(Creation|Modifications|Destruction|Read) complete after (\S+)/.exec(rest);
  if (done) {
    const id = /\[id=([^\]]+)\]/.exec(rest)?.[1];
    return { kind: 'complete', address, action: NOUN_ACTION[done[1]!], seconds: parseDuration(done[2]!.replace(/\[.*$/, '')), ...(id ? { id: id.slice(0, 300) } : {}) };
  }

  return { kind: 'other' };
}

const MAX_LOG_LINES = 150;

export interface ProgressData {
  resources: ProgressResource[];
  counts: ProgressCounts;
  logTail: string[];
  /** Epoch ms of the last line of Terraform output. */
  lastOutputAt?: number;
}

/** Follows one apply: feed it Terraform's output as it arrives. */
export class ApplyProgressTracker {
  private readonly byAddress = new Map<string, ProgressResource>();
  private partial = '';
  private lines: string[] = [];
  private lastOutputAt?: number;
  private inError = false;

  constructor(planned: { address: string; type: string }[], private readonly now: () => number = Date.now) {
    for (const p of planned) this.byAddress.set(p.address, { address: p.address, type: p.type, state: 'queued' });
  }

  feed(chunk: string): void {
    const text = (this.partial + chunk).replace(/\r\n/g, '\n');
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.onLine(line);
  }

  /** Call when the run ends so a final line without a newline is not lost. */
  flush(): void {
    if (this.partial) { this.onLine(this.partial); this.partial = ''; }
  }

  private resource(address: string): ProgressResource {
    let r = this.byAddress.get(address);
    if (!r) { r = { address, type: address.replace(/^data\./, '').split('.')[0] ?? 'resource', state: 'queued' }; this.byAddress.set(address, r); }
    return r;
  }

  private onLine(raw: string): void {
    const clean = raw.replace(ANSI, '');
    if (clean.trim() === '') return;
    this.lastOutputAt = this.now();
    this.lines.push(clean.slice(0, 600));
    if (this.lines.length > MAX_LOG_LINES * 2) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);

    const p = parseApplyLine(clean);
    switch (p.kind) {
      case 'start': {
        const r = this.resource(p.address);
        r.state = 'running'; r.action = p.action; r.startedAt ??= this.now();
        break;
      }
      case 'still': {
        const r = this.resource(p.address);
        if (r.state !== 'done' && r.state !== 'failed') { r.state = 'running'; r.action ??= p.action; r.startedAt ??= this.now() - (p.seconds ?? 0) * 1000; }
        if (p.seconds !== undefined) r.seconds = p.seconds;
        break;
      }
      case 'complete': {
        const r = this.resource(p.address);
        r.state = 'done'; r.action ??= p.action; r.finishedAt = this.now(); if (p.seconds !== undefined) r.seconds = p.seconds; if (p.id) r.id = p.id;
        this.inError = false;
        break;
      }
      case 'error-start': this.inError = true; break;
      case 'error-address': {
        if (this.inError) { const r = this.resource(p.address); r.state = 'failed'; r.finishedAt = this.now(); }
        break;
      }
      default: break;
    }
  }

  /** Marks what is still unfinished when the run ended: everything on success (no-op rows), the unfinished on failure. */
  finish(succeeded: boolean): void {
    this.flush();
    for (const r of this.byAddress.values()) {
      if (succeeded) { if (r.state !== 'failed') r.state = 'done'; }
      else if (r.state === 'running' || r.state === 'queued') r.state = 'stopped';
    }
  }

  snapshot(): ProgressData {
    const resources = [...this.byAddress.values()].map((r) => ({ ...r }));
    const counts: ProgressCounts = { total: resources.length, queued: 0, running: 0, done: 0, failed: 0, stopped: 0 };
    for (const r of resources) counts[r.state] += 1;
    const tail = this.partial ? [...this.lines, this.partial] : this.lines;
    return { resources, counts, logTail: tail.slice(-MAX_LOG_LINES), ...(this.lastOutputAt !== undefined ? { lastOutputAt: this.lastOutputAt } : {}) };
  }
}

// ─── Stored record ────────────────────────────────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface RunProgressRecord extends ProgressData {
  runId: string;
  orgId: string;
  projectId: string;
  status: RunStatus;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
  message?: string;
  error?: string;
}

const runsDir = () => process.env['CLOUDCRAFT_RUNS_DIR'] || path.join(tmpdir(), 'cloudcraft-runs');
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, content, 'utf-8'); try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}

export function writeRunProgress(record: RunProgressRecord): void {
  try { atomicWrite(path.join(runsDir(), `run-${safeName(record.runId)}.json`), JSON.stringify(record)); }
  catch (err) { console.warn('[applyProgress] could not write progress:', err instanceof Error ? err.message : String(err)); }
}

/** The stored record, or null if there is none or it is unreadable (a half-written file is simply retried on the next poll). */
export function readRunProgress(runId: string): RunProgressRecord | null {
  try { return JSON.parse(fs.readFileSync(path.join(runsDir(), `run-${safeName(runId)}.json`), 'utf-8')) as RunProgressRecord; }
  catch { return null; }
}

/** Removes records older than a week (called when a new run is queued). */
export function pruneRunProgress(now = Date.now()): void {
  try {
    for (const f of fs.readdirSync(runsDir())) {
      if (!f.startsWith('run-')) continue;
      const file = path.join(runsDir(), f);
      if (now - fs.statSync(file).mtimeMs > KEEP_MS) fs.rmSync(file, { force: true });
    }
  } catch { /* nothing to prune */ }
}

/** A run that is waiting for a worker: every planned resource shown as queued. */
export function newQueuedRecord(meta: { runId: string; orgId: string; projectId: string }, planned: { address: string; type: string }[], now = Date.now()): RunProgressRecord {
  const tracker = new ApplyProgressTracker(planned);
  return { ...meta, status: 'queued', enqueuedAt: now, updatedAt: now, ...tracker.snapshot() };
}

// ─── Worker heartbeat ─────────────────────────────────────────────────────────

export const HEARTBEAT_EVERY_MS = 10_000;
const HEARTBEAT_ALIVE_MS = 45_000;

export function writeWorkerHeartbeat(name: string, now = Date.now()): void {
  try { atomicWrite(path.join(runsDir(), `worker-${safeName(name)}.json`), JSON.stringify({ at: now, pid: process.pid })); }
  catch { /* the heartbeat is advisory */ }
}

export function clearWorkerHeartbeat(name: string): void {
  try { fs.rmSync(path.join(runsDir(), `worker-${safeName(name)}.json`), { force: true }); } catch { /* nothing to clear */ }
}

export interface WorkerStatus { alive: boolean; lastSeenSecondsAgo: number | null }

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Whether a worker of this name is running on this host: it has reported recently and its process still exists. */
export function workerStatus(name: string, now = Date.now(), isPidAlive: (pid: number) => boolean = pidAlive): WorkerStatus {
  try {
    const beat = JSON.parse(fs.readFileSync(path.join(runsDir(), `worker-${safeName(name)}.json`), 'utf-8')) as { at: number; pid: number };
    const age = Math.max(0, now - beat.at);
    return { alive: age < HEARTBEAT_ALIVE_MS && isPidAlive(beat.pid), lastSeenSecondsAgo: Math.round(age / 1000) };
  } catch {
    return { alive: false, lastSeenSecondsAgo: null };
  }
}

export const APPLY_WORKER = 'terraform-apply';
export const APPLY_WORKER_COMMAND = 'npm run worker:terraform-apply';

// ─── Diagnosis ────────────────────────────────────────────────────────────────

export interface ApplyDiagnosis {
  kind: 'no-worker' | 'worker-stopped' | 'silent';
  title: string;
  message: string;
}

const SILENT_AFTER_MS = 180_000;
const QUEUE_GRACE_MS = 10_000;
const STALE_RECORD_MS = 60_000;

const minutes = (ms: number) => { const s = Math.round(ms / 1000); return s >= 120 ? `${Math.round(s / 60)} minutes` : `${s} seconds`; };

export function diagnoseApply(args: {
  jobState: 'pending' | 'active' | 'completed' | 'failed' | 'unknown';
  progress: RunProgressRecord | null;
  worker: WorkerStatus;
  now?: number;
}): ApplyDiagnosis | null {
  const { jobState, progress, worker } = args;
  const now = args.now ?? Date.now();

  if (jobState === 'pending') {
    const waited = progress ? now - progress.enqueuedAt : Infinity;
    if (!worker.alive && waited > QUEUE_GRACE_MS) {
      return {
        kind: 'no-worker',
        title: 'The deployment worker is not running',
        message: `Your apply is waiting in the queue, but nothing is there to run it${waited !== Infinity ? ` (queued ${minutes(waited)} ago)` : ''}. Terraform has not started and nothing has been created. Start the worker with "${APPLY_WORKER_COMMAND}" and it will pick the apply up. A plan expires 30 minutes after it was made, so if that time has passed the run will be refused and you will need to generate a new plan.`,
      };
    }
    return null;
  }

  if (jobState === 'active') {
    const lastSign = Math.max(progress?.updatedAt ?? 0, progress?.lastOutputAt ?? 0, progress?.startedAt ?? 0);
    if (!worker.alive && lastSign > 0 && now - lastSign > STALE_RECORD_MS) {
      return {
        kind: 'worker-stopped',
        title: 'The deployment worker stopped during the run',
        message: 'The process that was running Terraform is gone, so this deployment is no longer progressing. Some of the resources listed below may already have been created in AWS. Start the worker again, then generate a new plan: Terraform compares it with the saved state and only creates what is missing. If the project reports it is locked, use Unlock.',
      };
    }
    const silentFor = now - (progress?.lastOutputAt ?? progress?.startedAt ?? now);
    if (worker.alive && silentFor > SILENT_AFTER_MS) {
      return {
        kind: 'silent',
        title: 'Terraform has gone quiet',
        message: `Terraform has printed nothing for ${minutes(silentFor)}. While it creates a slow resource it normally reports "still creating" every 10 seconds, so this is unusual. It may be waiting on AWS (or the network). Check the AWS console for the resource that is in progress before taking any action.`,
      };
    }
  }
  return null;
}

/** For tests. */
export function _runsDirForTests(): string { return runsDir(); }

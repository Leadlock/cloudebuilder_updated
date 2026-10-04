/**
 * Real apply progress: parsing Terraform's own output, the shared record, the worker heartbeat, and the "why is it stuck" diagnosis.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockRunApply = jest.fn();
jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({ runApply: (...a: unknown[]) => mockRunApply(...a) }));
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: jest.fn() }));
jest.mock('@/lib/jobs/queue', () => ({ getQueue: jest.fn() }));
const mockGetPlan = jest.fn();
jest.mock('@/lib/terraform/execution/planStore', () => ({ getPlan: (...a: unknown[]) => mockGetPlan(...a) }));

import {
  ApplyProgressTracker, parseApplyLine, parseDuration, diagnoseApply, newQueuedRecord, readRunProgress, writeRunProgress,
  workerStatus, writeWorkerHeartbeat, clearWorkerHeartbeat, type RunProgressRecord, type WorkerStatus,
} from '@/lib/terraform/execution/applyProgress';
import { processApplyJob } from '@/lib/jobs/terraformApplyJob';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-runs-'));
  process.env['CLOUDCRAFT_RUNS_DIR'] = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env['CLOUDCRAFT_RUNS_DIR'];
  jest.clearAllMocks();
});

describe('parseDuration', () => {
  test.each([['2s', 2], ['45s', 45], ['1m0s', 60], ['9m12s', 552], ['1h2m3s', 3723], ['3m', 180]])('%s', (t, expected) => expect(parseDuration(t)).toBe(expected));
  test.each(['', 'soon', 'm', '1x'])('%j is not a duration', (t) => expect(parseDuration(t)).toBeUndefined());
});

describe('parseApplyLine', () => {
  test('start, still, complete', () => {
    expect(parseApplyLine('aws_vpc.main: Creating...')).toEqual({ kind: 'start', address: 'aws_vpc.main', action: 'create' });
    expect(parseApplyLine('aws_db_instance.db: Still creating... [3m0s elapsed]')).toMatchObject({ kind: 'still', address: 'aws_db_instance.db', seconds: 180 });
    expect(parseApplyLine('aws_vpc.main: Creation complete after 2s [id=vpc-0abc]')).toMatchObject({ kind: 'complete', address: 'aws_vpc.main', seconds: 2, action: 'create' });
  });
  test('modify, destroy, data sources and indexed addresses', () => {
    expect(parseApplyLine('aws_instance.web: Modifying... [id=i-1]')).toMatchObject({ kind: 'start', action: 'update' });
    expect(parseApplyLine('aws_instance.web: Modifications complete after 4s [id=i-1]')).toMatchObject({ kind: 'complete', action: 'update', seconds: 4 });
    expect(parseApplyLine('aws_x.y: Destruction complete after 1s')).toMatchObject({ kind: 'complete', action: 'delete' });
    expect(parseApplyLine('data.aws_vpc.default: Read complete after 0s [id=vpc-1]')).toMatchObject({ kind: 'complete', address: 'data.aws_vpc.default' });
    expect(parseApplyLine('aws_subnet.s["a b"]: Creating...').kind).toBe('other'); // spaces inside an index are not supported: ignored, never mis-attributed
    expect(parseApplyLine('aws_subnet.s["a"]: Creating...')).toMatchObject({ kind: 'start', address: 'aws_subnet.s["a"]' });
  });
  test('ordinary lines and ANSI colour codes', () => {
    expect(parseApplyLine('Apply complete! Resources: 3 added, 0 changed, 0 destroyed.').kind).toBe('other');
    expect(parseApplyLine('Note: Objects have changed outside of Terraform').kind).toBe('other');
    expect(parseApplyLine('\u001b[0m\u001b[1maws_vpc.main: Creating...\u001b[0m')).toMatchObject({ kind: 'start', address: 'aws_vpc.main' });
  });
  test('error blocks', () => {
    expect(parseApplyLine('│ Error: creating EC2 Subnet: InvalidSubnet.Range').kind).toBe('error-start');
    expect(parseApplyLine('│   with aws_subnet.a,')).toEqual({ kind: 'error-address', address: 'aws_subnet.a' });
  });
});

const PLANNED = [
  { address: 'aws_vpc.main', type: 'aws_vpc' }, { address: 'aws_subnet.a', type: 'aws_subnet' },
  { address: 'aws_db_instance.db', type: 'aws_db_instance' }, { address: 'aws_s3_bucket.logs', type: 'aws_s3_bucket' },
];
const OUTPUT = [
  'aws_vpc.main: Creating...', 'aws_s3_bucket.logs: Creating...', 'aws_s3_bucket.logs: Creation complete after 1s [id=logs]',
  'aws_vpc.main: Creation complete after 2s [id=vpc-1]', 'aws_subnet.a: Creating...', 'aws_subnet.a: Creation complete after 1s [id=s-1]',
  'aws_db_instance.db: Creating...', 'aws_db_instance.db: Still creating... [10s elapsed]', 'aws_db_instance.db: Still creating... [1m0s elapsed]',
].join('\n') + '\n';

describe('ApplyProgressTracker', () => {
  test('follows a run: done, running with its elapsed time, and queued', () => {
    const t = new ApplyProgressTracker(PLANNED);
    t.feed(OUTPUT);
    const s = t.snapshot();
    const by = Object.fromEntries(s.resources.map((r) => [r.address, r]));
    expect(by['aws_vpc.main']).toMatchObject({ state: 'done', seconds: 2 });
    expect(by['aws_db_instance.db']).toMatchObject({ state: 'running', seconds: 60 });
    expect(s.counts).toEqual({ total: 4, queued: 0, running: 1, done: 3, failed: 0, stopped: 0 });
    expect(s.logTail.at(-1)).toContain('Still creating');
  });

  test('output split anywhere (even mid-line) gives the same result', () => {
    const whole = new ApplyProgressTracker(PLANNED); whole.feed(OUTPUT);
    const split = new ApplyProgressTracker(PLANNED);
    for (let i = 0; i < OUTPUT.length; i += 7) split.feed(OUTPUT.slice(i, i + 7));
    const view = (t: ApplyProgressTracker) => t.snapshot().resources.map((r) => ({ address: r.address, state: r.state, seconds: r.seconds, action: r.action }));
    expect(view(split)).toEqual(view(whole));
  });

  test('resources not started yet stay queued', () => {
    const t = new ApplyProgressTracker(PLANNED);
    t.feed('aws_vpc.main: Creating...\n');
    expect(t.snapshot().counts).toMatchObject({ queued: 3, running: 1 });
  });

  test('a failure marks the named resource failed', () => {
    const t = new ApplyProgressTracker(PLANNED);
    t.feed('aws_subnet.a: Creating...\n╷\n│ Error: creating EC2 Subnet: InvalidSubnet.Range\n│ \n│   with aws_subnet.a,\n│   on main.tf line 40, in resource "aws_subnet" "a":\n╵\n');
    expect(t.snapshot().resources.find((r) => r.address === 'aws_subnet.a')!.state).toBe('failed');
  });

  test('"with <address>" outside an error block is ignored', () => {
    const t = new ApplyProgressTracker(PLANNED);
    t.feed('  with aws_subnet.a,\n');
    expect(t.snapshot().resources.find((r) => r.address === 'aws_subnet.a')!.state).toBe('queued');
  });

  test('finish(true) marks everything done; finish(false) leaves failures and marks the unfinished as stopped', () => {
    const ok = new ApplyProgressTracker(PLANNED); ok.feed('aws_vpc.main: Creating...\n'); ok.finish(true);
    expect(ok.snapshot().counts.done).toBe(4);

    const bad = new ApplyProgressTracker(PLANNED);
    bad.feed('aws_vpc.main: Creation complete after 1s\naws_subnet.a: Creating...\n│ Error: boom\n│   with aws_subnet.a,\naws_db_instance.db: Creating...\n');
    bad.finish(false);
    const c = bad.snapshot().counts;
    expect(c).toMatchObject({ done: 1, failed: 1, stopped: 2, running: 0, queued: 0 });
  });

  test('an address that was not in the plan is added rather than lost', () => {
    const t = new ApplyProgressTracker(PLANNED);
    t.feed('aws_sqs_queue.q: Creating...\n');
    expect(t.snapshot().resources.some((r) => r.address === 'aws_sqs_queue.q' && r.state === 'running')).toBe(true);
  });

  test('the log tail is bounded', () => {
    const t = new ApplyProgressTracker(PLANNED);
    t.feed(Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    expect(t.snapshot().logTail.length).toBeLessThanOrEqual(150);
    expect(t.snapshot().logTail.at(-1)).toBe('line 1999');
  });
});

describe('progress store', () => {
  const base = { runId: 'run-1', orgId: 'org-1', projectId: 'p-1' };

  test('round trip, and a missing or corrupt file reads as null', () => {
    expect(readRunProgress('run-1')).toBeNull();
    const rec = newQueuedRecord(base, PLANNED, 1000);
    writeRunProgress(rec);
    expect(readRunProgress('run-1')).toEqual(rec);
    fs.writeFileSync(path.join(dir, 'run-run-1.json'), '{ half a fi');
    expect(readRunProgress('run-1')).toBeNull();
  });

  test('a run id can never escape the directory', () => {
    writeRunProgress({ ...newQueuedRecord(base, PLANNED), runId: '../../evil' });
    expect(fs.readdirSync(dir).every((f) => !f.includes('..'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '..', '..', 'evil.json'))).toBe(false);
  });

  test('a queued record lists every planned resource as queued', () => {
    const rec = newQueuedRecord(base, PLANNED, 5);
    expect(rec.status).toBe('queued');
    expect(rec.counts).toMatchObject({ total: 4, queued: 4 });
  });
});

describe('worker heartbeat', () => {
  test('alive when fresh and its process exists; dead when stale, when its process is gone, or when there is none', () => {
    expect(workerStatus('w')).toEqual({ alive: false, lastSeenSecondsAgo: null });
    writeWorkerHeartbeat('w', 100_000);
    expect(workerStatus('w', 105_000, () => true)).toEqual({ alive: true, lastSeenSecondsAgo: 5 });
    expect(workerStatus('w', 200_000, () => true).alive).toBe(false);
    expect(workerStatus('w', 105_000, () => false).alive).toBe(false);
    clearWorkerHeartbeat('w');
    expect(workerStatus('w').lastSeenSecondsAgo).toBeNull();
  });
  test('the current process counts as alive', () => {
    writeWorkerHeartbeat('w2');
    expect(workerStatus('w2').alive).toBe(true);
  });
});

describe('diagnoseApply', () => {
  const alive: WorkerStatus = { alive: true, lastSeenSecondsAgo: 3 };
  const dead: WorkerStatus = { alive: false, lastSeenSecondsAgo: null };
  const rec = (o: Partial<RunProgressRecord> = {}): RunProgressRecord => ({ ...newQueuedRecord({ runId: 'r', orgId: 'o', projectId: 'p' }, PLANNED, 0), ...o });

  test('queued with no worker: says so, and how to start it', () => {
    const d = diagnoseApply({ jobState: 'pending', progress: rec(), worker: dead, now: 120_000 });
    expect(d!.kind).toBe('no-worker');
    expect(d!.message).toContain('npm run worker:terraform-apply');
    expect(d!.message).toMatch(/nothing has been created/);
    expect(d!.message).toMatch(/30 minutes/);
  });
  test('no record at all (a run from before this existed) still reports a missing worker', () => {
    expect(diagnoseApply({ jobState: 'pending', progress: null, worker: dead })!.kind).toBe('no-worker');
  });
  test('just queued: give the worker a moment', () => {
    expect(diagnoseApply({ jobState: 'pending', progress: rec(), worker: dead, now: 5_000 })).toBeNull();
  });
  test('queued with a live worker is fine', () => {
    expect(diagnoseApply({ jobState: 'pending', progress: rec(), worker: alive, now: 600_000 })).toBeNull();
  });
  test('running but the worker is gone and has been silent: worker stopped, resources may exist', () => {
    const d = diagnoseApply({ jobState: 'active', progress: rec({ status: 'running', startedAt: 0, updatedAt: 1000, lastOutputAt: 1000 }), worker: dead, now: 200_000 });
    expect(d!.kind).toBe('worker-stopped');
    expect(d!.message).toMatch(/may already have been created/);
  });
  test('running, worker alive, Terraform silent for minutes', () => {
    const d = diagnoseApply({ jobState: 'active', progress: rec({ status: 'running', startedAt: 0, updatedAt: 0, lastOutputAt: 0 }), worker: alive, now: 5 * 60_000 });
    expect(d!.kind).toBe('silent');
  });
  test('running normally, finished and failed runs have no diagnosis', () => {
    expect(diagnoseApply({ jobState: 'active', progress: rec({ status: 'running', startedAt: 0, updatedAt: 100_000, lastOutputAt: 100_000 }), worker: alive, now: 110_000 })).toBeNull();
    expect(diagnoseApply({ jobState: 'completed', progress: rec(), worker: dead, now: 9e9 })).toBeNull();
    expect(diagnoseApply({ jobState: 'failed', progress: rec(), worker: dead, now: 9e9 })).toBeNull();
  });
});

describe('processApplyJob reports real progress', () => {
  const data = { applyRunId: 'run-9', projectId: 'p-1', requestedBy: 'u', planId: 'plan-1', accountId: 'a', orgId: 'org-1' };
  beforeEach(() => {
    mockGetPlan.mockReturnValue({ summary: { resourceChanges: PLANNED.map((p) => ({ ...p, actions: ['create'] })) } });
  });

  test('success: output becomes per-resource states and the final record is succeeded', async () => {
    mockRunApply.mockImplementation(async (_p: string, _o: string, onOutput: (c: string) => void) => {
      onOutput(OUTPUT);
      expect(readRunProgress('run-9')!.status).toBe('running');     // already visible while Terraform runs
      return { message: 'Applied 4 new and 0 changed resource(s).', outputTail: '' };
    });
    const out = await processApplyJob(data);
    expect(out.status).toBe('success');
    const rec = readRunProgress('run-9')!;
    expect(rec.status).toBe('succeeded');
    expect(rec.counts).toMatchObject({ total: 4, done: 4 });
    expect(rec.message).toMatch(/Applied 4/);
  });

  test('failure: the record says failed, the resource in progress did not finish, and nothing throws', async () => {
    mockRunApply.mockImplementation(async (_p: string, _o: string, onOutput: (c: string) => void) => {
      onOutput('aws_vpc.main: Creation complete after 2s\naws_subnet.a: Creating...\n│ Error: InvalidSubnet.Range\n│   with aws_subnet.a,\n');
      throw new Error('terraform apply failed (exit 1): boom');
    });
    const out = await processApplyJob(data);
    expect(out.status).toBe('failed');
    const rec = readRunProgress('run-9')!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatch(/boom/);
    expect(rec.counts).toMatchObject({ done: 1, failed: 1, stopped: 2 });
  });
});

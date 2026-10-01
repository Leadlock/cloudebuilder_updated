/**
 * Background Terraform runs (currently: teardown) and their live output.
 *
 * A teardown can take many minutes, so it runs detached from the HTTP request: the request returns a run id at once and
 * the page polls this registry for the last lines of Terraform's output and the final result. The page can be closed and
 * reopened without affecting the run.
 *
 * Held in this server process (the same tier as plan records): fine for one server, lost on a restart, and not shared
 * between instances. Output is kept as a bounded tail so a long run cannot use unbounded memory.
 */
export type RunState = 'running' | 'succeeded' | 'failed';

export interface RunSnapshot {
  runId: string;
  state: RunState;
  startedAt: string;
  elapsedSeconds: number;
  /** The last lines of Terraform's output. */
  logTail: string[];
  message?: string;
  error?: string;
}

interface RunRecord {
  runId: string; orgId: string; projectId: string; kind: 'destroy';
  startedAtMs: number; finishedAtMs?: number;
  state: RunState; lines: string[]; partial: string; message?: string; error?: string;
}

const MAX_LINES = 1000;
const TAIL_LINES = 150;
const KEEP_FINISHED_MS = 60 * 60 * 1000;

const g = globalThis as unknown as { __cloudcraft_tf_runs__?: Map<string, RunRecord> };
const runs = (): Map<string, RunRecord> => (g.__cloudcraft_tf_runs__ ??= new Map());

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function prune(now: number): void {
  for (const [id, r] of runs()) if (r.finishedAtMs !== undefined && now - r.finishedAtMs > KEEP_FINISHED_MS) runs().delete(id);
}

export interface RunHandle {
  runId: string;
  /** Adds output (any chunk size); lines are split and kept as a bounded tail. */
  append(chunk: string): void;
  finish(ok: boolean, text: string): void;
}

export function startRun(meta: { runId: string; orgId: string; projectId: string; kind: 'destroy' }): RunHandle {
  prune(Date.now());
  const rec: RunRecord = { ...meta, startedAtMs: Date.now(), state: 'running', lines: [], partial: '' };
  runs().set(meta.runId, rec);
  return {
    runId: meta.runId,
    append(chunk: string) {
      const text = (rec.partial + chunk.replace(ANSI, '')).replace(/\r\n/g, '\n');
      const parts = text.split('\n');
      rec.partial = parts.pop() ?? '';
      for (const line of parts) rec.lines.push(line.slice(0, 600));
      if (rec.lines.length > MAX_LINES) rec.lines.splice(0, rec.lines.length - MAX_LINES);
    },
    finish(ok: boolean, text: string) {
      if (rec.partial) { rec.lines.push(rec.partial); rec.partial = ''; }
      rec.state = ok ? 'succeeded' : 'failed';
      rec.finishedAtMs = Date.now();
      if (ok) rec.message = text; else rec.error = text;
    },
  };
}

/** Snapshot of a run, or null if it is unknown or belongs to another organisation. */
export function getRunSnapshot(runId: string, orgId: string): RunSnapshot | null {
  const r = runs().get(runId);
  if (!r || r.orgId !== orgId) return null;
  const end = r.finishedAtMs ?? Date.now();
  const live = r.partial ? [...r.lines, r.partial] : r.lines;
  return {
    runId: r.runId, state: r.state, startedAt: new Date(r.startedAtMs).toISOString(), elapsedSeconds: Math.max(0, Math.round((end - r.startedAtMs) / 1000)),
    logTail: live.slice(-TAIL_LINES), ...(r.message ? { message: r.message } : {}), ...(r.error ? { error: r.error } : {}),
  };
}

/** For tests. */
export function _clearRunsForTests(): void { runs().clear(); }

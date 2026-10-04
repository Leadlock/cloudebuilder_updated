'use client';
import { useState } from 'react';
import { Copy, Check, PackageCheck } from 'lucide-react';
import type { RunProgressRecord, ProgressResource } from '@/lib/terraform/execution/applyProgress';

/** Resources a run created for sure: Terraform said "Creation complete" (and gave the cloud provider's id). Data sources are reads, not creations. */
export function createdResources(progress: RunProgressRecord | null): ProgressResource[] {
  return (progress?.resources ?? []).filter((r) => r.state === 'done' && r.action === 'create' && !r.address.startsWith('data.'));
}

/** Resources that were being created when the run failed or stopped: they may exist, partly or fully, and should be checked. */
export function maybeCreatedResources(progress: RunProgressRecord | null): ProgressResource[] {
  return (progress?.resources ?? []).filter((r) => (r.state === 'failed' || r.state === 'stopped') && r.startedAt !== undefined && !r.denied && !r.address.startsWith('data.'));
}

export function createdListText(progress: RunProgressRecord): string {
  const line = (r: ProgressResource) => `${r.address}${r.id ? `  ${r.id}` : ''}`;
  const sure = createdResources(progress).map(line);
  const maybe = maybeCreatedResources(progress).map((r) => `${line(r)}  (was being created: check whether it exists)`);
  return [`Created by CloudCraft (run ${progress.runId}):`, ...sure, ...(maybe.length ? ['', 'May exist:', ...maybe] : [])].join('\n');
}

/**
 * "What did this deployment create?" — every resource Terraform finished creating, with the provider's id so it can be found in the
 * cloud console, plus those that were in progress when a run failed. Built from Terraform's own output, not from the plan.
 */
export default function CreatedResourcesList({ progress, cloud }: { progress: RunProgressRecord | null; cloud: string }) {
  const [copied, setCopied] = useState(false);
  const created = createdResources(progress);
  const maybe = maybeCreatedResources(progress);
  if (!progress || (created.length === 0 && maybe.length === 0)) return null;
  const finished = progress.status === 'succeeded' || progress.status === 'failed';

  async function copy() {
    try { await navigator.clipboard.writeText(createdListText(progress!)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the list is selectable */ }
  }

  return (
    <details open={finished} className="mb-3 rounded-xl border border-gray-800 bg-gray-950 p-3 text-xs" data-testid="created-resources">
      <summary className="cursor-pointer flex items-center gap-2 text-gray-200 font-semibold">
        <PackageCheck className="w-4 h-4 text-emerald-400" />
        {created.length} resource{created.length === 1 ? '' : 's'} created in {cloud}{maybe.length > 0 ? ` · ${maybe.length} may exist` : ''}
        {!finished && <span className="text-gray-500 font-normal">(so far)</span>}
      </summary>
      <div className="mt-2 space-y-2">
        <ul className="space-y-1">
          {created.map((r) => (
            <li key={r.address} className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[11px] text-emerald-200 break-all">{r.address}</span>
              <span className="font-mono text-[10px] text-gray-400 break-all text-right select-all">{r.id ?? ''}</span>
            </li>
          ))}
        </ul>
        {maybe.length > 0 && (
          <div>
            <p className="text-amber-300 font-medium mt-1">Was being created when the run stopped (check whether these exist):</p>
            <ul className="mt-1 space-y-1">
              {maybe.map((r) => <li key={r.address} className="font-mono text-[11px] text-amber-200 break-all">{r.address}</li>)}
            </ul>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-gray-500 leading-relaxed">
            To remove everything this project created, use <strong className="text-gray-300">Teardown</strong>: it deletes exactly what Terraform recorded, in the right order. Deleting by hand also works; search the console for the ids above.
          </p>
          <button type="button" onClick={copy} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300">
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied' : 'Copy list'}
          </button>
        </div>
      </div>
    </details>
  );
}

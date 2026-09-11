'use client';
import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import clsx from 'clsx';
import { ShieldAlert, ShieldCheck } from 'lucide-react';

export interface CloudProviderBoundaryData {
  label: string;
  provider: 'aws' | 'azure';
  region?: string;
  resourceCount?: number;
  width?: number;
  height?: number;
  overallScore?: number;
  criticalFindingsCount?: number;
  showFindings?: boolean;
  importState?: 'imported' | 'cloudcraft-managed' | 'new' | 'modified' | 'planned';
}

export const CloudProviderBoundary = memo(({ data, selected }: NodeProps<CloudProviderBoundaryData>) => {
  const isAws = data.provider === 'aws';
  const width = data.width || 880;
  const height = data.height || 560;

  return (
    <div
      role="region"
      aria-label={`${data.label} Cloud Boundary`}
      style={{ width, height }}
      className={clsx(
        'relative rounded-3xl transition-all select-none pointer-events-auto',
        isAws
          ? 'bg-amber-950/10 border-2 border-amber-500/30 shadow-2xl backdrop-blur-[1px]'
          : 'bg-sky-950/10 border-2 border-sky-500/30 shadow-2xl backdrop-blur-[1px]',
        selected && (isAws ? 'ring-2 ring-amber-400 border-amber-400' : 'ring-2 ring-sky-400 border-sky-400')
      )}
    >
      {/* Cloud Boundary Header */}
      <div
        className={clsx(
          'flex items-center justify-between px-5 py-3 rounded-t-3xl border-b backdrop-blur-md',
          isAws
            ? 'bg-gradient-to-r from-amber-950/60 via-amber-900/30 to-transparent border-amber-500/30'
            : 'bg-gradient-to-r from-sky-950/60 via-sky-900/30 to-transparent border-sky-500/30'
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={clsx(
              'w-8 h-8 rounded-xl flex items-center justify-center font-black text-xs shadow-inner',
              isAws
                ? 'bg-amber-500 text-slate-950 shadow-amber-300/40'
                : 'bg-sky-500 text-white shadow-sky-300/40'
            )}
          >
            {isAws ? 'AWS' : 'AZ'}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-white font-bold text-sm tracking-tight">
                {data.label || (isAws ? 'Amazon Web Services' : 'Microsoft Azure')}
              </span>
              <span
                className={clsx(
                  'text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider',
                  isAws ? 'text-amber-300 bg-amber-500/20 border border-amber-500/30' : 'text-sky-300 bg-sky-500/20 border border-sky-500/30'
                )}
              >
                Cloud Boundary
              </span>
              {data.importState === 'imported' && (
                <span className="inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 uppercase tracking-wider">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  Imported
                </span>
              )}
            </div>
            {data.region && (
              <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                Primary Region: <span className="text-slate-200">{data.region}</span>
              </p>
            )}
          </div>
        </div>

        {/* Right Header Badges */}
        <div className="flex items-center gap-2.5">
          {data.showFindings && typeof data.overallScore === 'number' && (
            <div
              className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold',
                (data.criticalFindingsCount ?? 0) > 0
                  ? 'bg-rose-950/60 border-rose-500/40 text-rose-300'
                  : 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
              )}
            >
              {(data.criticalFindingsCount ?? 0) > 0 ? (
                <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              )}
              <span>WA Score: {data.overallScore}%</span>
            </div>
          )}
          {typeof data.resourceCount === 'number' && (
            <span className="text-xs px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-700/60 text-slate-300 font-mono">
              {data.resourceCount} {data.resourceCount === 1 ? 'Resource' : 'Resources'}
            </span>
          )}
        </div>
      </div>

      {/* Cross-cloud interconnect handles */}
      <Handle
        type="target"
        position={Position.Left}
        id="cross-left"
        className="!w-3 !h-3 !bg-amber-400 !border-2 !border-slate-900"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="cross-right"
        className="!w-3 !h-3 !bg-sky-400 !border-2 !border-slate-900"
      />
      <Handle
        type="target"
        position={Position.Top}
        id="cross-top"
        className="!w-3 !h-3 !bg-amber-400 !border-2 !border-slate-900"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="cross-bottom"
        className="!w-3 !h-3 !bg-sky-400 !border-2 !border-slate-900"
      />
    </div>
  );
});

CloudProviderBoundary.displayName = 'CloudProviderBoundary';
export default CloudProviderBoundary;

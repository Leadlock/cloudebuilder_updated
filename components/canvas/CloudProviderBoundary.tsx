'use client';
import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import clsx from 'clsx';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useApp } from '@/context/AppContext';

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
  const { state } = useApp();
  const isLight = state.theme === 'light';

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
          ? isLight
            ? 'bg-amber-50/40 border-2 border-amber-300 shadow-xl backdrop-blur-[1px]'
            : 'bg-amber-950/10 border-2 border-amber-500/30 shadow-2xl backdrop-blur-[1px]'
          : isLight
            ? 'bg-sky-50/40 border-2 border-sky-300 shadow-xl backdrop-blur-[1px]'
            : 'bg-sky-950/10 border-2 border-sky-500/30 shadow-2xl backdrop-blur-[1px]',
        selected && (isAws ? 'ring-2 ring-amber-400 border-amber-400' : 'ring-2 ring-sky-400 border-sky-400')
      )}
    >
      {/* Cloud Boundary Header */}
      <div
        className={clsx(
          'flex items-center justify-between px-5 py-3 rounded-t-3xl border-b backdrop-blur-md',
          isAws
            ? isLight
              ? 'bg-amber-100/90 border-amber-300/80'
              : 'bg-gradient-to-r from-amber-950/60 via-amber-900/30 to-transparent border-amber-500/30'
            : isLight
              ? 'bg-sky-100/90 border-sky-300/80'
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
              <span className={`font-bold text-sm tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                {data.label || (isAws ? 'Amazon Web Services' : 'Microsoft Azure')}
              </span>
              <span
                className={clsx(
                  'text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider',
                  isAws
                    ? isLight ? 'text-amber-900 bg-amber-200/90 border border-amber-400/80 shadow-sm' : 'text-amber-300 bg-amber-500/20 border border-amber-500/30'
                    : isLight ? 'text-sky-900 bg-sky-200/90 border border-sky-400/80 shadow-sm' : 'text-sky-300 bg-sky-500/20 border border-sky-500/30'
                )}
              >
                Cloud Boundary
              </span>
              {data.importState === 'imported' && (
                <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full ${
                  isLight ? 'bg-cyan-100 text-cyan-950 border border-cyan-300 shadow-sm' : 'bg-cyan-950/80 text-cyan-300 border border-cyan-500/40'
                } uppercase tracking-wider`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
                  Imported
                </span>
              )}
            </div>
            {data.region && (
              <p className={`text-[11px] font-mono mt-0.5 ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
                Primary Region: <span className={isLight ? 'text-slate-900 font-bold' : 'text-slate-200'}>{data.region}</span>
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
                  ? isLight ? 'bg-rose-50 border-rose-300 text-rose-900 shadow-sm' : 'bg-rose-950/60 border-rose-500/40 text-rose-300'
                  : isLight ? 'bg-emerald-50 border-emerald-300 text-emerald-900 shadow-sm' : 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
              )}
            >
              {(data.criticalFindingsCount ?? 0) > 0 ? (
                <ShieldAlert className="w-3.5 h-3.5 text-rose-500" />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              )}
              <span>WA Score: {data.overallScore}%</span>
            </div>
          )}
          {typeof data.resourceCount === 'number' && (
            <span className={`text-xs px-2.5 py-1 rounded-lg border font-mono ${
              isLight ? 'bg-white border-slate-300 text-slate-800 font-medium shadow-sm' : 'bg-slate-900/80 border-slate-700/60 text-slate-300'
            }`}>
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
        className={clsx('!w-2.5 !h-2.5 !bg-amber-400 !border-2 opacity-0 hover:!opacity-100 group-hover:opacity-40 transition-all', isLight ? '!border-white' : '!border-slate-900')}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="cross-right"
        className={clsx('!w-2.5 !h-2.5 !bg-sky-400 !border-2 opacity-0 hover:!opacity-100 group-hover:opacity-40 transition-all', isLight ? '!border-white' : '!border-slate-900')}
      />
      <Handle
        type="target"
        position={Position.Top}
        id="cross-top"
        className={clsx('!w-2.5 !h-2.5 !bg-amber-400 !border-2 opacity-0 hover:!opacity-100 group-hover:opacity-40 transition-all', isLight ? '!border-white' : '!border-slate-900')}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="cross-bottom"
        className={clsx('!w-2.5 !h-2.5 !bg-sky-400 !border-2 opacity-0 hover:!opacity-100 group-hover:opacity-40 transition-all', isLight ? '!border-white' : '!border-slate-900')}
      />
    </div>
  );
});

CloudProviderBoundary.displayName = 'CloudProviderBoundary';
export default CloudProviderBoundary;

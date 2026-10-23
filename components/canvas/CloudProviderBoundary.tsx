'use client';
import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import clsx from 'clsx';
import { MapPin, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { AwsIcon, AzureIcon } from '@/components/icons/cloud/CloudServiceIcon';

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
  importState?: 'imported' | 'cloudbuilder-managed' | 'new' | 'modified' | 'planned';
}

function formatRegionName(region?: string): string {
  if (!region) return 'EU (Frankfurt)';
  const lower = region.toLowerCase();
  const map: Record<string, string> = {
    'eu-central-1': 'EU (Frankfurt)',
    'eu-west-1': 'EU (Ireland)',
    'eu-west-2': 'EU (London)',
    'eu-west-3': 'EU (Paris)',
    'us-east-1': 'US East (N. Virginia)',
    'us-east-2': 'US East (Ohio)',
    'us-west-1': 'US West (N. California)',
    'us-west-2': 'US West (Oregon)',
    'ap-southeast-1': 'Asia Pacific (Singapore)',
    'ap-south-1': 'Asia Pacific (Mumbai)',
    'ap-northeast-1': 'Asia Pacific (Tokyo)',
    'frankfurt': 'EU (Frankfurt)',
    'global': 'Global Region',
  };
  return map[lower] || region;
}

export const CloudProviderBoundary = memo(({ data, selected }: NodeProps<CloudProviderBoundaryData>) => {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  const isAws = data.provider === 'aws';
  const width = data.width || 880;
  const height = data.height || 560;

  const displayRegion = formatRegionName(data.region);
  const titleText = data.label && !data.label.startsWith('Amazon Web Services')
    ? data.label
    : 'REST API for AWS Document DB';

  return (
    <div
      role="region"
      aria-label={`${data.label} Cloud Boundary`}
      style={{ width, height }}
      className={clsx(
        'relative rounded-3xl transition-all select-none pointer-events-auto',
        isLight
          ? 'bg-transparent border-2 border-dashed border-slate-700/80 shadow-sm'
          : 'bg-transparent border-2 border-dashed border-slate-600/80 shadow-2xl',
        selected && 'ring-2 ring-[#0078d4] border-[#0078d4]'
      )}
    >
      {/* Microsoft Fluent Title Pill Floating on Top Edge */}
      <div className="absolute -top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
        <div
          className={clsx(
            "flex items-center gap-2 px-4 py-1.5 rounded-lg border text-xs font-semibold shadow-md select-none tracking-tight",
            isAws
              ? "bg-[#232F3E] border-[#FF9900]/40 text-white"
              : "border-[#0078d4] bg-[#0078d4] text-white"
          )}
        >
          {isAws ? <AwsIcon size={16} /> : <AzureIcon size={16} />}
          <span>{titleText}</span>
        </div>
      </div>

      {/* Top-Left Location Pin Badge */}
      <div className="absolute top-4 left-5 flex items-center gap-2 z-10 pointer-events-none">
        <div className={clsx(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-md border shadow-xs",
          isLight ? "bg-white border-slate-200" : "bg-[#1c1c1e] border-white/10"
        )}>
          <MapPin className="w-3.5 h-3.5 text-[#0078d4]" />
          <span className={clsx('text-xs font-medium tracking-tight', isLight ? 'text-slate-800' : 'text-slate-200')}>
            {displayRegion}
          </span>
        </div>
      </div>

      {/* Top-Right Metrics / Badges */}
      <div className="absolute top-4 right-5 flex items-center gap-2 z-10">
        {data.importState === 'imported' && (
          <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full ${
            isLight ? 'bg-cyan-100 text-cyan-950 border border-cyan-300 shadow-sm' : 'bg-cyan-950/80 text-cyan-300 border border-cyan-500/40'
          } uppercase tracking-wider`}>
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
            Imported
          </span>
        )}

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

        {typeof data.resourceCount === 'number' && data.resourceCount > 0 && (
          <span className={`text-xs px-2.5 py-1 rounded-lg border font-mono ${
            isLight ? 'bg-white/90 border-slate-300 text-slate-800 font-medium shadow-sm' : 'bg-slate-900/80 border-slate-700/60 text-slate-300'
          }`}>
            {data.resourceCount} {data.resourceCount === 1 ? 'Resource' : 'Resources'}
          </span>
        )}
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

'use client';
import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { useApp } from '@/context/AppContext';
import clsx from 'clsx';

export interface ContainerNodeData {
  label: string;
  resourceType: string;
  provider?: 'aws' | 'azure';
  config?: Record<string, unknown>;
  width?: number;
  height?: number;
  isDragTarget?: boolean;
  isValidDrop?: boolean;
  childCount?: number;
  importState?: 'imported' | 'cloudcraft-managed' | 'new' | 'modified' | 'planned';
  findingsSummary?: { critical: number; high: number; medium: number; total: number };
  showFindings?: boolean;
}

const ContainerNode = memo(({ data, selected }: NodeProps<ContainerNodeData>) => {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  const isVpc = data.resourceType === 'aws_vpc' || data.resourceType === 'azure_vnet' || data.resourceType === 'azure_resource_group';
  const isSubnet = data.resourceType === 'aws_subnet' || data.resourceType === 'azure_subnet';
  const provider = data.provider ?? (data.resourceType.startsWith('azure_') ? 'azure' : 'aws');
  const isImported = data.importState === 'imported' || data.config?.imported === true || data.config?.importState === 'imported';
  
  const rawStatus = (data.config?.status as string) || (data.config?.cloudStatus as string) || (data.config?.state as string) || '';
  const normalizedStatus = rawStatus ? String(rawStatus).toLowerCase().trim() : '';
  const isDeleted = normalizedStatus === 'deleted' || normalizedStatus === 'terminated';

  const cidr = (data.config?.cidrBlock as string) || (data.config?.addressPrefix as string) || (data.config?.addressSpace as string) || '';
  const az = (data.config?.availabilityZone as string) || '';
  const isPublic = data.config?.mapPublicIpOnLaunch === true || (data.label || '').toLowerCase().includes('public');

  const width = data.width || (isVpc ? 760 : 340);
  const height = data.height || (isVpc ? 480 : 220);

  return (
    <div
      role="region"
      aria-label={`${data.label} (${data.resourceType})`}
      style={{ width, height }}
      className={clsx(
        'group relative rounded-2xl transition-all select-none',
        isVpc
          ? isLight
            ? 'bg-indigo-50/20 border-2 border-indigo-200/90 shadow-md backdrop-blur-[2px]'
            : 'bg-purple-950/15 border-2 border-purple-500/40 shadow-2xl backdrop-blur-[2px]'
          : isLight
            ? 'bg-emerald-50/25 border-2 border-dashed border-emerald-300 shadow-sm'
            : 'bg-emerald-950/10 border-2 border-dashed border-emerald-500/50 shadow-md',
        isDeleted && (isLight ? '!opacity-50 !border-slate-300 bg-slate-100 grayscale' : '!opacity-50 !border-slate-700 bg-slate-950/80 grayscale'),
        isImported && !isDeleted && (isLight ? '!border-cyan-400' : '!border-cyan-500/40'),
        selected && 'ring-2 ring-blue-400 border-blue-400 shadow-blue-500/20',
        data.isDragTarget && (data.isValidDrop !== false
          ? '!border-cyan-400 !ring-4 !ring-cyan-400/30 !bg-cyan-950/25'
          : '!border-rose-500 !ring-4 !ring-rose-500/30 !bg-rose-950/25')
      )}
    >
      {/* Container Header */}
      <div
        className={clsx(
          'flex items-center justify-between px-3.5 py-2 rounded-t-xl border-b',
          isVpc
            ? isLight ? 'bg-indigo-100/70 border-indigo-200' : 'bg-purple-900/30 border-purple-500/30'
            : isLight ? 'bg-emerald-100/70 border-emerald-200' : 'bg-emerald-900/25 border-emerald-500/25'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={`shrink-0 p-1 rounded-lg ${isLight ? 'bg-white border border-slate-200 shadow-sm' : 'bg-black/40 border border-white/10 shadow-sm'}`}>
            <CloudServiceIcon
              provider={provider}
              resourceType={data.resourceType}
              size={isVpc ? 22 : 18}
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`${isLight ? 'text-slate-900' : 'text-white'} font-bold text-xs tracking-tight truncate max-w-[180px]`}>
                {data.label}
              </span>
              <span
                className={clsx(
                  'text-[10px] font-semibold px-2 py-0.5 rounded uppercase tracking-wider',
                  isVpc
                    ? isLight ? 'text-indigo-900 bg-indigo-100/90 border border-indigo-300' : 'text-purple-300 bg-purple-500/20'
                    : isLight ? 'text-emerald-900 bg-emerald-100/90 border border-emerald-300' : 'text-emerald-300 bg-emerald-500/20'
                )}
              >
                {isVpc ? (provider === 'azure' ? 'Virtual Network' : 'VPC') : (isPublic ? 'Public Subnet' : 'Private Subnet')}
              </span>
              {isImported && (
                <span
                  className={`inline-flex items-center gap-1 text-[8px] font-bold px-1.5 py-0.5 rounded ${
                    isLight ? 'bg-cyan-50 text-cyan-900 border border-cyan-300 shadow-sm' : 'bg-cyan-950/80 text-cyan-300 border border-cyan-500/40'
                  } uppercase tracking-wider shrink-0`}
                  title="Imported Live Container"
                >
                  <span className="w-1 h-1 rounded-full bg-cyan-500 animate-pulse" />
                  Imported
                </span>
              )}
              {isDeleted && (
                <span className={`inline-flex items-center gap-1 text-[8px] font-bold px-1.5 py-0.5 rounded ${
                  isLight ? 'bg-slate-100 text-slate-700 border border-slate-300' : 'bg-slate-800 text-slate-300 border border-slate-600'
                } uppercase tracking-wider shrink-0`}>
                  Deleted
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Badges / Metrics */}
        <div className="flex items-center gap-1.5 shrink-0">
          {cidr && (
            <span className={`font-mono text-[10px] px-2 py-0.5 rounded ${isLight ? 'bg-white/95 text-slate-800 border border-slate-300 shadow-sm font-semibold' : 'bg-black/50 text-gray-300 border border-white/10'}`}>
              {cidr}
            </span>
          )}
          {az && (
            <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded ${isLight ? 'bg-white/95 text-slate-700 border border-slate-300 shadow-sm font-medium' : 'bg-black/40 text-gray-400'}`}>
              {az}
            </span>
          )}
          {typeof data.childCount === 'number' && data.childCount > 0 && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${isLight ? 'bg-blue-50 text-blue-800 border border-blue-200 shadow-sm' : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'} font-medium`}>
              {data.childCount} {data.childCount === 1 ? 'resource' : 'resources'}
            </span>
          )}
          {data.showFindings && data.findingsSummary && data.findingsSummary.total > 0 && (
            <span
              className={clsx(
                'text-[9px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1',
                (data.findingsSummary.critical > 0 || data.findingsSummary.high > 0)
                  ? isLight ? 'bg-rose-50 text-rose-800 border-rose-300 shadow-sm' : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                  : isLight ? 'bg-amber-50 text-amber-900 border-amber-300 shadow-sm' : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
              )}
              title={`${data.findingsSummary.total} WAF findings`}
            >
              <span className={clsx('w-1.5 h-1.5 rounded-full', (data.findingsSummary.critical > 0 || data.findingsSummary.high > 0) ? 'bg-rose-500' : 'bg-amber-500')} />
              {data.findingsSummary.total} WAF
            </span>
          )}
        </div>
      </div>

      {/* Drop Target Helper Notification */}
      {data.isDragTarget && (
        <div className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
          <div className={clsx(
            'px-3 py-1 rounded-full text-xs font-semibold shadow-lg backdrop-blur-md flex items-center gap-1.5',
            data.isValidDrop !== false
              ? 'bg-cyan-500/90 text-white'
              : 'bg-rose-500/90 text-white'
          )}>
            {data.isValidDrop !== false ? 'Drop here to place inside container' : 'Cannot place resource inside this container'}
          </div>
        </div>
      )}

      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        id="target-top"
        className={clsx('!w-2 !h-2 !bg-cyan-500/50 hover:!bg-cyan-500 !border-2 transition-all opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:scale-125', isLight ? '!border-white' : '!border-slate-900')}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="source-bottom"
        className={clsx('!w-2 !h-2 !bg-cyan-500/50 hover:!bg-cyan-500 !border-2 transition-all opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:scale-125', isLight ? '!border-white' : '!border-slate-900')}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="target-left"
        className={clsx('!w-2 !h-2 !bg-cyan-500/50 hover:!bg-cyan-500 !border-2 transition-all opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:scale-125', isLight ? '!border-white' : '!border-slate-900')}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source-right"
        className={clsx('!w-2 !h-2 !bg-cyan-500/50 hover:!bg-cyan-500 !border-2 transition-all opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:scale-125', isLight ? '!border-white' : '!border-slate-900')}
      />
    </div>
  );
});

ContainerNode.displayName = 'ContainerNode';
export default ContainerNode;

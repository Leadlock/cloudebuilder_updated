'use client';
import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { useApp } from '@/context/AppContext';
import { Lock } from 'lucide-react';
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
            ? 'bg-[#fdf6ed] border-2 border-slate-900 shadow-sm'
            : 'bg-[#261f17] border-2 border-slate-700 shadow-2xl'
          : isLight
            ? 'bg-[#faf5ff] border-2 border-purple-600 shadow-sm'
            : 'bg-[#27153b] border-2 border-purple-500 shadow-md',
        isDeleted && (isLight ? '!opacity-50 !border-slate-300 bg-slate-100 grayscale' : '!opacity-50 !border-slate-700 bg-slate-950/80 grayscale'),
        isImported && !isDeleted && (isLight ? '!border-cyan-400' : '!border-cyan-500/40'),
        selected && (isVpc ? 'ring-2 ring-slate-900' : 'ring-2 ring-purple-600'),
        data.isDragTarget && (data.isValidDrop !== false
          ? '!border-cyan-400 !ring-4 !ring-cyan-400/30 !bg-cyan-950/25'
          : '!border-rose-500 !ring-4 !ring-rose-500/30 !bg-rose-950/25')
      )}
    >
      {/* Container Header Badge (Brainboard style) */}
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <div className="shrink-0 w-6 h-6 rounded-md bg-[#7c3aed] text-white flex items-center justify-center p-1 shadow-sm">
            {isSubnet ? (
              <Lock className="w-3.5 h-3.5 text-white" />
            ) : (
              <CloudServiceIcon
                provider={provider}
                resourceType={data.resourceType}
                size={16}
              />
            )}
          </div>
          <div className="min-w-0 flex items-center gap-2">
            <span className={`${isLight ? 'text-slate-900' : 'text-white'} font-semibold text-xs tracking-tight truncate max-w-[200px]`}>
              {data.label}
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

        {/* Badges / Metrics */}
        <div className="flex items-center gap-1.5 shrink-0">
          {cidr && (
            <span className={`font-mono text-[10px] px-2 py-0.5 rounded ${isLight ? 'bg-white/90 text-slate-800 border border-slate-300 shadow-sm font-semibold' : 'bg-black/50 text-gray-300 border border-white/10'}`}>
              {cidr}
            </span>
          )}
          {az && (
            <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded ${isLight ? 'bg-white/90 text-slate-700 border border-slate-300 shadow-sm font-medium' : 'bg-black/40 text-gray-400'}`}>
              {az}
            </span>
          )}
          {typeof data.childCount === 'number' && data.childCount > 0 && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${isLight ? 'bg-purple-100 text-purple-900 border border-purple-200' : 'bg-purple-900/40 text-purple-200 border border-purple-500/30'} font-medium`}>
              {data.childCount} {data.childCount === 1 ? 'resource' : 'resources'}
            </span>
          )}
          {data.showFindings && data.findingsSummary && data.findingsSummary.total > 0 && (
            <span
              className={clsx(
                'text-[9px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1',
                (data.findingsSummary.critical > 0 || data.findingsSummary.high > 0)
                  ? 'bg-rose-500 text-white border-rose-400'
                  : 'bg-amber-500 text-slate-950 border-amber-400'
              )}
            >
              WA: {data.findingsSummary.total}
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

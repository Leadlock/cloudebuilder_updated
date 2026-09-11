'use client';
import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
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
  const isVpc = data.resourceType === 'aws_vpc' || data.resourceType === 'azure_vnet' || data.resourceType === 'azure_resource_group';
  const isSubnet = data.resourceType === 'aws_subnet' || data.resourceType === 'azure_subnet';
  const provider = data.provider ?? (data.resourceType.startsWith('azure_') ? 'azure' : 'aws');
  const isImported = data.importState === 'imported' || data.config?.imported === true || data.config?.importState === 'imported';
  
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
        'relative rounded-2xl transition-all select-none',
        isVpc
          ? 'bg-purple-950/15 border-2 border-purple-500/40 shadow-2xl backdrop-blur-[2px]'
          : 'bg-emerald-950/10 border-2 border-dashed border-emerald-500/50 shadow-md',
        isImported && '!border-cyan-500/40',
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
            ? 'bg-purple-900/30 border-purple-500/30'
            : 'bg-emerald-900/25 border-emerald-500/25'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="shrink-0 p-1 rounded-lg bg-black/40 border border-white/10 shadow-sm">
            <CloudServiceIcon
              provider={provider}
              resourceType={data.resourceType}
              size={isVpc ? 22 : 18}
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-white font-bold text-xs tracking-tight truncate max-w-[180px]">
                {data.label}
              </span>
              <span
                className={clsx(
                  'text-[10px] font-semibold px-1.5 py-0.2 rounded uppercase tracking-wider',
                  isVpc ? 'text-purple-300 bg-purple-500/20' : 'text-emerald-300 bg-emerald-500/20'
                )}
              >
                {isVpc ? (provider === 'azure' ? 'Virtual Network' : 'VPC') : (isPublic ? 'Public Subnet' : 'Private Subnet')}
              </span>
              {isImported && (
                <span
                  className="inline-flex items-center gap-1 text-[8px] font-bold px-1.5 py-0.2 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 uppercase tracking-wider shrink-0"
                  title="Imported Live Container"
                >
                  <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
                  Imported
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Badges / Metrics */}
        <div className="flex items-center gap-1.5 shrink-0">
          {cidr && (
            <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-black/50 text-gray-300 border border-white/10">
              {cidr}
            </span>
          )}
          {az && (
            <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-black/40 text-gray-400">
              {az}
            </span>
          )}
          {typeof data.childCount === 'number' && data.childCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 font-medium">
              {data.childCount} {data.childCount === 1 ? 'resource' : 'resources'}
            </span>
          )}
          {data.showFindings && data.findingsSummary && data.findingsSummary.total > 0 && (
            <span
              className={clsx(
                'text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex items-center gap-1',
                (data.findingsSummary.critical > 0 || data.findingsSummary.high > 0)
                  ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
              )}
              title={`${data.findingsSummary.total} WAF findings`}
            >
              <span className={clsx('w-1.5 h-1.5 rounded-full', (data.findingsSummary.critical > 0 || data.findingsSummary.high > 0) ? 'bg-rose-400' : 'bg-amber-400')} />
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
        className="!w-2.5 !h-2.5 !bg-gray-400 !border-2 !border-gray-800 hover:!bg-blue-400 transition-colors"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-gray-400 !border-2 !border-gray-800 hover:!bg-blue-400 transition-colors"
      />
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-gray-400 !border-2 !border-gray-800 hover:!bg-blue-400 transition-colors"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-gray-400 !border-2 !border-gray-800 hover:!bg-blue-400 transition-colors"
      />
    </div>
  );
});

ContainerNode.displayName = 'ContainerNode';
export default ContainerNode;

'use client';
import { memo } from 'react';
import { Handle, Position, NodeProps, useStore } from 'reactflow';
import { getResourceDefinition } from '@/lib/resources';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { useApp } from '@/context/AppContext';
import clsx from 'clsx';

interface CloudNodeData {
  label: string;
  resourceType: string;
  provider?: 'aws' | 'azure';
  config?: Record<string, unknown>;
  selected?: boolean;
  hasWarnings?: boolean;
  hasErrors?: boolean;
  status?: 'ready' | 'warning' | 'error' | 'unconfigured';
  importState?: 'imported' | 'cloudcraft-managed' | 'new' | 'modified' | 'planned';
  findingsSummary?: { critical: number; high: number; medium: number; total: number };
  showFindings?: boolean;
}

const zoomSelector = (s: { transform: [number, number, number] }) => s.transform[2];

const CloudNode = memo(({ data, selected }: NodeProps<CloudNodeData>) => {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const def = getResourceDefinition(data.resourceType);
  const zoom = useStore(zoomSelector);

  const provider = data.provider ?? def?.provider ?? (data.resourceType.startsWith('azure_') ? 'azure' : 'aws');
  const serviceTitle = def?.service ?? def?.label ?? data.resourceType.replace(/^(aws_|azure_)/, '').toUpperCase();

  // Extract key architectural specs based on resource type
  const config = data.config || {};
  const isImported = data.importState === 'imported' || config.imported === true || config.importState === 'imported';
  const isPlanned = data.importState === 'new' || data.importState === 'planned';
  const rawId = (config.resourceId as string) || (config.providerResourceId as string) || '';

  const specs: string[] = [];

  if (data.resourceType === 'aws_ec2') {
    if (config.instanceType) specs.push(String(config.instanceType));
    if (config.os) specs.push(String(config.os).replace(' LTS', '').replace(' Server', ''));
    if (config.storageGb) specs.push(`${config.storageGb} GB`);
  } else if (data.resourceType === 'aws_container_service') {
    if (config.stack) specs.push(String(config.stack));
    if (config.port) specs.push(`:${config.port}`);
    if (config.instanceType) specs.push(String(config.instanceType));
  } else if (data.resourceType === 'azure_vm') {
    if (config.size) specs.push(String(config.size));
    if (config.osType) specs.push(String(config.osType));
  } else if (data.resourceType === 'aws_rds') {
    if (config.engine) specs.push(String(config.engine).toUpperCase());
    if (config.instanceClass) specs.push(String(config.instanceClass));
    if (config.multiAz) specs.push('Multi-AZ');
  } else if (data.resourceType === 'azure_sql') {
    if (config.tier) specs.push(String(config.tier));
    if (config.maxSizeGb) specs.push(`${config.maxSizeGb} GB`);
  } else if (data.resourceType === 'aws_s3') {
    if (config.bucketName) specs.push(String(config.bucketName));
    if (config.encryption) specs.push('SSE Encrypted');
  } else if (data.resourceType === 'aws_alb') {
    if (config.lbType) specs.push(String(config.lbType).toUpperCase());
    if (config.scheme) specs.push(String(config.scheme));
  } else if (data.resourceType === 'aws_auto_scaling') {
    if (config.desiredCapacity) specs.push(`Min ${config.minSize} / Desired ${config.desiredCapacity}`);
  } else if (data.resourceType === 'aws_lambda') {
    if (config.runtime) specs.push(String(config.runtime));
    if (config.memorySize) specs.push(`${config.memorySize} MB`);
  } else if (data.resourceType === 'aws_sg' || data.resourceType === 'azure_nsg') {
    const rules = [];
    if (config.allowHttp) rules.push('HTTP');
    if (config.allowHttps) rules.push('HTTPS');
    if (config.allowSsh) rules.push('SSH');
    if (rules.length > 0) specs.push(rules.join(', '));
  }

  // Determine live status and architectural validation
  const rawStatus = (config.status as string) || (config.cloudStatus as string) || (config.state as string) || (data as any).status;
  const normalizedStatus = rawStatus ? String(rawStatus).toLowerCase().trim() : '';

  const isDeleted = normalizedStatus === 'deleted' || normalizedStatus === 'terminated' || normalizedStatus === 'destroyed';
  const isDeleting = normalizedStatus === 'deleting' || normalizedStatus === 'terminating' || normalizedStatus === 'shutting-down';
  const isStopped = normalizedStatus === 'stopped' || normalizedStatus === 'stopping' || normalizedStatus === 'inactive' || normalizedStatus === 'paused' || normalizedStatus === 'disabled' || normalizedStatus === 'draining';
  const isPending = normalizedStatus === 'pending' || normalizedStatus === 'creating' || normalizedStatus === 'provisioning' || normalizedStatus === 'modifying' || normalizedStatus === 'updating' || normalizedStatus === 'scaling';
  const isFailed = normalizedStatus === 'failed' || normalizedStatus === 'error' || normalizedStatus === 'unhealthy' || normalizedStatus === 'impaired' || normalizedStatus === 'degraded';
  const isLiveActive = normalizedStatus === 'available' || normalizedStatus === 'running' || normalizedStatus === 'active' || normalizedStatus === 'ready' || normalizedStatus === 'in-use' || normalizedStatus === 'attached' || normalizedStatus === 'ok' || normalizedStatus === 'enabled';

  let statusColor = 'bg-emerald-400';
  let statusText = 'Ready';

  if (isDeleted) {
    statusColor = 'bg-slate-500';
    statusText = normalizedStatus === 'terminated' ? 'Terminated' : 'Deleted';
  } else if (isDeleting) {
    statusColor = 'bg-rose-500 animate-pulse';
    statusText = 'Deleting';
  } else if (isFailed) {
    statusColor = 'bg-rose-500';
    statusText = 'Failed';
  } else if (isStopped) {
    statusColor = 'bg-amber-400';
    statusText = normalizedStatus === 'inactive' ? 'Inactive' : normalizedStatus === 'draining' ? 'Draining' : 'Stopped';
  } else if (isPending) {
    statusColor = 'bg-sky-400 animate-pulse';
    statusText = normalizedStatus === 'creating' || normalizedStatus === 'provisioning' ? 'Creating' : 'Pending';
  } else if (data.hasErrors) {
    statusColor = 'bg-rose-500';
    statusText = 'Config Error';
  } else if (data.hasWarnings || (data.resourceType === 'aws_ec2' && !config.keyName)) {
    statusColor = 'bg-amber-400';
    statusText = 'Warning';
  } else if (isLiveActive) {
    statusColor = 'bg-emerald-400';
    statusText = isImported ? (normalizedStatus === 'running' ? 'Running' : normalizedStatus === 'available' ? 'Available' : 'Active') : 'Ready';
  } else if (isPlanned) {
    statusColor = 'bg-cyan-400';
    statusText = 'Proposed';
  }

  // Level of detail based on zoom
  const isZoomedOut = zoom < 0.65;
  const isZoomedMedium = zoom >= 0.65 && zoom < 0.95;

  return (
    <div
      role="article"
      aria-label={`${data.label} (${serviceTitle})`}
      className={clsx(
        'group relative rounded-xl transition-all select-none border',
        isLight
          ? 'bg-white/95 shadow-md backdrop-blur-md text-slate-900'
          : 'bg-slate-900/95 shadow-xl backdrop-blur-md text-white',
        isDeleted && (isLight ? '!opacity-50 !border-slate-300 bg-slate-100 grayscale' : '!opacity-50 !border-slate-700 bg-slate-950/80 grayscale'),
        isDeleting && '!border-rose-500/60 shadow-rose-950/50 ring-1 ring-rose-500/30',
        isStopped && '!border-amber-500/50 shadow-amber-950/40',
        isFailed && '!border-rose-500 shadow-rose-950/50',
        isImported && !isDeleted && !isDeleting && !isStopped && !isFailed && (isLight ? '!border-cyan-500/80 shadow-cyan-500/10' : '!border-cyan-500/50 shadow-cyan-950/40'),
        selected
          ? '!border-cyan-400 !shadow-cyan-500/25 ring-2 ring-cyan-400/40'
          : isLight
            ? 'border-slate-200/90 hover:border-slate-400 hover:shadow-lg'
            : 'border-slate-700/80 hover:border-slate-500 hover:shadow-2xl',
        isZoomedOut ? 'min-w-[130px] p-2' : 'min-w-[180px] p-3'
      )}
    >
      {data.showFindings && data.findingsSummary && (
        <div
          className={clsx(
            'absolute -top-2 -right-2 z-10 flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[9px] font-bold shadow-lg border pointer-events-none',
            (data.findingsSummary.critical > 0 || data.findingsSummary.high > 0)
              ? 'bg-rose-500 text-white border-rose-400 ring-2 ring-rose-950/80'
              : data.findingsSummary.medium > 0
              ? 'bg-amber-500 text-slate-950 border-amber-400 ring-2 ring-amber-950/80'
              : data.findingsSummary.total > 0
              ? 'bg-yellow-500 text-slate-950 border-yellow-400'
              : 'bg-emerald-500 text-white border-emerald-400'
          )}
          title={`Well-Architected Findings: ${data.findingsSummary.total} (${data.findingsSummary.critical} critical, ${data.findingsSummary.high} high, ${data.findingsSummary.medium} medium)`}
        >
          {data.findingsSummary.total > 0 ? (
            <span>{data.findingsSummary.critical > 0 ? `!${data.findingsSummary.critical}` : data.findingsSummary.total}</span>
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-white" />
          )}
        </div>
      )}

      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        id="target-top"
        className={clsx('!w-2 !h-2 !bg-cyan-500/50 hover:!bg-cyan-500 !border-2 group-hover:opacity-100 opacity-0 transition-all hover:scale-125', isLight ? '!border-white' : '!border-slate-900')}
        style={{ top: -4 }}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="target-left"
        className={clsx('!w-2 !h-2 !bg-cyan-500/50 hover:!bg-cyan-500 !border-2 group-hover:opacity-100 opacity-0 transition-all hover:scale-125', isLight ? '!border-white' : '!border-slate-900')}
        style={{ left: -4 }}
      />

      {/* Node Header */}
      <div className="flex items-start gap-2.5">
        <div className={`shrink-0 p-1.5 rounded-lg ${isLight ? 'bg-slate-100 border border-slate-200' : 'bg-slate-950 border border-slate-800'} shadow-inner`}>
          <CloudServiceIcon
            provider={provider}
            resourceType={data.resourceType}
            size={isZoomedOut ? 22 : 28}
          />
        </div>

        <div className="min-w-0 flex-1">
          <p className={`${isLight ? 'text-slate-900' : 'text-white'} font-bold text-xs tracking-tight truncate leading-snug`}>
            {data.label}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <p className={`text-[10px] ${isLight ? 'text-slate-500' : 'text-slate-400'} truncate font-medium`}>
              {serviceTitle}
            </p>
            {isImported && (
              <span
                className={`inline-flex items-center gap-1 text-[8px] font-bold ${
                  isLight ? 'text-cyan-800 bg-cyan-50 border-cyan-300' : 'text-cyan-300 bg-cyan-950/90 border-cyan-500/40'
                } border px-1.5 py-0.2 rounded-full uppercase tracking-wider shrink-0`}
                title={rawId ? `Imported (${rawId})` : 'Imported Infrastructure'}
              >
                <span className="w-1 h-1 rounded-full bg-cyan-500 animate-pulse" />
                Imported
              </span>
            )}
            {isDeleted && (
              <span className={`inline-flex items-center gap-1 text-[8px] font-bold ${
                isLight ? 'text-slate-600 bg-slate-100 border-slate-300' : 'text-slate-300 bg-slate-800/90 border-slate-600'
              } border px-1.5 py-0.2 rounded-full uppercase tracking-wider shrink-0`}>
                <span className="w-1 h-1 rounded-full bg-slate-400" />
                Deleted
              </span>
            )}
            {isDeleting && (
              <span className={`inline-flex items-center gap-1 text-[8px] font-bold ${
                isLight ? 'text-rose-700 bg-rose-50 border-rose-300' : 'text-rose-300 bg-rose-950/90 border-rose-500/40'
              } border px-1.5 py-0.2 rounded-full uppercase tracking-wider shrink-0 animate-pulse`}>
                <span className="w-1 h-1 rounded-full bg-rose-500" />
                Deleting
              </span>
            )}
            {isStopped && (
              <span className={`inline-flex items-center gap-1 text-[8px] font-bold ${
                isLight ? 'text-amber-800 bg-amber-50 border-amber-300' : 'text-amber-300 bg-amber-950/90 border-amber-500/40'
              } border px-1.5 py-0.2 rounded-full uppercase tracking-wider shrink-0`}>
                <span className="w-1 h-1 rounded-full bg-amber-500" />
                Stopped
              </span>
            )}
            {isFailed && (
              <span className={`inline-flex items-center gap-1 text-[8px] font-bold ${
                isLight ? 'text-rose-700 bg-rose-50 border-rose-300' : 'text-rose-300 bg-rose-950/90 border-rose-500/40'
              } border px-1.5 py-0.2 rounded-full uppercase tracking-wider shrink-0`}>
                <span className="w-1 h-1 rounded-full bg-rose-500" />
                Failed
              </span>
            )}
            {isPlanned && (
              <span
                className={`inline-flex items-center gap-1 text-[8px] font-bold ${
                  isLight ? 'text-emerald-800 bg-emerald-50 border-emerald-300' : 'text-emerald-300 bg-emerald-950/90 border-emerald-500/40'
                } border px-1.5 py-0.2 rounded-full uppercase tracking-wider shrink-0`}
              >
                <span className="w-1 h-1 rounded-full bg-emerald-500" />
                Proposed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Node Body / Architectural Specs (Hidden when zoomed out for performance and clarity) */}
      {!isZoomedOut && specs.length > 0 && (
        <div className={`mt-2.5 pt-2 border-t ${isLight ? 'border-slate-100' : 'border-slate-800/80'} space-y-1`}>
          {specs.map((spec, i) => (
            <div key={i} className={`flex items-center text-[10px] font-mono ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isLight ? 'bg-slate-400' : 'bg-slate-600'} mr-1.5 shrink-0`} />
              <span className="truncate">{spec}</span>
            </div>
          ))}
        </div>
      )}

      {/* Status Footer */}
      {!isZoomedOut && (
        <div className={`mt-2.5 pt-1.5 flex items-center justify-between border-t ${isLight ? 'border-slate-100' : 'border-slate-800/50'}`}>
          <div className="flex items-center gap-1.5">
            <span className={clsx('w-2 h-2 rounded-full', statusColor)} />
            <span className={`text-[9px] font-medium uppercase tracking-wider ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
              {statusText}
            </span>
          </div>

          <span
            className={clsx(
              'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded',
              provider === 'aws'
                ? isLight ? 'text-amber-700 bg-amber-100/80' : 'text-amber-400 bg-amber-400/10'
                : isLight ? 'text-blue-700 bg-blue-100/80' : 'text-blue-400 bg-blue-400/10'
            )}
          >
            {provider.toUpperCase()}
          </span>
        </div>
      )}

      {/* Source Handles */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="source-bottom"
        className={clsx('!w-2 !h-2 !bg-cyan-500/50 hover:!bg-cyan-500 !border-2 group-hover:opacity-100 opacity-0 transition-all hover:scale-125', isLight ? '!border-white' : '!border-slate-900')}
        style={{ bottom: -4 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source-right"
        className={clsx('!w-2 !h-2 !bg-cyan-500/50 hover:!bg-cyan-500 !border-2 group-hover:opacity-100 opacity-0 transition-all hover:scale-125', isLight ? '!border-white' : '!border-slate-900')}
        style={{ right: -4 }}
      />
    </div>
  );
});

CloudNode.displayName = 'CloudNode';
export default CloudNode;

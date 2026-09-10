'use client';
import { memo } from 'react';
import { Handle, Position, NodeProps, useStore } from 'reactflow';
import { getResourceDefinition } from '@/lib/resources';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
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
}

const zoomSelector = (s: { transform: [number, number, number] }) => s.transform[2];

const CloudNode = memo(({ data, selected }: NodeProps<CloudNodeData>) => {
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

  // Determine status
  const isError = data.hasErrors;
  const isWarning = data.hasWarnings || (data.resourceType === 'aws_ec2' && !config.keyName);
  const statusColor = isError ? 'bg-rose-500' : isWarning ? 'bg-amber-400' : 'bg-emerald-400';
  const statusText = isError ? 'Configuration Error' : isWarning ? 'Warning' : 'Ready';

  // Level of detail based on zoom
  const isZoomedOut = zoom < 0.65;
  const isZoomedMedium = zoom >= 0.65 && zoom < 0.95;

  return (
    <div
      role="article"
      aria-label={`${data.label} (${serviceTitle})`}
      className={clsx(
        'group relative rounded-xl transition-all select-none border',
        'bg-slate-900/95 shadow-xl backdrop-blur-md',
        isImported && '!border-cyan-500/50 shadow-cyan-950/40',
        selected
          ? '!border-cyan-400 !shadow-cyan-500/25 ring-2 ring-cyan-400/40'
          : 'border-slate-700/80 hover:border-slate-500 hover:shadow-2xl',
        isZoomedOut ? 'min-w-[130px] p-2' : 'min-w-[180px] p-3'
      )}
    >
      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-slate-400 !border-2 !border-slate-900 group-hover:!bg-cyan-400 transition-colors"
        style={{ top: -5 }}
      />
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-slate-400 !border-2 !border-slate-900 group-hover:!bg-cyan-400 transition-colors"
        style={{ left: -5 }}
      />

      {/* Node Header */}
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 p-1.5 rounded-lg bg-slate-950 border border-slate-800 shadow-inner">
          <CloudServiceIcon
            provider={provider}
            resourceType={data.resourceType}
            size={isZoomedOut ? 22 : 28}
          />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-white font-bold text-xs tracking-tight truncate leading-snug">
            {data.label}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="text-[10px] text-slate-400 truncate font-medium">
              {serviceTitle}
            </p>
            {isImported && (
              <span
                className="inline-flex items-center gap-1 text-[8px] font-bold text-cyan-300 bg-cyan-950/90 border border-cyan-500/40 px-1.5 py-0.2 rounded-full uppercase tracking-wider shrink-0"
                title={rawId ? `Imported (${rawId})` : 'Imported Infrastructure'}
              >
                <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
                Imported
              </span>
            )}
            {isPlanned && (
              <span
                className="inline-flex items-center gap-1 text-[8px] font-bold text-emerald-300 bg-emerald-950/90 border border-emerald-500/40 px-1.5 py-0.2 rounded-full uppercase tracking-wider shrink-0"
              >
                <span className="w-1 h-1 rounded-full bg-emerald-400" />
                Proposed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Node Body / Architectural Specs (Hidden when zoomed out for performance and clarity) */}
      {!isZoomedOut && specs.length > 0 && (
        <div className="mt-2.5 pt-2 border-t border-slate-800/80 space-y-1">
          {specs.map((spec, i) => (
            <div key={i} className="flex items-center text-[10px] font-mono text-slate-300">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-600 mr-1.5 shrink-0" />
              <span className="truncate">{spec}</span>
            </div>
          ))}
        </div>
      )}

      {/* Status Footer */}
      {!isZoomedOut && (
        <div className="mt-2.5 pt-1.5 flex items-center justify-between border-t border-slate-800/50">
          <div className="flex items-center gap-1.5">
            <span className={clsx('w-2 h-2 rounded-full animate-pulse', statusColor)} />
            <span className="text-[9px] font-medium text-slate-400 uppercase tracking-wider">
              {statusText}
            </span>
          </div>

          <span
            className={clsx(
              'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded',
              provider === 'aws' ? 'text-amber-400 bg-amber-400/10' : 'text-blue-400 bg-blue-400/10'
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
        className="!w-2.5 !h-2.5 !bg-slate-400 !border-2 !border-slate-900 group-hover:!bg-cyan-400 transition-colors"
        style={{ bottom: -5 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-slate-400 !border-2 !border-slate-900 group-hover:!bg-cyan-400 transition-colors"
        style={{ right: -5 }}
      />
    </div>
  );
});

CloudNode.displayName = 'CloudNode';
export default CloudNode;

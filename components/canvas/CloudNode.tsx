'use client';
import { memo } from 'react';
import { Handle, Position, NodeProps, useStore } from 'reactflow';
import { getResourceDefinition } from '@/lib/resources';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { useApp } from '@/context/AppContext';
import clsx from 'clsx';

import { DataflowConnectionStatus } from '@/lib/canvas/dataflowStatus';

export interface ConnectedHandleDetail {
  status: 'connected_healthy' | 'needs_manual_config';
  edgeId: string;
  label?: string;
  otherNodeLabel?: string;
  isSelected?: boolean;
}

export interface CloudNodeData {
  label: string;
  resourceType: string;
  provider?: 'aws' | 'azure';
  config?: Record<string, unknown>;
  selected?: boolean;
  hasWarnings?: boolean;
  hasErrors?: boolean;
  status?: 'ready' | 'warning' | 'error' | 'unconfigured';
  importState?: 'imported' | 'cloudbuilder-managed' | 'new' | 'modified' | 'planned';
  driftState?: { status: 'in_sync' | 'drifted' | 'missing' };
  findingsSummary?: { critical: number; high: number; medium: number; total: number };
  showFindings?: boolean;
  dataflowConnection?: DataflowConnectionStatus;
  connectedHandles?: Record<string, ConnectedHandleDetail>;
  isEdgeHighlighted?: boolean;
  highlightedEdgeRole?: 'source' | 'target' | null;
  highlightedEdgeLabel?: string;
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
  const isDrifted = data.driftState?.status === 'drifted' || config.driftStatus === 'drifted' || !!config._simulatedDrift;
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

  // Dataflow connection state & health determination
  const df = data.dataflowConnection;
  const isConnected = df?.isConnected ?? false;
  const isDfHealthy = df ? df.isConfigured : true;
  const needsManualConfig = isConnected && !isDfHealthy;

  if (isConnected) {
    if (needsManualConfig) {
      statusColor = 'bg-rose-500 animate-pulse';
      statusText = 'Needs Manual Configuration';
    } else if (!isDeleted && !isDeleting && !isFailed && !isStopped) {
      statusColor = 'bg-emerald-400';
      statusText = 'Working Correctly (Dataflow Active)';
    }
  }

  // Level of detail based on zoom
  const isZoomedOut = zoom < 0.65;
  const isZoomedMedium = zoom >= 0.65 && zoom < 0.95;

const HANDLE_DEFS = [
  // Top (left 20%, center 50%, right 80%)
  { pos: Position.Top, idTarget: 'target-top-left', idSource: 'source-top-left', style: { top: -6, left: '20%' } },
  { pos: Position.Top, idTarget: 'target-top', idSource: 'source-top', style: { top: -6, left: '50%' } },
  { pos: Position.Top, idTarget: 'target-top-right', idSource: 'source-top-right', style: { top: -6, left: '80%' } },

  // Right (top 20%, center 50%, bottom 80%)
  { pos: Position.Right, idTarget: 'target-right-top', idSource: 'source-right-top', style: { right: -6, top: '20%' } },
  { pos: Position.Right, idTarget: 'target-right', idSource: 'source-right', style: { right: -6, top: '50%' } },
  { pos: Position.Right, idTarget: 'target-right-bottom', idSource: 'source-right-bottom', style: { right: -6, top: '80%' } },

  // Bottom (left 20%, center 50%, right 80%)
  { pos: Position.Bottom, idTarget: 'target-bottom-left', idSource: 'source-bottom-left', style: { bottom: -6, left: '20%' } },
  { pos: Position.Bottom, idTarget: 'target-bottom', idSource: 'source-bottom', style: { bottom: -6, left: '50%' } },
  { pos: Position.Bottom, idTarget: 'target-bottom-right', idSource: 'source-bottom-right', style: { bottom: -6, left: '80%' } },

  // Left (top 20%, center 50%, bottom 80%)
  { pos: Position.Left, idTarget: 'target-left-top', idSource: 'source-left-top', style: { left: -6, top: '20%' } },
  { pos: Position.Left, idTarget: 'target-left', idSource: 'source-left', style: { left: -6, top: '50%' } },
  { pos: Position.Left, idTarget: 'target-left-bottom', idSource: 'source-left-bottom', style: { left: -6, top: '80%' } },
];

  const connectedHandles = data.connectedHandles || {};

  return (
    <div
      role="article"
      aria-label={`${data.label} (${serviceTitle})`}
      className="group relative flex flex-col items-center select-none"
    >
      {/* Edge click / highlight indicator banner */}
      {data.isEdgeHighlighted && (
        <div className="absolute -top-7 px-2.5 py-0.5 rounded-full bg-emerald-500 text-slate-950 font-mono text-[9px] font-extrabold tracking-wide shadow-[0_0_14px_rgba(16,185,129,0.9)] flex items-center gap-1.5 z-40 whitespace-nowrap animate-pulse">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-950 animate-ping" />
          <span>{data.highlightedEdgeRole === 'source' ? 'DATAFLOW SOURCE' : 'DATAFLOW TARGET'}</span>
          {data.highlightedEdgeLabel && (
            <span className="opacity-80">({data.highlightedEdgeLabel})</span>
          )}
        </div>
      )}

      {/* Brainboard Square Icon Card */}
      <div
        className={clsx(
          'relative w-[60px] h-[60px] sm:w-16 sm:h-16 rounded-xl flex items-center justify-center transition-all duration-150',
          isLight
            ? 'bg-white shadow-xs border border-slate-200/90 hover:border-[#0078d4]/60 hover:shadow-md'
            : 'bg-[#1c1c1e] shadow-md border border-white/10 hover:border-[#0078d4]/60 hover:shadow-xl',
          isDeleted && '!opacity-50 !border-slate-300 bg-slate-100 grayscale',
          isDeleting && '!border-rose-500/80 ring-2 ring-rose-500/30 shadow-rose-950/40',
          isStopped && '!border-amber-500/60 shadow-amber-950/30',
          isFailed && '!border-rose-500 ring-2 ring-rose-500/40',
          isDrifted && !isDeleted && '!border-amber-500 ring-2 ring-amber-500/50 shadow-amber-500/20',
          isConnected && !needsManualConfig && !isDeleted && !isFailed && (isLight ? '!border-emerald-500 shadow-emerald-500/15' : '!border-emerald-500/80 shadow-[0_0_10px_rgba(16,185,129,0.25)]'),
          needsManualConfig && !isDeleted && '!border-rose-500 ring-2 ring-rose-500/60 shadow-[0_0_12px_rgba(244,63,94,0.45)] animate-pulse',
          isImported && !isDeleted && !isDeleting && !isStopped && !isFailed && !isConnected && (isLight ? '!border-[#0078d4] shadow-[#0078d4]/10' : '!border-[#0078d4]/60 shadow-[#0078d4]/20'),
          data.isEdgeHighlighted && '!border-emerald-400 !ring-2 !ring-emerald-400/80 shadow-[0_0_24px_rgba(16,185,129,0.7)] scale-105 z-30',
          selected
            ? '!border-[#0078d4] !ring-2 !ring-[#0078d4]/40 shadow-lg shadow-[#0078d4]/20'
            : ''
        )}
      >
        {/* Drift Badge (top-left) */}
        {isDrifted && (
          <div
            className="absolute -top-2 -left-2 z-20 flex items-center justify-center px-1.5 py-0.5 rounded-full text-[8px] font-black uppercase tracking-wider bg-amber-500 text-slate-950 shadow-md border border-amber-300 pointer-events-none animate-pulse"
            title="Drift Detected: live cloud differs from canvas"
          >
            Drift
          </div>
        )}

        {/* Security / Well-Architected Findings Badge */}
        {data.showFindings && data.findingsSummary && (
          <div
            className={clsx(
              'absolute -top-2 -right-2 z-20 flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[9px] font-bold shadow-lg border pointer-events-none',
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

        {/* Dynamic Multi-Port Connection Handles & Individual Dataflow Green/Red Dots */}
        {HANDLE_DEFS.map(({ pos, idTarget, idSource, style }) => {
          const targetConn = connectedHandles[idTarget];
          const sourceConn = connectedHandles[idSource];
          const isTargetConnected = !!targetConn;
          const isSourceConnected = !!sourceConn;

          return (
            <div key={idTarget}>
              <Handle
                type="target"
                position={pos}
                id={idTarget}
                style={style}
                className={clsx(
                  'transition-all',
                  isTargetConnected
                    ? clsx(
                        '!w-3.5 !h-3.5 !rounded-full !border-2 opacity-100 cursor-pointer z-30',
                        targetConn.status === 'connected_healthy'
                          ? isLight
                            ? '!bg-emerald-500 !border-white shadow-[0_0_8px_rgba(16,185,129,0.8)]'
                            : '!bg-emerald-400 !border-slate-950 shadow-[0_0_10px_rgba(52,211,153,0.9)]'
                          : '!bg-rose-500 !border-slate-950 shadow-[0_0_10px_rgba(244,63,94,0.9)] animate-pulse',
                        targetConn.isSelected && '!ring-4 !ring-emerald-400/70 scale-125'
                      )
                    : clsx(
                        '!w-2.5 !h-2.5 !bg-[#0078d4] hover:!bg-[#106ebe] !border-2 opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:scale-125 z-20',
                        isLight ? '!border-white' : '!border-slate-900'
                      )
                )}
                title={
                  targetConn
                    ? `● Connected Dataflow (${targetConn.label || 'Active'} ← ${targetConn.otherNodeLabel || 'source'})${targetConn.status === 'needs_manual_config' ? ' [Needs Config]' : ''}`
                    : undefined
                }
              >
                {isTargetConnected && (
                  <span
                    className={clsx(
                      'absolute inset-0 rounded-full pointer-events-none',
                      targetConn.status === 'connected_healthy'
                        ? 'animate-ping opacity-60 bg-emerald-400'
                        : 'animate-ping opacity-75 bg-rose-500'
                    )}
                    style={{ animationDuration: targetConn.status === 'connected_healthy' ? '3s' : '1.5s' }}
                  />
                )}
              </Handle>

              <Handle
                type="source"
                position={pos}
                id={idSource}
                style={style}
                className={clsx(
                  'transition-all',
                  isSourceConnected
                    ? clsx(
                        '!w-3.5 !h-3.5 !rounded-full !border-2 opacity-100 cursor-pointer z-30',
                        sourceConn.status === 'connected_healthy'
                          ? isLight
                            ? '!bg-emerald-500 !border-white shadow-[0_0_8px_rgba(16,185,129,0.8)]'
                            : '!bg-emerald-400 !border-slate-950 shadow-[0_0_10px_rgba(52,211,153,0.9)]'
                          : '!bg-rose-500 !border-slate-950 shadow-[0_0_10px_rgba(244,63,94,0.9)] animate-pulse',
                        sourceConn.isSelected && '!ring-4 !ring-emerald-400/70 scale-125'
                      )
                    : clsx(
                        '!w-2.5 !h-2.5 !bg-[#0078d4] hover:!bg-[#106ebe] !border-2 opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:scale-125 z-20',
                        isLight ? '!border-white' : '!border-slate-900'
                      )
                )}
                title={
                  sourceConn
                    ? `● Outgoing Dataflow (${sourceConn.label || 'Active'} → ${sourceConn.otherNodeLabel || 'target'})${sourceConn.status === 'needs_manual_config' ? ' [Needs Config]' : ''}`
                    : undefined
                }
              >
                {isSourceConnected && (
                  <span
                    className={clsx(
                      'absolute inset-0 rounded-full pointer-events-none',
                      sourceConn.status === 'connected_healthy'
                        ? 'animate-ping opacity-60 bg-emerald-400'
                        : 'animate-ping opacity-75 bg-rose-500'
                    )}
                    style={{ animationDuration: sourceConn.status === 'connected_healthy' ? '3s' : '1.5s' }}
                  />
                )}
              </Handle>
            </div>
          );
        })}

        {/* Centered Service Icon */}
        <div className="flex items-center justify-center p-2.5 w-full h-full">
          <CloudServiceIcon
            provider={provider}
            resourceType={data.resourceType}
            size={38}
          />
        </div>
      </div>

      {/* Centered Resource Label (Brainboard style beneath square card) */}
      <div className="mt-1 flex flex-col items-center max-w-[145px] px-1 pointer-events-none">
        <span
          className={clsx(
            'text-[11px] font-semibold tracking-tight text-center leading-snug line-clamp-2 select-none',
            selected
              ? 'text-[#0078d4] dark:text-[#50e6ff] font-bold'
              : isLight
              ? 'text-slate-800'
              : 'text-slate-200'
          )}
          title={data.label}
        >
          {data.label}
        </span>
        {Boolean(config.description || config.subtitle) && (
          <span
            className={clsx(
              'text-[9.5px] font-normal tracking-tight text-center leading-tight line-clamp-2 mt-0.5 select-none',
              isLight ? 'text-slate-500' : 'text-slate-400'
            )}
            title={String(config.description || config.subtitle)}
          >
            {String(config.description || config.subtitle)}
          </span>
        )}
      </div>
    </div>
  );
});

CloudNode.displayName = 'CloudNode';
export default CloudNode;

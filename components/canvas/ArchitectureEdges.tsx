'use client';
import React, { memo } from 'react';
import { EdgeProps, getSmoothStepPath, getBezierPath } from 'reactflow';

// ── Generic Badge Renderer ────────────────────────────────────────────────────
function EdgeBadge({
  x,
  y,
  label,
  stroke,
  textColor,
  bgColor,
  badgeWidth,
}: {
  x: number;
  y: number;
  label: string;
  stroke: string;
  textColor?: string;
  bgColor?: string;
  badgeWidth?: number;
}) {
  const textStr = String(label);
  const width = badgeWidth || Math.max(48, textStr.length * 6.8 + 18);
  const height = 20;
  return (
    <g transform={`translate(${x}, ${y})`} className="pointer-events-none select-none">
      <rect
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx={10}
        fill={bgColor || 'var(--edge-badge-bg, #0F172A)'}
        stroke={stroke}
        strokeWidth={1.2}
        className="filter drop-shadow-sm transition-colors"
      />
      <text
        className="text-[10px] font-mono font-semibold"
        fill={textColor || 'var(--edge-badge-text, #E2E8F0)'}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {textStr}
      </text>
    </g>
  );
}

// ── 1. Network Flow Edge (Solid Cyan with flow particles) ──────────────────────
export const TrafficEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#38BDF8', // Cyan-400
          strokeWidth: 2,
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      {/* Animated particle flow */}
      <circle r="3" fill="#38BDF8">
        <animateMotion dur="2.5s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#38BDF8" />}
    </>
  );
});
TrafficEdge.displayName = 'TrafficEdge';
export const NetworkFlowEdge = TrafficEdge;

// ── 2. Data Flow Edge (Cyan/Teal dashed with directional stream) ───────────────
export const DataFlowEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#06B6D4', // Cyan-500
          strokeWidth: 2,
          strokeDasharray: '6, 3',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      <circle r="3" fill="#22D3EE">
        <animateMotion dur="1.8s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#06B6D4" />}
    </>
  );
});
DataFlowEdge.displayName = 'DataFlowEdge';

// ── 3. Load Balances Edge (Purple/Violet flow) ─────────────────────────────────
export const LoadBalancesEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#818CF8', // Indigo-400
          strokeWidth: 2,
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      <circle r="3.5" fill="#818CF8">
        <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#818CF8" />}
    </>
  );
});
LoadBalancesEdge.displayName = 'LoadBalancesEdge';

// ── 4. Connects To / Database Connection Edge (Emerald Green Flow) ─────────────
export const ConnectsToEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#10B981', // Emerald-500
          strokeWidth: 2,
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      <circle r="3" fill="#10B981">
        <animateMotion dur="2.8s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#10B981" />}
    </>
  );
});
ConnectsToEdge.displayName = 'ConnectsToEdge';
export const DatabaseConnectionEdge = ConnectsToEdge;

// ── 5. Stores In Edge (Teal Storage / S3 / Blob Flow) ──────────────────────────
export const StoresInEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#14B8A6', // Teal-500
          strokeWidth: 1.8,
          strokeDasharray: '6, 3',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      <circle r="3" fill="#14B8A6">
        <animateMotion dur="3.5s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#14B8A6" />}
    </>
  );
});
StoresInEdge.displayName = 'StoresInEdge';

// ── 6. Resolves To Edge (Sky Blue DNS Resolution) ──────────────────────────────
export const ResolvesToEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#38BDF8',
          strokeWidth: 1.8,
          strokeDasharray: '4, 4',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#38BDF8" />}
    </>
  );
});
ResolvesToEdge.displayName = 'ResolvesToEdge';

// ── 7. Association / Dependency Edge (Slate Security / Policy Attachment) ─────
export const AssociationEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#94A3B8', // Slate-400
          strokeWidth: 1.5,
          strokeDasharray: '4, 4',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#94A3B8" />}
    </>
  );
});
AssociationEdge.displayName = 'AssociationEdge';
export const AssociatedWithEdge = AssociationEdge;
export const DependencyEdge = AssociationEdge;

// ── 8. Replication Edge (Amber Sync Double-Pulse) ──────────────────────────────
export const ReplicationEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#F59E0B', // Amber-500
          strokeWidth: 2,
          strokeDasharray: '8, 4',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      <circle r="3.5" fill="#F59E0B">
        <animateMotion dur="2.2s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#F59E0B" />}
    </>
  );
});
ReplicationEdge.displayName = 'ReplicationEdge';

// ── 9. Cross-Cloud Edge (Bold Amber/Gold Bridge) ───────────────────────────────
export const CrossCloudEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label = 'Cross-Cloud Tunnel',
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#F59E0B',
          strokeWidth: 2.5,
          strokeDasharray: '6, 4',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      <circle r="3.5" fill="#F59E0B">
        <animateMotion dur="2.5s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#F59E0B" />}
    </>
  );
});
CrossCloudEdge.displayName = 'CrossCloudEdge';

// ── 10. Unknown / Error Relationship Edge (Rose/Red Alert Edge) ────────────────
export const UnknownRelationshipEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label = 'UNKNOWN RELATIONSHIP',
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <>
      <path
        id={id}
        style={{
          ...style,
          stroke: '#F43F5E', // Rose-500
          strokeWidth: 2,
          strokeDasharray: '5, 5',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      <EdgeBadge
        x={labelX}
        y={labelY}
        label={label ? `⚠ ${label}` : '⚠ UNKNOWN RELATIONSHIP'}
        stroke="#F43F5E"
        textColor="#FECDD3"
        bgColor="#4C0519"
      />
    </>
  );
});
UnknownRelationshipEdge.displayName = 'UnknownRelationshipEdge';

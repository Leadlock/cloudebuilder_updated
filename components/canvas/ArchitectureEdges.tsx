'use client';
import React, { memo } from 'react';
import { EdgeProps, getSmoothStepPath, getBezierPath } from 'reactflow';

// ── Generic Badge Renderer ────────────────────────────────────────────────────
function EdgeBadge({
  x,
  y,
  label,
  stroke,
  textColor = '#E2E8F0',
  bgColor = '#0F172A',
}: {
  x: number;
  y: number;
  label: string;
  stroke: string;
  textColor?: string;
  bgColor?: string;
}) {
  const textStr = String(label);
  const width = Math.max(40, textStr.length * 7 + 16);
  const height = 18;
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx={9}
        fill={bgColor}
        stroke={stroke}
        strokeWidth={1}
        className="filter drop-shadow-md"
      />
      <text
        className="text-[10px] font-mono font-semibold"
        fill={textColor}
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
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#38BDF8" textColor="#7DD3FC" />}
    </>
  );
});
TrafficEdge.displayName = 'TrafficEdge';

export const NetworkFlowEdge = TrafficEdge;

// ── 2. Load Balances Edge (Purple/Violet flow) ─────────────────────────────────
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
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#818CF8" textColor="#C7D2FE" />}
    </>
  );
});
LoadBalancesEdge.displayName = 'LoadBalancesEdge';

// ── 3. Connects To Edge (Emerald Green Database / TCP Flow) ───────────────────
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
        <animateMotion dur="3s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#10B981" textColor="#6EE7B7" />}
    </>
  );
});
ConnectsToEdge.displayName = 'ConnectsToEdge';

// ── 4. Stores In Edge (Teal Storage / S3 Flow) ─────────────────────────────────
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
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#14B8A6" textColor="#5EEAD4" />}
    </>
  );
});
StoresInEdge.displayName = 'StoresInEdge';

// ── 5. Resolves To Edge (Sky Blue DNS Resolution) ──────────────────────────────
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
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#38BDF8" textColor="#BAE6FD" />}
    </>
  );
});
ResolvesToEdge.displayName = 'ResolvesToEdge';

// ── 6. Association Edge (Slate Security / WAF / Policy Attachment) ─────────────
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
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#64748B" textColor="#CBD5E1" />}
    </>
  );
});
AssociationEdge.displayName = 'AssociationEdge';

export const AssociatedWithEdge = AssociationEdge;

// ── 7. Replication Edge (Amber Sync Double-Pulse) ──────────────────────────────
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
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#F59E0B" textColor="#FDE68A" />}
    </>
  );
});
ReplicationEdge.displayName = 'ReplicationEdge';

// ── 8. Cross-Cloud Edge (Bold Amber/Gold Bridge) ───────────────────────────────
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
      {label && <EdgeBadge x={labelX} y={labelY} label={label as string} stroke="#F59E0B" textColor="#FEF08A" />}
    </>
  );
});
CrossCloudEdge.displayName = 'CrossCloudEdge';

'use client';
import React, { memo } from 'react';
import { EdgeProps, getSmoothStepPath, getBezierPath } from 'reactflow';

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
      {/* Animated subtle particle flow */}
      <circle r="3" fill="#38BDF8">
        <animateMotion dur="2.5s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && (
        <text
          x={labelX}
          y={labelY}
          className="fill-slate-300 text-[10px] font-mono font-medium"
          textAnchor="middle"
          dominantBaseline="central"
        >
          {label}
        </text>
      )}
    </>
  );
});
TrafficEdge.displayName = 'TrafficEdge';

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
          stroke: '#64748B', // Slate-500
          strokeWidth: 1.5,
          strokeDasharray: '4, 4',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      {label && (
        <text
          x={labelX}
          y={labelY}
          className="fill-slate-400 text-[9px] font-mono"
          textAnchor="middle"
          dominantBaseline="central"
        >
          {label}
        </text>
      )}
    </>
  );
});
AssociationEdge.displayName = 'AssociationEdge';

'use client';
import React, { memo } from 'react';
import { EdgeProps, getSmoothStepPath } from 'reactflow';
import clsx from 'clsx';

// ── Generic Badge Renderer ────────────────────────────────────────────────────
function EdgeBadge({
  x,
  y,
  label,
  stroke,
  textColor,
  bgColor,
  badgeWidth,
  isHighlighted,
}: {
  x: number;
  y: number;
  label: string;
  stroke: string;
  textColor?: string;
  bgColor?: string;
  badgeWidth?: number;
  isHighlighted?: boolean;
}) {
  const textStr = String(label);
  const width = badgeWidth || Math.max(50, textStr.length * 6.6 + 20);
  const height = 20;
  return (
    <g transform={`translate(${Math.round(x)}, ${Math.round(y)})`} className="pointer-events-none select-none">
      {isHighlighted && (
        <rect
          x={-(width + 6) / 2}
          y={-(height + 6) / 2}
          width={width + 6}
          height={height + 6}
          rx={13}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeOpacity={0.6}
          className="animate-pulse"
        />
      )}
      <rect
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx={10}
        fill={bgColor || '#0F172A'}
        stroke={stroke}
        strokeWidth={isHighlighted ? 2.2 : 1.4}
      />
      <text
        className={clsx('text-[10px] font-mono font-bold', isHighlighted && 'font-black tracking-wide')}
        fill={textColor || '#F8FAFC'}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {textStr}
      </text>
    </g>
  );
}

// ── Badge Coordinate Helper with Staggering Support ─────────────────────────
function getBadgeCoords(labelX: number, labelY: number, data?: Record<string, unknown>) {
  const offsetX = (data?.labelOffsetX as number) || 0;
  const offsetY = (data?.labelOffsetY as number) || 0;
  return { x: labelX + offsetX, y: labelY + offsetY };
}

// ── Step Path Calculation with Per-Edge Channel Separation ───────────────────
function useStepEdge(props: EdgeProps) {
  const { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, data } = props;
  const edgeData = data as Record<string, unknown> | undefined;
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
    centerX: edgeData?.centerX as number | undefined,
    centerY: edgeData?.centerY as number | undefined,
    offset: (edgeData?.pathOffset as number | undefined) ?? 16,
  });

  const badgePos = getBadgeCoords(labelX, labelY, edgeData);
  return { edgePath, badgePos };
}

// ── Base Architecture Edge with Hit Area, Aura Glow, and Dimming Support ─────
interface BaseEdgeProps extends EdgeProps {
  strokeColor: string;
  highlightStrokeColor?: string;
  strokeWidth?: number;
  highlightStrokeWidth?: number;
  strokeDasharray?: string;
  glowColor?: string;
  hasParticle?: boolean;
  particleColor?: string;
  particleRadius?: number;
  particleDuration?: string;
  highlightParticleDuration?: string;
  badge?: {
    label: string;
    stroke?: string;
    textColor?: string;
    bgColor?: string;
    badgeWidth?: number;
  };
}

function BaseArchitectureEdge({
  id,
  style = {},
  markerEnd,
  label,
  data,
  selected,
  strokeColor,
  highlightStrokeColor,
  strokeWidth = 2,
  highlightStrokeWidth = 3.5,
  strokeDasharray,
  glowColor,
  hasParticle = false,
  particleColor,
  particleRadius = 3,
  particleDuration = '2.5s',
  highlightParticleDuration = '1.4s',
  badge,
  ...restProps
}: BaseEdgeProps) {
  const { edgePath, badgePos } = useStepEdge({ id, style, markerEnd, label, data, selected, ...restProps } as EdgeProps);
  const edgeData = data as Record<string, unknown> | undefined;

  const isHighlighted = Boolean(selected || edgeData?.isHighlighted);
  const isDimmed = Boolean(edgeData?.isDimmed);

  const activeStroke = isHighlighted ? (highlightStrokeColor || strokeColor) : (style.stroke as string) || strokeColor;
  const activeStrokeWidth = isHighlighted ? highlightStrokeWidth : strokeWidth;
  const activeGlow = glowColor || strokeColor;

  const resolvedBadge = badge || (label ? { label: String(label), stroke: activeStroke } : undefined);

  return (
    <g
      className="react-flow__edge-container"
      style={{
        opacity: isDimmed ? 0.22 : 1,
        transition: 'opacity 0.2s ease-in-out',
      }}
    >
      {/* Invisible wide interaction path for effortless clicking anywhere along the line */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        className="react-flow__edge-interaction cursor-pointer"
        style={{ pointerEvents: 'stroke' }}
      />

      {/* Luminous aura when line is clicked / highlighted */}
      {isHighlighted && (
        <path
          d={edgePath}
          fill="none"
          stroke={activeGlow}
          strokeWidth={activeStrokeWidth + 6}
          strokeOpacity={0.45}
          className="pointer-events-none"
        />
      )}

      {/* Main crisp line path */}
      <path
        id={id}
        style={{
          ...style,
          stroke: activeStroke,
          strokeWidth: activeStrokeWidth,
          strokeDasharray,
        }}
        className="react-flow__edge-path cursor-pointer"
        d={edgePath}
        markerEnd={markerEnd}
      />

      {/* Animated dataflow particle */}
      {hasParticle && (
        <circle
          r={isHighlighted ? particleRadius + 1.5 : particleRadius}
          fill={particleColor || activeStroke}
        >
          <animateMotion
            dur={isHighlighted ? highlightParticleDuration : particleDuration}
            repeatCount="indefinite"
            path={edgePath}
          />
        </circle>
      )}

      {/* Edge label badge */}
      {resolvedBadge && (
        <EdgeBadge
          x={badgePos.x}
          y={badgePos.y}
          label={resolvedBadge.label}
          stroke={resolvedBadge.stroke || activeStroke}
          textColor={resolvedBadge.textColor}
          bgColor={resolvedBadge.bgColor}
          badgeWidth={resolvedBadge.badgeWidth}
          isHighlighted={isHighlighted}
        />
      )}
    </g>
  );
}

// ── 1. Network Flow Edge (Solid Cyan with flow particles) ──────────────────────
export const TrafficEdge = memo((props: EdgeProps) => {
  return (
    <BaseArchitectureEdge
      {...props}
      strokeColor="#38BDF8"
      highlightStrokeColor="#7DD3FC"
      glowColor="#38BDF8"
      strokeWidth={2}
      highlightStrokeWidth={3.5}
      hasParticle={true}
      particleColor="#38BDF8"
      particleRadius={3}
      particleDuration="2.5s"
      highlightParticleDuration="1.4s"
    />
  );
});
TrafficEdge.displayName = 'TrafficEdge';
export const NetworkFlowEdge = TrafficEdge;

// ── 2. Data Flow Edge (Green when healthy, Red when needs manual config) ───────
export const DataFlowEdge = memo((props: EdgeProps) => {
  const edgeData = props.data as Record<string, unknown> | undefined;
  const isInvalid = edgeData?.validationStatus === 'invalid' || edgeData?.needsManualConfig === true;
  const baseColor = isInvalid ? '#F43F5E' : '#10B981';
  const highlightColor = isInvalid ? '#FB7185' : '#34D399';
  const defaultLabel = isInvalid ? '⚠ Needs Config' : 'Active Flow';

  return (
    <BaseArchitectureEdge
      {...props}
      strokeColor={baseColor}
      highlightStrokeColor={highlightColor}
      glowColor={baseColor}
      strokeWidth={isInvalid ? 2.2 : 2}
      highlightStrokeWidth={3.6}
      strokeDasharray={isInvalid ? '5, 5' : '6, 3'}
      hasParticle={true}
      particleColor={highlightColor}
      particleRadius={isInvalid ? 3.5 : 3}
      particleDuration={isInvalid ? '1.2s' : '1.8s'}
      highlightParticleDuration="1.1s"
      badge={{
        label: (props.label as string) || defaultLabel,
        stroke: baseColor,
        textColor: isInvalid ? '#FECDD3' : '#ECFDF5',
        bgColor: isInvalid ? '#4C0519' : '#064E3B',
      }}
    />
  );
});
DataFlowEdge.displayName = 'DataFlowEdge';

// ── 3. Load Balances Edge (Purple/Violet flow) ─────────────────────────────────
export const LoadBalancesEdge = memo((props: EdgeProps) => {
  return (
    <BaseArchitectureEdge
      {...props}
      strokeColor="#818CF8"
      highlightStrokeColor="#A5B4FC"
      glowColor="#818CF8"
      strokeWidth={2}
      highlightStrokeWidth={3.5}
      hasParticle={true}
      particleColor="#818CF8"
      particleRadius={3.5}
      particleDuration="2s"
      highlightParticleDuration="1.2s"
    />
  );
});
LoadBalancesEdge.displayName = 'LoadBalancesEdge';

// ── 4. Connects To / Database Connection Edge (Emerald Green Flow) ─────────────
export const ConnectsToEdge = memo((props: EdgeProps) => {
  return (
    <BaseArchitectureEdge
      {...props}
      strokeColor="#10B981"
      highlightStrokeColor="#34D399"
      glowColor="#10B981"
      strokeWidth={2}
      highlightStrokeWidth={3.5}
      hasParticle={true}
      particleColor="#10B981"
      particleRadius={3}
      particleDuration="2.8s"
      highlightParticleDuration="1.5s"
    />
  );
});
ConnectsToEdge.displayName = 'ConnectsToEdge';
export const DatabaseConnectionEdge = ConnectsToEdge;

// ── 5. Stores In Edge (Teal Storage / S3 / Blob Flow) ──────────────────────────
export const StoresInEdge = memo((props: EdgeProps) => {
  return (
    <BaseArchitectureEdge
      {...props}
      strokeColor="#14B8A6"
      highlightStrokeColor="#2DD4BF"
      glowColor="#14B8A6"
      strokeWidth={1.8}
      highlightStrokeWidth={3.2}
      strokeDasharray="6, 3"
      hasParticle={true}
      particleColor="#14B8A6"
      particleRadius={3}
      particleDuration="3.5s"
      highlightParticleDuration="1.8s"
    />
  );
});
StoresInEdge.displayName = 'StoresInEdge';

// ── 6. Resolves To Edge (Sky Blue DNS Resolution) ──────────────────────────────
export const ResolvesToEdge = memo((props: EdgeProps) => {
  return (
    <BaseArchitectureEdge
      {...props}
      strokeColor="#38BDF8"
      highlightStrokeColor="#7DD3FC"
      glowColor="#38BDF8"
      strokeWidth={1.8}
      highlightStrokeWidth={3.2}
      strokeDasharray="4, 4"
      hasParticle={false}
    />
  );
});
ResolvesToEdge.displayName = 'ResolvesToEdge';

// ── 7. Association / Dependency Edge (Slate Security / Policy Attachment) ─────
export const AssociationEdge = memo((props: EdgeProps) => {
  return (
    <BaseArchitectureEdge
      {...props}
      strokeColor="#94A3B8"
      highlightStrokeColor="#CBD5E1"
      glowColor="#94A3B8"
      strokeWidth={1.5}
      highlightStrokeWidth={3.0}
      strokeDasharray="4, 4"
      hasParticle={false}
    />
  );
});
AssociationEdge.displayName = 'AssociationEdge';
export const AssociatedWithEdge = AssociationEdge;
export const DependencyEdge = AssociationEdge;

// ── 8. Replication Edge (Amber Sync Double-Pulse) ──────────────────────────────
export const ReplicationEdge = memo((props: EdgeProps) => {
  return (
    <BaseArchitectureEdge
      {...props}
      strokeColor="#F59E0B"
      highlightStrokeColor="#FBBF24"
      glowColor="#F59E0B"
      strokeWidth={2}
      highlightStrokeWidth={3.5}
      strokeDasharray="8, 4"
      hasParticle={true}
      particleColor="#F59E0B"
      particleRadius={3.5}
      particleDuration="2.2s"
      highlightParticleDuration="1.2s"
    />
  );
});
ReplicationEdge.displayName = 'ReplicationEdge';

// ── 9. Cross-Cloud Edge (Bold Amber/Gold Bridge) ───────────────────────────────
export const CrossCloudEdge = memo((props: EdgeProps) => {
  return (
    <BaseArchitectureEdge
      {...props}
      label={props.label || 'Cross-Cloud Tunnel'}
      strokeColor="#F59E0B"
      highlightStrokeColor="#FBBF24"
      glowColor="#F59E0B"
      strokeWidth={2.5}
      highlightStrokeWidth={4.0}
      strokeDasharray="6, 4"
      hasParticle={true}
      particleColor="#F59E0B"
      particleRadius={3.5}
      particleDuration="2.5s"
      highlightParticleDuration="1.3s"
    />
  );
});
CrossCloudEdge.displayName = 'CrossCloudEdge';

// ── 10. Unknown / Error Relationship Edge (Rose/Red Alert Edge) ────────────────
export const UnknownRelationshipEdge = memo((props: EdgeProps) => {
  const customLabel = props.label ? `⚠ ${props.label}` : '⚠ UNKNOWN RELATIONSHIP';
  return (
    <BaseArchitectureEdge
      {...props}
      strokeColor="#F43F5E"
      highlightStrokeColor="#FB7185"
      glowColor="#F43F5E"
      strokeWidth={2}
      highlightStrokeWidth={3.5}
      strokeDasharray="5, 5"
      hasParticle={false}
      badge={{
        label: customLabel,
        stroke: '#F43F5E',
        textColor: '#FECDD3',
        bgColor: '#4C0519',
      }}
    />
  );
});
UnknownRelationshipEdge.displayName = 'UnknownRelationshipEdge';

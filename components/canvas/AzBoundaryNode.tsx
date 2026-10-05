'use client';
import { memo } from 'react';
import { NodeProps } from 'reactflow';
import { useApp } from '@/context/AppContext';

export interface AzBoundaryNodeData {
  label: string;
  width: number;
  height: number;
}

/**
 * Purely visual grouping overlay drawn behind subnets that share the same
 * Availability Zone within a VPC/VNet. This is NOT a canonical resource: it
 * carries no id in the persisted architecture, is never sent to the backend,
 * never appears in Terraform generation, and has no bearing on containment
 * validation — groupId/containment for real resources is untouched. It is
 * computed at render time in InfraCanvas from each subnet's existing
 * config.availabilityZone field purely to make multi-AZ layouts visually
 * legible, per the "no separate competing representation" rule: this reads
 * from the canonical model, it never becomes a second one.
 */
const AzBoundaryNode = memo(({ data }: NodeProps<AzBoundaryNodeData>) => {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  return (
    <div
      style={{ width: data.width, height: data.height }}
      className={`relative rounded-3xl border-2 border-dashed pointer-events-none select-none ${
        isLight ? 'border-amber-300/80 bg-amber-500/[0.04]' : 'border-amber-500/30 bg-amber-500/[0.03]'
      }`}
    >
      <div className={`absolute -top-3 left-4 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${
        isLight ? 'bg-white border-amber-300 text-amber-800 shadow-sm' : 'bg-slate-950 border-amber-500/40 text-amber-400/90'
      }`}>
        {data.label}
      </div>
    </div>
  );
});

AzBoundaryNode.displayName = 'AzBoundaryNode';
export default AzBoundaryNode;

'use client';
import React, { useMemo } from 'react';
import { ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';
import { evaluateOrgPolicy } from '@/lib/engines/policy/evaluate';
import type { CanvasNode } from '@/types';
import { useOrgPolicy } from './orgPolicyStore';

/** The organization-policy warnings for one resource. Renders nothing when the policy is empty or the resource complies. */
export default function PolicyWarnings({ node }: { node: CanvasNode }) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const { policy } = useOrgPolicy(state.currentUser?.id);

  const violations = useMemo(
    () => evaluateOrgPolicy([{ id: node.id, label: node.label, resourceType: node.resourceType, region: node.region, config: node.config }], policy),
    [node, policy],
  );
  if (violations.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="policy-warnings"
      className={clsx('mx-3 mt-3 rounded-lg border px-3 py-2 text-[11px]', isLight ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-amber-950/40 border-amber-500/40 text-amber-200')}
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
        {violations.length === 1 ? '1 organization policy warning' : `${violations.length} organization policy warnings`}
      </p>
      <ul className="mt-1.5 space-y-1.5 list-disc pl-4">
        {violations.map((v, i) => (
          <li key={`${v.ruleId}-${i}`}>
            <span>{v.message}</span>
            <span className={clsx('block opacity-80')}>Policy: {v.expected}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

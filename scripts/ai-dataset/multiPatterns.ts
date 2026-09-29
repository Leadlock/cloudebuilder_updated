/**
 * Multi-cloud blueprints: an AWS stack and an Azure stack, each produced by its own
 * single-cloud blueprint (so each half keeps that provider's security posture), joined by
 * the cross-cloud connections the relationship engine accepts (compute ↔ compute, DNS →
 * entry point).
 */
import type { ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { awsThreeTier } from './awsPatterns';
import { azureThreeTier } from './azurePatterns';
import type { Requirements } from './requirements';

const cap = (s: string) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Rename every id in a spec so two specs can be merged without collisions. */
function prefixed(spec: ArchitectureSpec, p: string): ArchitectureSpec {
  return {
    ...spec,
    resources: spec.resources.map((r) => ({ ...r, id: p + r.id, ...(r.parent ? { parent: p + r.parent } : {}) })),
    connections: spec.connections.map((c) => ({ ...c, from: p + c.from, to: p + c.to })),
  };
}

function compose(r: Requirements, mode: 'dr' | 'active'): ArchitectureSpec {
  const regionB = r.regionB ?? 'westeurope';
  const aws = prefixed(awsThreeTier({ ...r, provider: 'aws', pattern: 'aws-three-tier', queue: false, cdn: false }), 'aws-');
  const azureReq: Requirements = mode === 'dr'
    ? { ...r, provider: 'azure', pattern: 'azure-three-tier', region: regionB, scale: 'small', cache: false, cdn: false, queue: false }
    : { ...r, provider: 'azure', pattern: 'azure-three-tier', region: regionB, cache: r.cache, cdn: false, queue: false };
  const azure = prefixed(azureThreeTier(azureReq), 'az-');
  const connections = [
    ...aws.connections, ...azure.connections,
    // DNS health-checked failover / weighted routing to the Azure entry point.
    { from: 'aws-r53', to: 'az-agw', label: mode === 'dr' ? 'Failover record (health-checked)' : 'Weighted routing' },
    // The relationship engine accepts cross-cloud compute → storage; the Azure tier syncs objects with S3.
    { from: 'az-vmss', to: 'aws-assets', label: mode === 'dr' ? 'Asset replication (DR copy)' : 'Asset synchronisation' },
  ];
  const lead = mode === 'dr'
    ? 'AWS runs production; a scaled-down Azure stack stands by and keeps a copy of the assets in sync. Route 53 health checks fail traffic over to the Azure Application Gateway.'
    : 'Route 53 splits traffic between an AWS stack and an Azure stack that run the same workload; the Azure tier synchronises shared assets with S3.';
  return {
    name: `${cap(r.app)} — ${mode === 'dr' ? 'AWS primary with Azure DR' : 'active-active across AWS and Azure'}`,
    summary: `${lead} Sized for the ${r.scale} tier; AWS in ${r.region}, Azure in ${regionB}.${r.regulated ? ' Regulated-workload posture applied on both clouds.' : ''}`,
    resources: [...aws.resources, ...azure.resources],
    connections,
  };
}

export const multiAwsAzureDr = (r: Requirements) => compose(r, 'dr');
export const multiActiveActive = (r: Requirements) => compose(r, 'active');

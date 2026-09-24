/**
 * Provider-specific Well-Architected pillar sets. AWS has six pillars; the
 * Azure Well-Architected Framework has five. Azure results are never
 * expressed in AWS pillar terms (and vice versa).
 */
import { AWS_PILLARS, AZURE_PILLARS } from '@/lib/engines/wellArchitected/frameworkDefinitions';
import type { AssessmentProvider, WaPillarId } from './types';

export interface PillarInfo { id: WaPillarId; label: string; referenceUrl: string }

export function pillarsFor(provider: AssessmentProvider): PillarInfo[] {
  const defs = provider === 'aws' ? AWS_PILLARS : AZURE_PILLARS;
  return defs.map((d) => ({ id: d.id as WaPillarId, label: d.label, referenceUrl: d.referenceUrl }));
}

export function frameworkName(provider: AssessmentProvider): string {
  return provider === 'aws' ? 'AWS Well-Architected Framework' : 'Azure Well-Architected Framework';
}

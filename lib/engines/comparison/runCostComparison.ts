/**
 * Prices an architecture on its own cloud and on the other cloud, so the comparison route and the AI insights route compute the
 * same numbers from the same code. The fixed translation table is used first; when AI matching is on, resource types it does not cover
 * are matched to an equivalent by the AI (lib/cost/ai/equivalents.ts) and reported in `aiMatches`.
 */
import { costEstimator, type CostEstimator } from '@/lib/engines/cost/CostEstimator';
import { CloudCostComparisonService } from './CloudCostComparisonService';
import { translateRegion } from '@/lib/cloud/regions/regionEquivalence';
import { translateResourcesWithAi, type AiMatch } from '@/lib/cost/ai/equivalents';
import { askFoundryJson, type AskModel } from '@/lib/cost/ai/askModel';
import { findCostAnomalies, type CostAnomaly } from '@/lib/cost/ai/plausibility';
import type { CostEstimationResult } from '@/lib/engines/cost/types';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

export interface CostComparisonRun {
  currentProvider: 'aws' | 'azure';
  targetProvider: 'aws' | 'azure';
  current: CostEstimationResult;
  translated: CostEstimationResult;
  targetCurrency: string;
  /** Resources whose other-cloud equivalent was chosen by the AI rather than the fixed table. */
  aiMatches: AiMatch[];
  /** Lines whose price is implausibly high (see lib/cost/ai/plausibility.ts). Computed in code, always. */
  anomalies: { current: CostAnomaly[]; translated: CostAnomaly[] };
  /** The other-cloud resources that were priced. */
  translatedResources: DbArchitectureResource[];
}

export async function runCostComparison(args: {
  architectureId: string;
  projectId: string;
  versionId?: string;
  resources: DbArchitectureResource[];
  projectRegion?: string;
  targetCurrency: string;
  aiMatching: boolean;
  ask?: AskModel;
  estimator?: Pick<CostEstimator, 'estimateAsync'>;
}): Promise<CostComparisonRun> {
  const estimator = args.estimator ?? costEstimator;
  const { resources } = args;
  const currentProvider = (resources.length > 0 ? resources[0]!.provider : 'aws') as 'aws' | 'azure';
  const targetProvider = currentProvider === 'aws' ? 'azure' : 'aws';

  let translatedResources: DbArchitectureResource[];
  let aiMatches: AiMatch[] = [];
  if (args.aiMatching) {
    const r = await translateResourcesWithAi(resources, targetProvider, args.ask ?? askFoundryJson);
    translatedResources = r.resources;
    aiMatches = r.matches;
  } else {
    translatedResources = CloudCostComparisonService.translateResources(resources, targetProvider);
  }

  const base = { architectureId: args.architectureId, projectId: args.projectId, versionId: args.versionId, targetCurrency: args.targetCurrency };
  const current = await estimator.estimateAsync({ ...base, resources, defaultRegion: args.projectRegion }, 'REAL');
  const translated = await estimator.estimateAsync({
    ...base,
    resources: translatedResources,
    // The translated side must default to the geographic equivalent of THIS project's region, not an unconditional us-east-1/eastus.
    defaultRegion: translateRegion(args.projectRegion, currentProvider, targetProvider),
  }, 'REAL');

  return {
    currentProvider, targetProvider, current, translated, targetCurrency: args.targetCurrency, aiMatches,
    anomalies: { current: findCostAnomalies(current.items), translated: findCostAnomalies(translated.items) },
    translatedResources,
  };
}

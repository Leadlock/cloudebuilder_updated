/**
 * WellArchitectedFrameworkService
 *
 * Runs the design-time assessment (lib/engines/assessment) through the AWS, Azure or combined Well-Architected lens.
 * Every assessment says it is a design-time assessment: nothing here reads a live cloud account.
 */
import type { WaAssessment, WaAnalysisInput } from './types';
import { WellArchitectedRuleEngine } from './WellArchitectedRuleEngine';

const ruleEngine = new WellArchitectedRuleEngine();

export class WellArchitectedFrameworkService {
  /**
   * Design-time analysis of the persisted architecture, presented through the AWS (six pillars), Azure (five) or both frameworks.
   * This is the only source. An earlier version also had providers for the AWS Well-Architected Tool and Azure Advisor, but nothing
   * ever called them and the AWS one reported one workload-wide risk count for every pillar, so they were removed rather than left to be
   * switched on by mistake.
   */
  async analyzeDesignTime(input: WaAnalysisInput): Promise<WaAssessment> {
    const provider = this._detectProvider(input);

    if (provider === 'multi') {
      return ruleEngine.analyzeMultiCloud(input);
    }
    if (provider === 'azure') {
      return ruleEngine.analyzeAzure(input);
    }
    return ruleEngine.analyzeAws(input);
  }

  private _detectProvider(input: WaAnalysisInput): 'aws' | 'azure' | 'multi' {
    const hasAws = input.resources.some((r) => r.provider === 'aws');
    const hasAzure = input.resources.some((r) => r.provider === 'azure');
    if (hasAws && hasAzure) return 'multi';
    if (hasAzure) return 'azure';
    return 'aws';
  }
}

export const wellArchitectedFrameworkService = new WellArchitectedFrameworkService();

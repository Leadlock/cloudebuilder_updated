/**
 * WellArchitectedFrameworkService
 *
 * Orchestration service that coordinates design-time analysis and,
 * where credentials are available, live cloud provider intelligence.
 *
 * Design-time analysis is ALWAYS available.
 * Live integration (AWS WAF Tool / Azure Advisor) requires valid cloud accounts.
 * Source attribution is on every assessment — never claim live intelligence
 * when it is unavailable.
 */
import type { WaAssessment, WaAnalysisInput } from './types';
import { WellArchitectedRuleEngine } from './WellArchitectedRuleEngine';
import type { AwsWellArchitectedProvider } from './providers/AwsWellArchitectedProvider';
import type { AzureAdvisorProvider } from './providers/AzureAdvisorProvider';

const ruleEngine = new WellArchitectedRuleEngine();

export class WellArchitectedFrameworkService {

  private awsProvider?: AwsWellArchitectedProvider;
  private azureProvider?: AzureAdvisorProvider;

  constructor(opts?: {
    awsProvider?: AwsWellArchitectedProvider;
    azureProvider?: AzureAdvisorProvider;
  }) {
    this.awsProvider = opts?.awsProvider;
    this.azureProvider = opts?.azureProvider;
  }

  /**
   * Design-time analysis — always available, no credentials required.
   * Deterministic: same input → same output.
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

  /**
   * Attempt live AWS Well-Architected Tool assessment.
   * Returns null if credentials are missing or permissions are insufficient.
   * Never throws — logs the reason and falls back to null.
   */
  async fetchAwsLiveAssessment(
    cloudAccountId: string,
    projectId: string,
    architectureId: string,
  ): Promise<WaAssessment | null> {
    if (!this.awsProvider) {
      console.info('[WellArchitected] AWS provider not configured — skipping live AWS WAF assessment');
      return null;
    }
    try {
      return await this.awsProvider.fetchAssessment(cloudAccountId, projectId, architectureId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[WellArchitected] AWS live assessment unavailable: ${msg}`);
      return null;
    }
  }

  /**
   * Attempt live Azure Advisor assessment.
   * Returns null if credentials are missing or permissions are insufficient.
   * Never throws — logs the reason and falls back to null.
   */
  async fetchAzureLiveAssessment(
    cloudAccountId: string,
    projectId: string,
    architectureId: string,
  ): Promise<WaAssessment | null> {
    if (!this.azureProvider) {
      console.info('[WellArchitected] Azure provider not configured — skipping live Azure Advisor assessment');
      return null;
    }
    try {
      return await this.azureProvider.fetchAssessment(cloudAccountId, projectId, architectureId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[WellArchitected] Azure live assessment unavailable: ${msg}`);
      return null;
    }
  }

  /**
   * Merge design-time and live assessments.
   * If live data is available, it takes precedence for findings.
   * Design-time findings supplement live data where live coverage is incomplete.
   */
  mergeAssessments(designTime: WaAssessment, live: WaAssessment | null): WaAssessment {
    if (!live) return designTime;

    // Live assessment wins on score and source label
    // Supplement live findings with design-time findings not covered by live
    const liveRuleIds = new Set(live.findings.map((f) => f.ruleId));
    const supplementalFindings = designTime.findings.filter((f) => !liveRuleIds.has(f.ruleId));

    const mergedFindings = [
      ...live.findings,
      ...supplementalFindings,
    ];

    return {
      ...live,
      findings: mergedFindings,
      sourceLabel: `${live.sourceLabel} + design-time supplemental`,
    };
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

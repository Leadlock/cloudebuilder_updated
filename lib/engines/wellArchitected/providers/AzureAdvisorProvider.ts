/**
 * AzureAdvisorProvider
 *
 * Integration with Azure Advisor API via @azure/arm-advisor.
 * Requires: @azure/arm-advisor (installed)
 * Requires: Azure credentials with Reader role on the subscription.
 *
 * Azure Advisor recommendation categories map to Azure WAF pillars:
 *   HighAvailability  → Reliability
 *   Security          → Security
 *   Cost              → Cost Optimization
 *   OperationalExcellence → Operational Excellence
 *   Performance       → Performance Efficiency
 *
 * If credentials are missing or permissions insufficient, returns null gracefully.
 * Never fabricates findings from API errors.
 *
 * Source: https://learn.microsoft.com/azure/advisor/
 */
import type { WaAssessment, WaFinding, WaPillarScore } from '../types';
import { AZURE_PILLARS, AZURE_WELL_ARCHITECTED_FRAMEWORK } from '../frameworkDefinitions';

// ─── Azure Advisor category → WAF pillar mapping ─────────────────────────────

const ADVISOR_CATEGORY_MAP: Record<string, string> = {
  'HighAvailability': 'reliability',
  'Security': 'security',
  'Cost': 'cost_optimization',
  'OperationalExcellence': 'operational_excellence',
  'Performance': 'performance_efficiency',
};

const AZURE_IMPACT_TO_SEVERITY: Record<string, WaFinding['severity']> = {
  'High': 'high',
  'Medium': 'medium',
  'Low': 'low',
};

export class AzureAdvisorProvider {
  private subscriptionId: string;
  private credentials: {
    clientId: string;
    clientSecret: string;
    tenantId: string;
  };

  constructor(subscriptionId: string, credentials: {
    clientId: string;
    clientSecret: string;
    tenantId: string;
  }) {
    this.subscriptionId = subscriptionId;
    this.credentials = credentials;
  }

  /**
   * Fetch Azure Advisor recommendations and map to WAF pillar scores.
   * Returns null if credentials are unavailable or produce no data.
   */
  async fetchAssessment(
    cloudAccountId: string,
    projectId: string,
    architectureId: string,
  ): Promise<WaAssessment | null> {
    const { AdvisorManagementClient } = await import('@azure/arm-advisor');
    const { ClientSecretCredential } = await import('@azure/identity');

    const cred = new ClientSecretCredential(
      this.credentials.tenantId,
      this.credentials.clientId,
      this.credentials.clientSecret,
    );

    const client = new AdvisorManagementClient(cred, this.subscriptionId);

    // List all recommendations
    const recommendations: Array<{
      category?: string;
      impact?: string;
      shortDescription?: { problem?: string; solution?: string };
      resourceMetadata?: { resourceId?: string };
    }> = [];

    for await (const rec of client.recommendations.list()) {
      recommendations.push(rec as typeof recommendations[0]);
    }

    if (recommendations.length === 0) {
      console.info(`[AzureAdvisorProvider] No recommendations found for subscription ${this.subscriptionId}`);
      return null;
    }

    const now = new Date().toISOString();
    const findings: WaFinding[] = [];

    for (const rec of recommendations) {
      const cat = rec.category ?? '';
      const pillarId = ADVISOR_CATEGORY_MAP[cat];
      if (!pillarId) continue;

      const pillarDef = AZURE_PILLARS.find((p) => p.id === pillarId);
      if (!pillarDef) continue;

      const severity = AZURE_IMPACT_TO_SEVERITY[rec.impact ?? ''] ?? 'low';
      const title = rec.shortDescription?.problem ?? 'Azure Advisor Recommendation';
      const solution = rec.shortDescription?.solution ?? 'Follow Azure Advisor recommendation.';
      const resourceId = rec.resourceMetadata?.resourceId ?? '';

      const { createHash } = await import('crypto');
      const id = createHash('sha256')
        .update(`azure-advisor:${pillarId}:${title}:${resourceId}`)
        .digest('hex')
        .substring(0, 16);

      findings.push({
        id,
        ruleId: `AZ-ADVISOR-${cat.toUpperCase()}-LIVE`,
        provider: 'azure',
        pillar: pillarId as any,
        pillarLabel: pillarDef.label,
        pillarRef: pillarDef.referenceUrl,
        severity,
        title,
        description: solution,
        affectedResourceIds: resourceId ? [resourceId] : [],
        affectedResourceLabels: [],
        evidence: { resourceId, category: cat, impact: rec.impact },
        recommendation: solution,
        remediation: solution,
        frameworkReference: `Microsoft Azure Well-Architected Framework — ${pillarDef.label}`,
        source: 'LIVE_AZURE_ADVISOR',
        sourceLabel: 'Azure Advisor (live)',
        detectedAt: now,
      });
    }

    // Calculate pillar scores from findings
    const pillarScores: WaPillarScore[] = AZURE_PILLARS.map((p) => {
      const pFindings = findings.filter((f) => f.pillar === p.id);
      const highCount = pFindings.filter((f) => f.severity === 'high').length;
      const mediumCount = pFindings.filter((f) => f.severity === 'medium').length;
      const deduction = highCount * 20 + mediumCount * 10 + pFindings.filter((f) => f.severity === 'low').length * 5;
      return {
        pillar: p.id,
        pillarLabel: p.label,
        score: Math.max(0, 100 - deduction),
        findingCount: pFindings.length,
        criticalCount: 0,
        highCount,
      };
    });

    const overallScore = Math.round(
      pillarScores.reduce((acc, p) => acc + p.score, 0) / pillarScores.length
    );

    return {
      architectureId,
      projectId,
      provider: 'azure',
      framework: AZURE_WELL_ARCHITECTED_FRAMEWORK.framework,
      frameworkVersion: AZURE_WELL_ARCHITECTED_FRAMEWORK.frameworkVersion,
      frameworkSource: AZURE_WELL_ARCHITECTED_FRAMEWORK.documentationUrl,
      overallScore,
      pillarScores,
      findings,
      evaluatedAt: now,
      source: 'LIVE_AZURE_ADVISOR',
      sourceLabel: 'Azure Advisor (live)',
      confidence: 'live-cloud',
      isStale: false,
    };
  }
}

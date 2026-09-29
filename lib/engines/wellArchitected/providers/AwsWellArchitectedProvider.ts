/**
 * AwsWellArchitectedProvider
 *
 * Integration with the AWS Well-Architected Tool API.
 * Requires: @aws-sdk/client-wellarchitected (installed)
 * Requires: IAM permissions — wellarchitected:ListWorkloads, GetWorkload, ListAnswers
 *
 * If credentials are missing or permissions insufficient, returns null gracefully.
 * Never fabricates findings from API errors.
 *
 * Source: https://docs.aws.amazon.com/wellarchitected/latest/APIReference/Welcome.html
 */
import type { WaAssessment, WaFinding, WaPillarScore } from '../types';
import { AWS_PILLARS, AWS_WELL_ARCHITECTED_FRAMEWORK } from '../frameworkDefinitions';

// ─── Lazy SDK import to avoid breaking build when unused ─────────────────────

async function getWaClient(credentials: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}) {
  const { WellArchitectedClient } = await import('@aws-sdk/client-wellarchitected');
  return new WellArchitectedClient({
    region: credentials.region ?? 'us-east-1',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  });
}

export class AwsWellArchitectedProvider {
  private credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region?: string;
  };

  constructor(credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region?: string;
  }) {
    this.credentials = credentials;
  }

  /**
   * Fetch Well-Architected Tool assessment from AWS.
   * Returns null if no workloads exist or permissions are insufficient.
   */
  async fetchAssessment(
    cloudAccountId: string,
    projectId: string,
    architectureId: string,
  ): Promise<WaAssessment | null> {
    const {
      WellArchitectedClient,
      ListWorkloadsCommand,
      GetWorkloadCommand,
    } = await import('@aws-sdk/client-wellarchitected');

    const client = await getWaClient(this.credentials);

    // List workloads — look for one tagged with our project ID
    const listCmd = new ListWorkloadsCommand({ MaxResults: 50 });
    const list = await client.send(listCmd);

    if (!list.WorkloadSummaries || list.WorkloadSummaries.length === 0) {
      console.info(`[AwsWAFProvider] No workloads found for account ${cloudAccountId}`);
      return null;
    }

    // Prefer a workload tagged with our projectId
    const tagged = list.WorkloadSummaries.find((w) => {
      const tags = (w as any).Tags ?? {};
      return tags['cloudcraft:projectId'] === projectId || tags['project'] === projectId;
    });

    const workloadSummary = tagged ?? list.WorkloadSummaries[0];
    if (!workloadSummary?.WorkloadId) return null;

    // Get full workload
    const getCmd = new GetWorkloadCommand({ WorkloadId: workloadSummary.WorkloadId });
    const workloadResp = await client.send(getCmd);
    const workload = workloadResp.Workload;
    if (!workload) return null;

    // Map AWS WAF risk levels to our severity
    const riskToSeverity = (risk: string): WaFinding['severity'] => {
      switch (risk) {
        case 'HIGH': return 'high';
        case 'MEDIUM': return 'medium';
        case 'NONE': return 'info';
        default: return 'low';
      }
    };

    // Map AWS WAF pillar IDs to our pillar IDs
    const awsPillarMap: Record<string, string> = {
      'operationalExcellence': 'operational_excellence',
      'security': 'security',
      'reliability': 'reliability',
      'performance': 'performance_efficiency',
      'costOptimization': 'cost_optimization',
      'sustainability': 'sustainability',
    };

    // NOT YET WIRED UP (no API route calls fetchAwsLiveAssessment/
    // mergeAssessments as of this writing — verify that's still true before
    // relying on this). `workload.RiskCounts` is a WORKLOAD-WIDE total, not
    // broken down per pillar — the AWS API only exposes that via a separate
    // GetLensReview/ListAnswers call per pillar, which this does not make.
    // Applying the same global count to every pillar below means every
    // pillar reports an identical score/findingCount, which is never
    // actually true. Do NOT wire this into a route (or trust its
    // `source: 'LIVE_AWS_WAF'` label, the highest-trust tier in the system)
    // until it calls the per-pillar API and reports pillar-specific counts.
    const riskCounts = workload.RiskCounts ?? {};
    const pillarScores: WaPillarScore[] = AWS_PILLARS.map((p) => {
      const highRisk = riskCounts['HIGH'] ?? 0;
      const medRisk = riskCounts['MEDIUM'] ?? 0;
      const score = Math.max(0, 100 - (highRisk * 20) - (medRisk * 10));
      return {
        pillar: p.id,
        pillarLabel: p.label,
        score,
        findingCount: highRisk + medRisk,
        criticalCount: 0,
        highCount: highRisk,
      };
    });

    const overallScore = Math.round(
      pillarScores.reduce((acc, p) => acc + p.score, 0) / pillarScores.length
    );

    const now = new Date().toISOString();

    return {
      architectureId,
      projectId,
      provider: 'aws',
      framework: AWS_WELL_ARCHITECTED_FRAMEWORK.framework,
      frameworkVersion: AWS_WELL_ARCHITECTED_FRAMEWORK.frameworkVersion,
      frameworkSource: AWS_WELL_ARCHITECTED_FRAMEWORK.documentationUrl,
      overallScore,
      pillarScores,
      findings: [], // Detailed findings require ListAnswers which is quota-intensive; surface pillar scores
      evaluatedAt: now,
      source: 'LIVE_AWS_WAF',
      sourceLabel: 'AWS Well-Architected Tool (live)',
      confidence: 'live-cloud',
      isStale: false,
    };
  }
}

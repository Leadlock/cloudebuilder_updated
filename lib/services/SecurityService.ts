import { CanvasNode, SecurityIssue } from '@/types';
import { runSecurityScan, calculateSecurityScore } from '@/lib/analysis';

import { applyRuleRemediation } from '@/lib/engines/security/remediation';

// ─── Interface ────────────────────────────────────────────────────────────────
export interface ISecurityService {
  scan(nodes: CanvasNode[]): Promise<SecurityIssue[]>;
  score(issues: SecurityIssue[]): number;
  applyFix(nodes: CanvasNode[], nodeId: string, ruleId: string): CanvasNode[];
}

// ─── Mock Implementation ──────────────────────────────────────────────────────
class MockSecurityService implements ISecurityService {
  async scan(nodes: CanvasNode[]): Promise<SecurityIssue[]> {
    // Simulate a short async call (e.g. a real API call in production)
    await Promise.resolve();
    return runSecurityScan(nodes);
  }

  score(issues: SecurityIssue[]): number {
    return calculateSecurityScore(issues);
  }

  applyFix(nodes: CanvasNode[], nodeId: string, ruleId: string): CanvasNode[] {
    return nodes.map((n) => {
      if (n.id !== nodeId) return n;
      return { ...n, config: applyRuleRemediation(n.config, ruleId) };
    });
  }
}

export const securityService: ISecurityService = new MockSecurityService();

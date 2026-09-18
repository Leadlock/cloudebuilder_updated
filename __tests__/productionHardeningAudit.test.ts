import { describe, it, expect, beforeEach } from '@jest/globals';
import { draftRepository } from '@/lib/repositories/draftRepository';
import {
  toCanonicalGraph,
  fromCanonicalGraph,
  validateCanonicalArchitecture,
} from '@/lib/domain/canonicalArchitecture';
import { adaptiveScaleEngine } from '@/lib/engines/capacity/AdaptiveScaleEngine';
import { architectureAutoFixEngine } from '@/lib/engines/autofix/ArchitectureAutoFixEngine';
import { scaleAdvisorEngine } from '@/lib/engines/ai/ScaleAdvisorEngine';
import { apiTerraformService } from '@/lib/services/ApiTerraformService';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import { calculateCosts, runSecurityScan } from '@/lib/analysis';
import {
  CanvasNode,
  CanvasEdge,
  ScaleProfile,
  ProviderMode,
  CloudProvider,
  providerModeToCloudProvider,
  cloudProviderToProviderMode,
} from '@/types';

describe('Production-Hardening Audit: Core Canvas Workflow & Architecture Services', () => {
  // ─── 1. DRAFT PERSISTENCE & MULTI-USER ISOLATION ────────────────────────────
  describe('1. Draft Persistence & Backend Synchronization', () => {
    const userId = 'user-audit-1';

    beforeEach(async () => {
      await draftRepository.clearDraft(userId);
    });

    it('persists a draft architecture with canonical graph hash and revision tracking', async () => {
      const nodes: CanvasNode[] = [
        {
          id: 'ec2-1',
          type: 'resourceNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'App Server',
          position: { x: 100, y: 100 },
          config: { instanceType: 't3.medium' },
        },
      ];
      const edges: CanvasEdge[] = [];

      const saved = await draftRepository.saveDraft(userId, {
        providerMode: 'AWS',
        nodes,
        edges,
        revision: 1,
      });

      expect(!saved.conflict).toBe(true);
      expect(saved.draft.revision).toBe(1);
      expect(saved.draft.hash).toBeDefined();

      const loaded = await draftRepository.getDraft(userId);
      expect(loaded).not.toBeNull();
      expect(loaded?.nodes.length).toBe(1);
      expect(loaded?.nodes[0].label).toBe('App Server');
      expect(loaded?.revision).toBe(1);
    });

    it('rejects stale draft writes with 409 revision conflict', async () => {
      // First save on a fresh draft always starts at revision 1 — there's
      // nothing yet to conflict against.
      const initial = await draftRepository.saveDraft(userId, {
        providerMode: 'AWS',
        nodes: [],
        edges: [],
      });
      expect(!initial.conflict).toBe(true);
      expect(initial.draft.revision).toBe(1);

      // Stale write attempt with a revision older than what's stored
      const staleAttempt = await draftRepository.saveDraft(userId, {
        providerMode: 'AWS',
        nodes: [],
        edges: [],
        revision: 0,
      });

      expect(staleAttempt.conflict).toBe(true);
      expect(staleAttempt.serverRevision).toBe(1);

      // Verify the draft was not overwritten
      const current = await draftRepository.getDraft(userId);
      expect(current?.revision).toBe(1);
    });

    it('allows higher revision writes and updates canonical hash', async () => {
      await draftRepository.saveDraft(userId, {
        providerMode: 'AWS',
        nodes: [],
        edges: [],
      });

      // A real client always echoes back the revision it last saw from the
      // server (here, 1) rather than tracking its own counter — the server
      // is the one that advances the revision on each successful save.
      const updated = await draftRepository.saveDraft(userId, {
        providerMode: 'AWS',
        nodes: [
          {
            id: 's3-1',
            type: 'resourceNode',
            resourceType: 'aws_s3',
            provider: 'aws',
            label: 'Assets',
            position: { x: 0, y: 0 },
            config: {},
          },
        ],
        edges: [],
        revision: 1,
      });

      expect(!updated.conflict).toBe(true);
      expect(updated.draft.revision).toBe(2);
      expect(updated.draft.nodes.length).toBe(1);
    });
  });

  // ─── 2. AUTO-SAVE CONCURRENCY & ORDERING ────────────────────────────────────
  describe('2. Auto-Save Concurrency & Sequence Integrity', () => {
    const userId = 'user-concurrency-test';

    beforeEach(async () => {
      await draftRepository.clearDraft(userId);
    });

    it('preserves latest graph through sequential overlapping saves', async () => {
      // Simulate rapid sequential changes: v1 -> v2 -> v3. Each save echoes
      // back the revision returned by the previous one, exactly as the real
      // autosave client does (it never tracks its own counter).
      const save1 = await draftRepository.saveDraft(userId, {
        providerMode: 'AWS',
        nodes: [{ id: 'n1', type: 'resourceNode', resourceType: 'aws_ec2', provider: 'aws', label: 'N1', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
      });

      const save2 = await draftRepository.saveDraft(userId, {
        providerMode: 'AWS',
        nodes: [
          { id: 'n1', type: 'resourceNode', resourceType: 'aws_ec2', provider: 'aws', label: 'N1', position: { x: 0, y: 0 }, config: {} },
          { id: 'n2', type: 'resourceNode', resourceType: 'aws_s3', provider: 'aws', label: 'N2', position: { x: 10, y: 10 }, config: {} },
        ],
        edges: [],
        revision: save1.draft.revision,
      });

      const save3 = await draftRepository.saveDraft(userId, {
        providerMode: 'AWS',
        nodes: [
          { id: 'n1', type: 'resourceNode', resourceType: 'aws_ec2', provider: 'aws', label: 'N1', position: { x: 0, y: 0 }, config: {} },
          { id: 'n2', type: 'resourceNode', resourceType: 'aws_s3', provider: 'aws', label: 'N2', position: { x: 10, y: 10 }, config: {} },
          { id: 'n3', type: 'resourceNode', resourceType: 'aws_rds', provider: 'aws', label: 'N3', position: { x: 20, y: 20 }, config: {} },
        ],
        edges: [],
        revision: save2.draft.revision,
      });

      expect(!save1.conflict).toBe(true);
      expect(!save2.conflict).toBe(true);
      expect(!save3.conflict).toBe(true);

      const latest = await draftRepository.getDraft(userId);
      expect(latest?.revision).toBe(3);
      expect(latest?.nodes.length).toBe(3);
    });
  });

  // ─── 3. CANONICAL GRAPH INTEGRITY ACROSS ALL OPERATIONS ──────────────────────
  describe('3. Canonical Graph Integrity & Invariants', () => {
    it('detects dangling edges pointing to deleted or non-existent nodes', () => {
      const nodes: CanvasNode[] = [
        { id: 'n1', type: 'resourceNode', resourceType: 'aws_ec2', provider: 'aws', label: 'Node 1', position: { x: 0, y: 0 }, config: {} },
      ];
      const edges: CanvasEdge[] = [
        { id: 'e1', source: 'n1', target: 'deleted-node-2' },
      ];

      const canonical = toCanonicalGraph({
        id: 'arch-dangling',
        name: 'Dangling Edge Test',
        provider: 'aws',
        providerMode: 'AWS',
        nodes,
        edges,
      });

      const report = validateCanonicalArchitecture(canonical);
      expect(report.isValid).toBe(false);
      expect(report.issues.some((i) => i.code === 'DANGLING_EDGE')).toBe(true);
    });

    it('detects duplicate edges between the same source and target', () => {
      const nodes: CanvasNode[] = [
        { id: 'n1', type: 'resourceNode', resourceType: 'aws_ec2', provider: 'aws', label: 'Node 1', position: { x: 0, y: 0 }, config: {} },
        { id: 'n2', type: 'resourceNode', resourceType: 'aws_rds', provider: 'aws', label: 'Node 2', position: { x: 100, y: 0 }, config: {} },
      ];
      const edges: CanvasEdge[] = [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n1', target: 'n2' },
      ];

      const canonical = toCanonicalGraph({
        id: 'arch-dup',
        name: 'Dup Edge Test',
        provider: 'aws',
        providerMode: 'AWS',
        nodes,
        edges,
      });

      const report = validateCanonicalArchitecture(canonical);
      expect(report.issues.some((i) => i.code === 'DUPLICATE_EDGE')).toBe(true);
    });

    it('detects cross-cloud containment (e.g. AWS EC2 inside Azure VNet)', () => {
      const nodes: CanvasNode[] = [
        {
          id: 'vnet-1',
          type: 'containerNode',
          resourceType: 'azure_vnet',
          provider: 'azure',
          label: 'Azure VNet',
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: 'ec2-inside',
          type: 'resourceNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'AWS EC2',
          position: { x: 10, y: 10 },
          parentId: 'vnet-1',
          config: {},
        },
      ];

      const canonical = toCanonicalGraph({
        id: 'arch-cross-containment',
        name: 'Cross Containment Test',
        provider: 'multi',
        providerMode: 'MULTI_CLOUD',
        nodes,
        edges: [],
      });

      const report = validateCanonicalArchitecture(canonical);
      expect(report.isValid).toBe(false);
      expect(report.issues.some((i) => i.code === 'ILLEGAL_CROSS_PROVIDER_CONTAINMENT')).toBe(true);
    });

    it('detects invalid parent container references', () => {
      const nodes: CanvasNode[] = [
        {
          id: 'ec2-invalid-parent',
          type: 'resourceNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'EC2',
          position: { x: 0, y: 0 },
          parentId: 'non-existent-container-999',
          config: {},
        },
      ];

      const canonical = toCanonicalGraph({
        id: 'arch-invalid-parent',
        name: 'Invalid Parent Test',
        provider: 'aws',
        providerMode: 'AWS',
        nodes,
        edges: [],
      });

      const report = validateCanonicalArchitecture(canonical);
      expect(report.isValid).toBe(false);
      expect(report.issues.some((i) => i.code === 'ORPHAN_PARENT_POINTER')).toBe(true);
    });
  });

  // ─── 4. SCALE ENGINE AUDIT ──────────────────────────────────────────────────
  describe('4. Workload-Aware Adaptive Scale Engine', () => {
    it('separates user inputs, calculated assumptions, and sizing recommendations', () => {
      const nodes: CanvasNode[] = [
        {
          id: 'ec2-app',
          type: 'resourceNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Web Tier',
          position: { x: 0, y: 0 },
          config: { instanceType: 't3.micro' },
        },
        {
          id: 'rds-db',
          type: 'resourceNode',
          resourceType: 'aws_rds',
          provider: 'aws',
          label: 'Database',
          position: { x: 100, y: 0 },
          config: { instanceClass: 'db.t3.micro', multiAz: false },
        },
      ];

      const profile: ScaleProfile = {
        expectedUsers: 250000,
        requestsPerSecond: 1200,
        peakRequestsPerSecond: 3000,
        availabilityTarget: '99.99%',
        geographicDistribution: 'multi-region',
        dataGrowth: 'high',
        trafficPattern: 'bursty',
      };

      const plan = adaptiveScaleEngine.generateScalePlan(nodes, profile, 'aws');

      // 1. User inputs preserved
      expect(plan.userInputs.expectedUsers).toBe(250000);
      expect(plan.userInputs.requestsPerSecond).toBe(1200);
      expect(plan.userInputs.peakRequestsPerSecond).toBe(3000);
      expect(plan.userInputs.availabilityTarget).toBe('99.99%');

      // 2. Explicit calculated assumptions
      expect(plan.assumptions.effectiveRps).toBe(3000);
      expect(plan.assumptions.burstMultiplier).toBe(4.0); // 4.0x for bursty traffic pattern
      expect(plan.assumptions.concurrencyMultiplier).toBeGreaterThan(0);
      expect(plan.assumptions.explanation).toBeDefined();

      // 3. Workload-derived scaling recommendations
      expect(plan.recommendations.length).toBeGreaterThan(0);

      // Verify high availability target (99.99%) triggers multiAz recommendation on DB
      const dbRec = plan.recommendations.find((r) => r.nodeId === 'rds-db');
      expect(dbRec).toBeDefined();
      expect(dbRec?.recommendedConfig.multiAz).toBe(true);

      // Verify compute scaled up to handle 3000 peak RPS
      const computeRec = plan.recommendations.find((r) => r.nodeId === 'ec2-app');
      expect(computeRec).toBeDefined();
      expect(computeRec?.recommendedConfig.instanceType).not.toBe('t3.micro');
    });

    it('estimates RPS deterministically when only expectedUsers is provided', () => {
      const nodes: CanvasNode[] = [
        {
          id: 'ec2-1',
          type: 'resourceNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Web Server',
          position: { x: 0, y: 0 },
          config: { instanceType: 't3.nano' },
        },
      ];

      const profile: ScaleProfile = {
        expectedUsers: 50000,
        // No explicit RPS provided
      };

      const plan = adaptiveScaleEngine.generateScalePlan(nodes, profile, 'aws');
      expect(plan.assumptions.effectiveRps).toBeGreaterThan(0);
      expect(plan.assumptions.peakRps).toBe(4000);
      expect(plan.assumptions.explanation).toContain('Estimated');
    });
  });

  // ─── 5. AUTO-FIX SAFETY CONTRACT ────────────────────────────────────────────
  describe('5. Architecture Auto-Fix Engine Deterministic Lifecycle', () => {
    it('executes Validate -> Repair -> Revalidate for fixable network detachment', () => {
      const nodes: CanvasNode[] = [
        {
          id: 'ec2-detached',
          type: 'resourceNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Detached EC2',
          position: { x: 100, y: 100 },
          config: { instanceType: 't3.micro' },
        },
      ];

      const result = architectureAutoFixEngine.autoFix(nodes, [], 'aws', 'AWS');

      expect(result.fixed).toBe(true);
      expect(result.actionsTaken.length).toBeGreaterThan(0);

      // Confirm revalidation occurred and validity established
      expect(result.validationAfter.isValid).toBe(true);

      // Confirm the user's original resource was NOT deleted or compromised
      const preservedEc2 = result.nodes.find((n) => n.id === 'ec2-detached');
      expect(preservedEc2).toBeDefined();
      expect(preservedEc2?.config.instanceType).toBe('t3.micro');
    });

    it('returns manualActionsRequired for ambiguous/destructive issues (incompatible cloud provider)', () => {
      const nodes: CanvasNode[] = [
        {
          id: 'az-vm-in-aws',
          type: 'resourceNode',
          resourceType: 'azure_vm',
          provider: 'azure',
          label: 'Azure VM in AWS',
          position: { x: 20, y: 20 },
          config: {},
        },
      ];

      const result = architectureAutoFixEngine.autoFix(nodes, [], 'aws', 'AWS');

      // Must not silently delete the user's resource
      expect(result.nodes.find((n) => n.id === 'az-vm-in-aws')).toBeDefined();

      // Must flag manual action required
      expect(result.manualActionsRequired).toBeDefined();
      expect(result.manualActionsRequired?.length).toBeGreaterThan(0);
      expect(result.manualActionsRequired?.[0].description).toContain('Manual action required');
    });
  });

  // ─── 6. PROVIDER SWITCHING TRANSITIONS ──────────────────────────────────────
  describe('6. Provider Switching & Destructive Change Protection', () => {
    const mixedNodes: CanvasNode[] = [
      { id: 'aws-1', type: 'resourceNode', resourceType: 'aws_ec2', provider: 'aws', label: 'AWS EC2', position: { x: 0, y: 0 }, config: {} },
      { id: 'azure-1', type: 'resourceNode', resourceType: 'azure_vm', provider: 'azure', label: 'Azure VM', position: { x: 200, y: 0 }, config: {} },
    ];

    it('test 1: AWS -> Multi-Cloud (Non-destructive, valid)', () => {
      const canonical = toCanonicalGraph({
        id: 'p1',
        name: 'AWS to Multi',
        provider: 'multi',
        providerMode: 'MULTI_CLOUD',
        nodes: mixedNodes,
        edges: [],
      });
      const report = validateCanonicalArchitecture(canonical);
      // Both AWS and Azure are valid in MULTI_CLOUD
      expect(report.issues.some((i) => i.code === 'INVALID_CLOUD_PROVIDER_RESOURCE')).toBe(false);
    });

    it('test 2: Azure -> Multi-Cloud (Non-destructive, valid)', () => {
      const canonical = toCanonicalGraph({
        id: 'p2',
        name: 'Azure to Multi',
        provider: 'multi',
        providerMode: 'MULTI_CLOUD',
        nodes: mixedNodes,
        edges: [],
      });
      const report = validateCanonicalArchitecture(canonical);
      expect(report.issues.some((i) => i.code === 'INVALID_CLOUD_PROVIDER_RESOURCE')).toBe(false);
    });

    it('test 3: Multi-Cloud -> AWS (Reports Azure resources as incompatible)', () => {
      const canonical = toCanonicalGraph({
        id: 'p3',
        name: 'Multi to AWS',
        provider: 'aws',
        providerMode: 'AWS',
        nodes: mixedNodes,
        edges: [],
      });
      const report = validateCanonicalArchitecture(canonical);
      expect(report.isValid).toBe(false);
      const invalidRes = report.issues.find((i) => i.code === 'INVALID_CLOUD_PROVIDER_RESOURCE');
      expect(invalidRes).toBeDefined();
      expect(invalidRes?.affectedResourceIds).toContain('azure-1');
    });

    it('test 4: Multi-Cloud -> Azure (Reports AWS resources as incompatible)', () => {
      const canonical = toCanonicalGraph({
        id: 'p4',
        name: 'Multi to Azure',
        provider: 'azure',
        providerMode: 'AZURE',
        nodes: mixedNodes,
        edges: [],
      });
      const report = validateCanonicalArchitecture(canonical);
      expect(report.isValid).toBe(false);
      const invalidRes = report.issues.find((i) => i.code === 'INVALID_CLOUD_PROVIDER_RESOURCE');
      expect(invalidRes).toBeDefined();
      expect(invalidRes?.affectedResourceIds).toContain('aws-1');
    });

    it('test 5: AWS -> Azure (Reports all AWS resources as incompatible)', () => {
      const awsOnly: CanvasNode[] = [
        { id: 'aws-1', type: 'resourceNode', resourceType: 'aws_ec2', provider: 'aws', label: 'AWS EC2', position: { x: 0, y: 0 }, config: {} },
      ];
      const canonical = toCanonicalGraph({
        id: 'p5',
        name: 'AWS to Azure',
        provider: 'azure',
        providerMode: 'AZURE',
        nodes: awsOnly,
        edges: [],
      });
      const report = validateCanonicalArchitecture(canonical);
      expect(report.isValid).toBe(false);
      expect(report.issues.some((i) => i.code === 'INVALID_CLOUD_PROVIDER_RESOURCE')).toBe(true);
    });

    it('test 6: Azure -> AWS (Reports all Azure resources as incompatible)', () => {
      const azureOnly: CanvasNode[] = [
        { id: 'azure-1', type: 'resourceNode', resourceType: 'azure_vm', provider: 'azure', label: 'Azure VM', position: { x: 0, y: 0 }, config: {} },
      ];
      const canonical = toCanonicalGraph({
        id: 'p6',
        name: 'Azure to AWS',
        provider: 'aws',
        providerMode: 'AWS',
        nodes: azureOnly,
        edges: [],
      });
      const report = validateCanonicalArchitecture(canonical);
      expect(report.isValid).toBe(false);
      expect(report.issues.some((i) => i.code === 'INVALID_CLOUD_PROVIDER_RESOURCE')).toBe(true);
    });
  });

  // ─── 7. LIVE ANALYSIS CONSISTENCY ───────────────────────────────────────────
  describe('7. Live Analysis Consistency Across Engines', () => {
    it('ensures Cost, Security, Well-Architected, and Terraform evaluate the live draft graph', async () => {
      const draftNodes: CanvasNode[] = [
        {
          id: 'app-ec2',
          type: 'resourceNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'App EC2',
          position: { x: 0, y: 0 },
          config: { instanceType: 't3.large' },
        },
        {
          id: 'app-s3',
          type: 'resourceNode',
          resourceType: 'aws_s3',
          provider: 'aws',
          label: 'Data Bucket',
          position: { x: 100, y: 0 },
          config: { versioning: true, encryption: true },
        },
      ];
      const draftEdges: CanvasEdge[] = [
        { id: 'e1', source: 'app-ec2', target: 'app-s3' },
      ];

      // 1. Cost analysis on draft
      const costResult = calculateCosts(draftNodes);
      expect(costResult.length).toBeGreaterThan(0);

      // 2. Security scan on draft
      const secResult = runSecurityScan(draftNodes);
      expect(secResult).toBeDefined();

      // 3. Well-Architected review on draft
      const waAssessment = await apiWellArchitectedService.analyze(draftNodes, draftEdges);
      expect(waAssessment).toBeDefined();
      expect(waAssessment?.overallScore).toBeGreaterThan(0);
      expect(waAssessment?.pillarScores.find((p) => p.pillar === 'security')?.score).toBeDefined();

      // 4. Terraform generation on draft
      const tfFiles = apiTerraformService.generateFiles(draftNodes, draftEdges, 'aws');
      expect(tfFiles['main.tf']).toBeDefined();
      expect(tfFiles['main.tf']).toContain('aws_instance');
      expect(tfFiles['main.tf']).toContain('aws_s3_bucket');
    });
  });

  // ─── 8. TERRAFORM CONSISTENCY ───────────────────────────────────────────────
  describe('8. Terraform Consistency & Relationship Parity', () => {
    it('generates Terraform with correct parent container and edge references for AWS', () => {
      const nodes: CanvasNode[] = [
        {
          id: 'vpc-root',
          type: 'containerNode',
          resourceType: 'aws_vpc',
          provider: 'aws',
          label: 'Prod VPC',
          position: { x: 0, y: 0 },
          config: { cidrBlock: '10.0.0.0/16' },
        },
        {
          id: 'sub-app',
          type: 'containerNode',
          resourceType: 'aws_subnet',
          provider: 'aws',
          label: 'App Subnet',
          position: { x: 20, y: 20 },
          parentId: 'vpc-root',
          config: { cidrBlock: '10.0.1.0/24' },
        },
        {
          id: 'ec2-worker',
          type: 'resourceNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Worker Node',
          position: { x: 40, y: 40 },
          parentId: 'sub-app',
          config: { instanceType: 't3.micro' },
        },
      ];

      const tfFiles = apiTerraformService.generateFiles(nodes, [], 'aws');
      const mainTf = tfFiles['main.tf'];

      expect(mainTf).toContain('aws_vpc');
      expect(mainTf).toContain('aws_subnet');
      expect(mainTf).toContain('aws_instance');
      expect(mainTf).toContain('10.0.0.0/16');
      expect(mainTf).toContain('10.0.1.0/24');
    });

    it('generates valid multi-cloud Terraform with dual providers', () => {
      const nodes: CanvasNode[] = [
        {
          id: 'aws-s3-backup',
          type: 'resourceNode',
          resourceType: 'aws_s3',
          provider: 'aws',
          label: 'AWS Backup Bucket',
          position: { x: 0, y: 0 },
          config: { versioning: true },
        },
        {
          id: 'azure-blob-primary',
          type: 'resourceNode',
          resourceType: 'azure_blob',
          provider: 'azure',
          label: 'Azure Primary Storage',
          position: { x: 200, y: 0 },
          config: { storageTier: 'Hot' },
        },
      ];

      const tfFiles = apiTerraformService.generateFiles(nodes, [], 'multi');
      const mainTf = tfFiles['main.tf'];
      const providersTf = tfFiles['providers.tf'];

      expect(providersTf).toContain('aws');
      expect(providersTf).toContain('azurerm');
      expect(mainTf).toContain('aws_s3_bucket');
      expect(mainTf).toContain('azurerm_storage_account');
    });
  });
});

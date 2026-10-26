/**
 * The Azure Well-Architected Framework design review checklists (learn.microsoft.com/azure/well-architected/<pillar>/checklist), with the CloudBuilder
 * checks and questions that are evidence for each recommendation. Codes and titles are Microsoft's own, shortened only where the title is a long
 * sentence. A recommendation with no checks is one a design cannot show (culture, process, testing): the review sheet leaves it for the team to answer.
 *
 * Evidence ids are rule ids: AZ-* (checks of the design), WAQ-AZ-* (the workload questionnaire) and AZ-EXT-* (the questions about a third-party service).
 */
export type AzurePillar = 'reliability' | 'security' | 'cost_optimization' | 'operational_excellence' | 'performance_efficiency';

export interface AzureChecklistItem { code: string; pillar: AzurePillar; title: string; evidence: readonly string[] }

const q = (...ids: string[]) => ids.map((i) => `WAQ-AZ-${i}`);

export const AZURE_PILLAR_LABEL: Record<AzurePillar, string> = {
  reliability: 'Reliability', security: 'Security', cost_optimization: 'Cost Optimization', operational_excellence: 'Operational Excellence', performance_efficiency: 'Performance Efficiency',
};
export const AZURE_PILLAR_ORDER: readonly AzurePillar[] = ['reliability', 'security', 'cost_optimization', 'operational_excellence', 'performance_efficiency'];
export const AZURE_CHECKLIST_URL = (p: AzurePillar) => `https://learn.microsoft.com/azure/well-architected/${p === 'cost_optimization' ? 'cost-optimization' : p === 'operational_excellence' ? 'operational-excellence' : p === 'performance_efficiency' ? 'performance-efficiency' : p}/checklist`;

export const AZURE_CHECKLIST: readonly AzureChecklistItem[] = [
  // ── Reliability ──────────────────────────────────────────────────────────
  { code: 'RE:01', pillar: 'reliability', title: 'Focus your workload design on simplicity and efficiency', evidence: [] },
  { code: 'RE:02', pillar: 'reliability', title: 'Identify and rate user and system flows', evidence: [] },
  { code: 'RE:03', pillar: 'reliability', title: 'Use failure mode analysis (FMA) to identify potential failures in your workload', evidence: [...q('REL-06'), 'AZ-EXT-REL-02'] },
  { code: 'RE:04', pillar: 'reliability', title: 'Define reliability and recovery targets for your workload', evidence: [...q('REL-02'), 'AZ-EXT-REL-01'] },
  { code: 'RE:05', pillar: 'reliability', title: 'Add redundancy at different levels, especially for critical flows', evidence: ['AZ-STG-006', 'AZ-SQL-010', 'AZ-SQL-011', 'AZ-COS-010', 'AZ-VM-011', 'AZ-ARCH-010', 'AZ-SB-010', 'AZ-ACR-010', 'AZ-FW-010', 'AZ-EH-010', 'AZ-APIM-001', 'AZ-APIM-010', 'AZ-AKS-010'] },
  { code: 'RE:06', pillar: 'reliability', title: 'Implement a timely and reliable scaling strategy at the application, data, and infrastructure levels', evidence: ['AZ-VMSS-010', 'AZ-AGW-010', 'AZ-AKS-030', ...q('REL-04', 'REL-05')] },
  { code: 'RE:07', pillar: 'reliability', title: 'Strengthen the resiliency of your workload by implementing self-preservation and self-healing measures', evidence: ['AZ-APP-010', 'AZ-APP-021'] },
  { code: 'RE:08', pillar: 'reliability', title: 'Test for resiliency and availability scenarios by applying the principles of chaos engineering', evidence: q('REL-03', 'REL-06') },
  { code: 'RE:09', pillar: 'reliability', title: 'Implement structured, tested, and documented disaster recovery (DR) plans', evidence: ['AZ-STG-005', 'AZ-VM-010', ...q('REL-01', 'REL-03'), 'AZ-EXT-REL-03', 'AZ-EXT-REL-04'] },
  { code: 'RE:10', pillar: 'reliability', title: 'Continuously measure and track system health using uptime and reliability indicators', evidence: ['AZ-ARCH-020', 'AZ-MON-001', 'AZ-VM-020', ...q('OPS-06'), 'AZ-EXT-OPS-01'] },
  // ── Security ─────────────────────────────────────────────────────────────
  { code: 'SE:01', pillar: 'security', title: 'Establish a security baseline aligned to compliance requirements, industry standards, and platform recommendations', evidence: ['AZ-EXT-SEC-05'] },
  { code: 'SE:02', pillar: 'security', title: 'Align secure development lifecycle (SDL) throughout the software development lifecycle', evidence: q('SEC-05') },
  { code: 'SE:03', pillar: 'security', title: 'Classify and consistently apply sensitivity and information type labels on all workload data', evidence: [...q('SEC-06'), 'AZ-EXT-SEC-06'] },
  { code: 'SE:04', pillar: 'security', title: 'Create intentional segmentation and perimeters in your architecture design', evidence: ['AZ-ARCH-001', 'AZ-NIC-001', 'AZ-PE-001', 'AZ-PE-002', 'AZ-CA-001'] },
  { code: 'SE:05', pillar: 'security', title: 'Implement strict, conditional, and auditable identity and access management (IAM)', evidence: ['AZ-KV-003', 'AZ-SB-002', 'AZ-EH-002', 'AZ-EG-002', 'AZ-ACR-001', ...q('SEC-01', 'SEC-02'), 'AZ-EXT-SEC-01', 'AZ-EXT-SEC-03'] },
  { code: 'SE:06', pillar: 'security', title: 'Isolate, filter, and control network traffic across both ingress and egress flows', evidence: ['AZ-STG-004', 'AZ-SQL-001', 'AZ-SQL-006', 'AZ-COS-001', 'AZ-RED-002', 'AZ-KV-001', 'AZ-VM-001', 'AZ-BAS-001', 'AZ-AKS-002', 'AZ-SB-001', 'AZ-EH-001', 'AZ-EG-001', 'AZ-ACR-002', 'AZ-CA-002', 'AZ-AGW-001', 'AZ-AFD-002', 'AZ-WAF-001', 'AZ-FW-001', 'AZ-EXT-SEC-04'] },
  { code: 'SE:07', pillar: 'security', title: 'Encrypt data by using modern, industry-standard methods', evidence: ['AZ-STG-001', 'AZ-STG-003', 'AZ-SQL-002', 'AZ-SQL-005', 'AZ-RED-001', 'AZ-RED-003', 'AZ-VM-002', 'AZ-VMSS-001', 'AZ-AFD-001', 'AZ-SB-003', 'AZ-EH-003', 'AZ-EXT-SEC-02'] },
  { code: 'SE:08', pillar: 'security', title: 'Harden all workload components by reducing extraneous surface area and tightening configurations', evidence: ['AZ-STG-002', 'AZ-APP-003', 'AZ-KV-002', 'AZ-AKS-001'] },
  { code: 'SE:09', pillar: 'security', title: 'Protect application secrets by hardening their storage and restricting access and manipulation', evidence: [...q('SEC-03'), 'AZ-EXT-SEC-03'] },
  { code: 'SE:10', pillar: 'security', title: 'Implement a holistic monitoring strategy that relies on modern threat detection mechanisms', evidence: ['AZ-SQL-003', 'AZ-SQL-004', 'AZ-ARCH-020', 'AZ-MON-001', 'AZ-EXT-SEC-07'] },
  { code: 'SE:11', pillar: 'security', title: 'Establish a comprehensive testing regimen', evidence: [] },
  { code: 'SE:12', pillar: 'security', title: 'Define and test effective incident response procedures', evidence: q('SEC-04') },
  // ── Cost Optimization ────────────────────────────────────────────────────
  { code: 'CO:01', pillar: 'cost_optimization', title: 'Create a culture of financial responsibility', evidence: q('COST-01', 'COST-02') },
  { code: 'CO:02', pillar: 'cost_optimization', title: 'Create and maintain a cost model', evidence: [] },
  { code: 'CO:03', pillar: 'cost_optimization', title: 'Collect and review cost data', evidence: [...q('COST-03'), 'AZ-EXT-COST-01'] },
  { code: 'CO:04', pillar: 'cost_optimization', title: 'Set spending guardrails', evidence: q('COST-01') },
  { code: 'CO:05', pillar: 'cost_optimization', title: 'Get the best rates from providers', evidence: q('COST-04') },
  { code: 'CO:06', pillar: 'cost_optimization', title: 'Align usage to billing increments', evidence: [] },
  { code: 'CO:07', pillar: 'cost_optimization', title: 'Optimize component costs', evidence: q('COST-03') },
  { code: 'CO:08', pillar: 'cost_optimization', title: 'Optimize environment costs', evidence: q('COST-05') },
  { code: 'CO:09', pillar: 'cost_optimization', title: 'Optimize flow costs', evidence: [] },
  { code: 'CO:10', pillar: 'cost_optimization', title: 'Optimize data costs', evidence: [] },
  { code: 'CO:11', pillar: 'cost_optimization', title: 'Optimize code costs', evidence: [] },
  { code: 'CO:12', pillar: 'cost_optimization', title: 'Optimize scaling costs', evidence: ['AZ-VMSS-010', 'AZ-AGW-010', 'AZ-AKS-030'] },
  { code: 'CO:13', pillar: 'cost_optimization', title: 'Optimize personnel time', evidence: [] },
  { code: 'CO:14', pillar: 'cost_optimization', title: 'Consolidate resources and responsibility', evidence: [] },
  // ── Operational Excellence ───────────────────────────────────────────────
  { code: 'OE:01', pillar: 'operational_excellence', title: 'Define your standard practices to develop and operate your workload', evidence: [...q('OPS-08', 'OPS-05'), 'AZ-EXT-OPS-02'] },
  { code: 'OE:02', pillar: 'operational_excellence', title: 'Use standardization to make routine, ad-hoc, and emergency operations consistent and predictable', evidence: q('OPS-03') },
  { code: 'OE:03', pillar: 'operational_excellence', title: 'Formalize processes across the full software development lifecycle', evidence: q('OPS-07') },
  { code: 'OE:04', pillar: 'operational_excellence', title: 'Enhance software development and quality assurance by implementing industry-standard practices', evidence: q('OPS-07') },
  { code: 'OE:05', pillar: 'operational_excellence', title: 'Use a standardized infrastructure as code (IaC) approach to prepare resources and configurations', evidence: q('OPS-01') },
  { code: 'OE:06', pillar: 'operational_excellence', title: 'Build a workload supply chain that drives changes through predictable, automated pipelines', evidence: q('OPS-01', 'OPS-07') },
  { code: 'OE:07', pillar: 'operational_excellence', title: 'Design a monitoring stack that captures operational telemetry, metrics, and logs', evidence: ['AZ-ARCH-020', 'AZ-MON-001', 'AZ-VM-020', ...q('OPS-06'), 'AZ-EXT-OPS-01'] },
  { code: 'OE:08', pillar: 'operational_excellence', title: 'Establish a clear, structured incident management process', evidence: q('OPS-04', 'OPS-05') },
  { code: 'OE:09', pillar: 'operational_excellence', title: 'Enhance the quality of your workload by adopting testing practices', evidence: q('OPS-07') },
  { code: 'OE:10', pillar: 'operational_excellence', title: 'Design automation to be reliable, secure, and maintainable', evidence: q('OPS-01') },
  { code: 'OE:11', pillar: 'operational_excellence', title: "Clearly define your workload's safe deployment practices", evidence: q('OPS-02', 'OPS-07') },
  // ── Performance Efficiency ───────────────────────────────────────────────
  { code: 'PE:01', pillar: 'performance_efficiency', title: 'Define performance targets', evidence: q('PERF-01') },
  { code: 'PE:02', pillar: 'performance_efficiency', title: 'Conduct capacity planning', evidence: q('REL-04') },
  { code: 'PE:03', pillar: 'performance_efficiency', title: 'Select the right services', evidence: q('PERF-03') },
  { code: 'PE:04', pillar: 'performance_efficiency', title: 'Establish consistent performance measurement', evidence: q('PERF-02') },
  { code: 'PE:05', pillar: 'performance_efficiency', title: 'Optimize scaling and partitioning', evidence: ['AZ-VMSS-010', 'AZ-AGW-010', 'AZ-AKS-030'] },
  { code: 'PE:06', pillar: 'performance_efficiency', title: "Optimize your workload's performance by regularly testing in a production-like environment", evidence: q('PERF-04') },
  { code: 'PE:07', pillar: 'performance_efficiency', title: 'Optimize code and infrastructure', evidence: ['AZ-APP-020', 'AZ-AFD-010', 'AZ-ARCH-030'] },
  { code: 'PE:08', pillar: 'performance_efficiency', title: 'Optimize data usage', evidence: q('PERF-05') },
  { code: 'PE:09', pillar: 'performance_efficiency', title: 'Prioritize the performance of critical flows', evidence: [] },
  { code: 'PE:10', pillar: 'performance_efficiency', title: 'Optimize operational tasks', evidence: [] },
  { code: 'PE:11', pillar: 'performance_efficiency', title: 'Respond to live performance issues', evidence: [] },
  { code: 'PE:12', pillar: 'performance_efficiency', title: 'Continuously optimize performance', evidence: [] },
];

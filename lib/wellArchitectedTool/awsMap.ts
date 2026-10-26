/**
 * Which AWS Well-Architected Framework best practices CloudBuilder has evidence for.
 *
 * Each entry names a best practice of the AWS Well-Architected Tool's Framework lens and the CloudBuilder checks that bear on it. The ids come from
 * the Framework documentation (docs.aws.amazon.com/wellarchitected/latest/<pillar>-pillar): `bp` is the best-practice number and `choiceId` the page
 * name, which is the choice id the Tool's API uses. The Tool's QUESTION ids are not listed here on purpose: the sync reads the workload's own answers
 * and finds the question that holds the choice, so nothing depends on an id that AWS may rename in a new Framework version.
 *
 * Only practices a design can show are mapped. The rest of the 50-odd Framework questions (process, people, on-call, budgets) stay unanswered in
 * the Tool for the team to answer: a diagram says nothing about them.
 */
export interface BestPracticeMapping {
  /** Framework best-practice number, e.g. "SEC08-BP02". */
  bp: string;
  /** The Tool's choice id for that best practice. */
  choiceId: string;
  title: string;
  /** CloudBuilder rule ids whose result is evidence for it. */
  ruleIds: readonly string[];
}

export const AWS_BEST_PRACTICES: readonly BestPracticeMapping[] = [
  { bp: 'SEC03-BP02', choiceId: 'sec_permissions_least_privileges', title: 'Grant least privilege access', ruleIds: ['AWS-IAM-001'] },
  { bp: 'SEC04-BP01', choiceId: 'sec_detect_investigate_events_app_service_logging', title: 'Configure service and application logging', ruleIds: ['AWS-S3-003', 'AWS-VPC-002', 'AWS-ELB-005', 'AWS-CF-003', 'AWS-EKS-003', 'AWS-RDS-004'] },
  { bp: 'SEC05-BP01', choiceId: 'sec_network_protection_create_layers', title: 'Create network layers', ruleIds: ['AWS-EC2-001', 'AWS-VPC-001', 'AWS-RDS-001', 'AWS-ECS-001', 'AWS-EKS-001', 'AWS-S3-001'] },
  { bp: 'SEC05-BP02', choiceId: 'sec_network_protection_layered', title: 'Control traffic flow within your network layers', ruleIds: ['AWS-SG-001', 'AWS-SG-002', 'AWS-NACL-001'] },
  { bp: 'SEC05-BP03', choiceId: 'sec_network_protection_inspection', title: 'Implement inspection-based protection', ruleIds: ['AWS-ELB-003', 'AWS-CF-002', 'AWS-WAF-001'] },
  { bp: 'SEC08-BP01', choiceId: 'sec_protect_data_rest_key_mgmt', title: 'Implement secure key management', ruleIds: ['AWS-KMS-001'] },
  { bp: 'SEC08-BP02', choiceId: 'sec_protect_data_rest_encrypt', title: 'Enforce encryption at rest', ruleIds: ['AWS-S3-002', 'AWS-RDS-002', 'AWS-EC2-002', 'AWS-EBS-001', 'AWS-ELC-002', 'AWS-DDB-001', 'AWS-SQS-001', 'AWS-EKS-002'] },
  { bp: 'SEC09-BP02', choiceId: 'sec_protect_data_transit_encrypt', title: 'Enforce encryption in transit', ruleIds: ['AWS-ELB-001', 'AWS-ELB-002', 'AWS-CF-001', 'AWS-ELC-001'] },
  { bp: 'REL07-BP01', choiceId: 'rel_adapt_to_changes_autoscale_adapt', title: 'Use automation when obtaining or scaling resources', ruleIds: ['AWS-ARCH-001', 'AWS-PERF-003', 'AWS-ASG-001'] },
  { bp: 'REL09-BP01', choiceId: 'rel_backing_up_data_identified_backups_data', title: 'Identify and back up all data that needs to be backed up', ruleIds: ['AWS-RDS-007', 'AWS-EBS-002', 'AWS-ELC-004', 'AWS-DDB-002', 'AWS-S3-005'] },
  { bp: 'REL10-BP01', choiceId: 'rel_fault_isolation_multiaz_region_system', title: 'Deploy the workload to multiple locations', ruleIds: ['AWS-ARCH-002', 'AWS-RDS-006', 'AWS-ELC-003'] },
  { bp: 'REL11-BP01', choiceId: 'rel_withstand_component_failures_monitoring_health', title: 'Monitor all components of the workload to detect failures', ruleIds: ['AWS-ARCH-003', 'AWS-EC2-010'] },
];

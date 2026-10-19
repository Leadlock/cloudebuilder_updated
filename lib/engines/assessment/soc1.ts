/**
 * SOC 1-oriented technical control mapping.
 *
 * SOC 1® reports (AICPA, AT-C section 320 / SSAE 18) cover controls at a service
 * organization that are relevant to user entities' internal control over
 * financial reporting (ICFR). For systems in scope, auditors typically examine
 * IT general controls (logical access, change management, IT operations).
 *
 * CloudBuilder can only contribute TECHNICAL, configuration-based evidence from an
 * architecture design (or discovered configuration). It cannot observe
 * organizational controls, cannot determine which systems are relevant to ICFR,
 * and cannot assess design or operating effectiveness. Every area therefore
 * lists the organizational evidence an auditor would still require.
 *
 * NOTHING here is a SOC 1 opinion, attestation, certification or compliance status.
 */
import type {
  Evaluation, Finding, Soc1AreaId, Soc1AreaResult, Soc1EvidenceType, RuleDefinition,
} from './types';

export const SOC1_DISCLAIMER =
  'This SOC 1-oriented technical control analysis is NOT a SOC 1® examination, report, attestation, certification or opinion. ' +
  'CloudBuilder is not an independent service auditor. It maps technical configuration evidence from the architecture to control areas ' +
  'commonly examined as IT general controls, to support readiness and audit preparation. Whether a system is relevant to user entities\' ' +
  'internal control over financial reporting, and whether controls are suitably designed and operating effectively, can only be ' +
  'determined by management and an independent CPA firm performing a SOC 1 engagement (AICPA AT-C section 320).';

export const AUDITOR_ASSESSMENT_REQUIRED =
  'An independent service auditor (CPA firm) must determine whether this control area is relevant to user entities\' ICFR and whether the related controls are suitably designed and, for a Type 2 report, operating effectively over the review period.';

interface AreaDef {
  id: Soc1AreaId;
  name: string;
  objective: string;
  organizationalEvidence: string[];
  limitations: string;
}

export const SOC1_AREAS: AreaDef[] = [
  {
    id: 'SOC1-LA-01', name: 'Logical access — network perimeter and exposure',
    objective: 'Access to systems and data from untrusted networks is restricted to authorized paths.',
    organizationalEvidence: ['Approved network architecture / data-flow diagrams', 'Firewall/security group change approvals', 'Periodic firewall rule reviews'],
    limitations: 'Evaluated from designed security groups, NSGs, public endpoints and diagram relationships. Effective rules on deployed resources and account-level guardrails are not observed at design time.',
  },
  {
    id: 'SOC1-LA-02', name: 'Logical access — privileged access and authorization',
    objective: 'Privileged access is limited to authorized personnel and follows least privilege.',
    organizationalEvidence: ['User access provisioning/de-provisioning records', 'Periodic privileged access reviews', 'Role definitions and approval evidence', 'Segregation of duties analysis'],
    limitations: 'Only workload-level roles and resource authorization settings modelled in the architecture are visible; human user accounts and role assignments are not.',
  },
  {
    id: 'SOC1-LA-03', name: 'Logical access — authentication',
    objective: 'Users and services authenticate with strong mechanisms appropriate to their privilege.',
    organizationalEvidence: ['Identity provider MFA / Conditional Access policy exports', 'Password and credential rotation standards', 'Root/break-glass account procedures'],
    limitations: 'Account- and tenant-level authentication (root MFA, Entra ID Conditional Access) cannot be observed from a design and is reported NOT EVALUATED.',
  },
  {
    id: 'SOC1-DP-01', name: 'Data protection — encryption at rest and key management',
    objective: 'Stored data relevant to financial processing is protected against unauthorized disclosure.',
    organizationalEvidence: ['Data classification policy', 'Key management procedures and key custodian approvals'],
    limitations: 'Evaluated from designed encryption settings. Key policies, key access and rotation evidence in the live environment are not observed.',
  },
  {
    id: 'SOC1-DP-02', name: 'Data protection — encryption in transit',
    objective: 'Data transmitted over networks is protected against interception and modification.',
    organizationalEvidence: ['Certificate management procedures', 'TLS configuration standards'],
    limitations: 'Evaluated from listener, endpoint and service TLS settings in the design.',
  },
  {
    id: 'SOC1-OP-01', name: 'IT operations — logging and audit trails',
    objective: 'Security-relevant activity and changes are logged and retained to support investigation and review.',
    organizationalEvidence: ['Log retention policy', 'Evidence of log review', 'Protection of log integrity'],
    limitations: 'Account-level trails (CloudTrail, Activity Log) are NOT EVALUATED at design time; only resource-level logging settings are observed.',
  },
  {
    id: 'SOC1-OP-02', name: 'IT operations — monitoring and incident detection',
    objective: 'Processing failures and security events are detected and escalated.',
    organizationalEvidence: ['Alert routing / on-call procedures', 'Incident management tickets and post-incident reviews'],
    limitations: 'Monitoring resources modelled in the design are observed; whether alerts are acted on requires organizational evidence.',
  },
  {
    id: 'SOC1-OP-03', name: 'IT operations — backup and recovery',
    objective: 'Data can be restored completely and accurately after loss or corruption.',
    organizationalEvidence: ['Backup policy', 'Evidence of periodic restore testing', 'Backup failure monitoring and resolution'],
    limitations: 'Backup configuration is observed from the design; successful backups and restore tests are not.',
  },
  {
    id: 'SOC1-OP-04', name: 'IT operations — availability and resilience',
    objective: 'Systems supporting financial processing remain available per commitments.',
    organizationalEvidence: ['Business continuity / DR plans', 'DR test results', 'Capacity management reviews'],
    limitations: 'Redundancy is inferred from the design (Multi-AZ, zones, load balancing); actual availability is not measured.',
  },
  {
    id: 'SOC1-CM-01', name: 'Change management — protection against unauthorized or accidental change',
    objective: 'Changes to infrastructure are authorized, tested and approved before implementation; critical resources are protected from accidental deletion.',
    organizationalEvidence: ['Change tickets with approvals', 'Evidence of testing prior to production deployment', 'Segregation between developers and production deployers', 'Emergency change procedures'],
    limitations: 'CloudBuilder can show that infrastructure is defined as code (generated Terraform) and whether deletion protection is configured. It cannot show that changes were approved, tested or segregated.',
  },
  {
    id: 'SOC1-CM-02', name: 'Configuration management and patching',
    objective: 'Systems are maintained in a secure, approved configuration and patched in a timely manner.',
    organizationalEvidence: ['Configuration baselines', 'Patch management records', 'Vulnerability management reports'],
    limitations: 'Only automatic patching settings and configuration-recording controls are observable; patch status is not.',
  },
];

export function buildSoc1(
  rules: RuleDefinition[],
  evaluations: Evaluation[],
  findings: Finding[],
): Soc1AreaResult[] {
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  return SOC1_AREAS.map((area) => {
    const evals = evaluations.filter((e) => ruleById.get(e.ruleId)?.soc1.includes(area.id));
    const passed = evals.filter((e) => e.status === 'PASS');
    const failing = evals.filter((e) => e.status === 'FAIL' || e.status === 'WARNING');
    const unknown = evals.filter((e) => e.status === 'NOT_EVALUATED' || e.status === 'INSUFFICIENT_DATA');
    const areaFindings = findings.filter((f) => f.soc1Areas.includes(area.id));

    const isDiscovered = (e: Evaluation) => e.provenance === 'DISCOVERED_CONFIGURATION' || e.provenance === 'LIVE_VERIFIED';
    const passedDesign = passed.filter((e) => !isDiscovered(e));
    const passedDiscovered = passed.filter(isDiscovered);

    const evidenceTypes = new Set<Soc1EvidenceType>();
    if (passedDesign.length > 0 || failing.some((e) => !isDiscovered(e))) evidenceTypes.add('ARCHITECTURE_EVIDENCE');
    if (passedDiscovered.length > 0 || failing.some(isDiscovered)) evidenceTypes.add('DISCOVERED_CLOUD_EVIDENCE');
    if (evals.some((e) => e.provenance === 'LIVE_VERIFIED')) evidenceTypes.add('LIVE_VERIFIED_EVIDENCE');
    if (unknown.length > 0 || evals.length === 0) evidenceTypes.add('NOT_EVALUATED');
    evidenceTypes.add('REQUIRES_ORGANIZATIONAL_EVIDENCE');
    evidenceTypes.add('REQUIRES_AUDITOR_ASSESSMENT');

    // Summaries by rule (not per resource) keep the section readable.
    const byRule = (list: Evaluation[]) => {
      const m = new Map<string, Evaluation[]>();
      for (const e of list) m.set(e.ruleId, [...(m.get(e.ruleId) ?? []), e]);
      return m;
    };
    const describePassed = (list: Evaluation[], basis: string) => [...byRule(list).entries()].map(([ruleId, es]) =>
      `${ruleId} — ${ruleById.get(ruleId)?.title}: check passed (${basis}) for ${es.length} resource${es.length === 1 ? '' : 's'} (${es.flatMap((e) => e.resourceLabels).slice(0, 4).join(', ')}${es.length > 4 ? ', …' : ''}).`);
    const architectureEvidence = describePassed(passedDesign, 'design-time configuration');
    const discoveredEvidence = describePassed(passedDiscovered, 'discovered cloud configuration');
    const technicalEvidence = [...architectureEvidence, ...discoveredEvidence];
    const gaps = [...byRule(failing).entries()].map(([ruleId, es]) =>
      `${ruleId} — ${ruleById.get(ruleId)?.title}: ${es.length} resource${es.length === 1 ? '' : 's'} (${es.flatMap((e) => e.resourceLabels).slice(0, 4).join(', ')}${es.length > 4 ? ', …' : ''}).`);
    for (const [ruleId] of byRule(unknown)) {
      gaps.push(`${ruleId} — ${ruleById.get(ruleId)?.title}: not evaluated (insufficient technical evidence).`);
    }

    let status: Soc1AreaResult['status'];
    if (passed.length + failing.length === 0) status = 'Not evaluated';
    else if (failing.length > 0) status = 'Gaps identified';
    else if (unknown.length > 0) status = 'Partially evaluated';
    else status = 'Technical evidence observed';

    const recommendedActions = Array.from(new Set(areaFindings.map((f) => f.recommendation))).slice(0, 6);

    return {
      id: area.id,
      name: area.name,
      objective: area.objective,
      status,
      evidenceTypes: Array.from(evidenceTypes),
      technicalEvidence,
      architectureEvidence,
      discoveredEvidence,
      userProvidedEvidence: [],
      gaps,
      relatedResourceLabels: Array.from(new Set(evals.flatMap((e) => e.resourceLabels))).slice(0, 30),
      relatedFindingIds: areaFindings.map((f) => f.findingId),
      recommendedActions,
      organizationalEvidenceRequired: area.organizationalEvidence,
      auditorAssessmentRequired: AUDITOR_ASSESSMENT_REQUIRED,
      conclusion: 'NOT_CONCLUDED',
      conclusionReason: architectureEvidence.length > 0 && discoveredEvidence.length === 0
        ? 'Technical checks passed on the designed architecture only. A design does not show that the control exists in production, nor that it is suitably designed and operating effectively; that requires organizational evidence and an independent auditor.'
        : 'Technical configuration evidence cannot by itself show that a control is suitably designed and operating effectively over a period. That requires organizational evidence and an independent auditor.',
      limitations: area.limitations,
    };
  });
}

/** Organizational controls that can never be inferred from an architecture diagram. */
export const SOC1_ORGANIZATIONAL_CONTROLS: string[] = [
  'Background checks and personnel security',
  'Management review and approval controls',
  'User access reviews and termination processing',
  'Change approval, testing and segregation of duties',
  'Financial transaction processing and reconciliation controls',
  'Incident response procedures and communications',
  'Vendor / subservice organization oversight (e.g. review of AWS or Microsoft SOC 1 reports and complementary user entity controls)',
  'Risk assessment and control environment (governance)',
];

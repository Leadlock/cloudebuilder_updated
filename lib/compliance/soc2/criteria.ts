/**
 * The SOC 2 trust services criteria CloudBuilder covers: Security (the Common Criteria, CC1 to CC9), Availability (A1) and Confidentiality (C1).
 * Criterion ids are the AICPA's; the names and the one-line meanings are written here in plain words. They are not the AICPA's text, and the CPA firm works from
 * the official criteria (TSP section 100): confirm every reference against it before relying on it.
 */
export type Soc2Category = 'security' | 'availability' | 'confidentiality';

export interface Soc2Criterion { id: string; category: Soc2Category; name: string; asks: string }

export const SOC2_CATEGORY_LABEL: Record<Soc2Category, string> = { security: 'Security', availability: 'Availability', confidentiality: 'Confidentiality' };
export const SOC2_CATEGORY_RANGE: Record<Soc2Category, string> = { security: 'CC1 to CC9', availability: 'A1.1 to A1.3', confidentiality: 'C1.1 to C1.2' };

const c = (id: string, category: Soc2Category, name: string, asks: string): Soc2Criterion => ({ id, category, name, asks });

export const SOC2_CRITERIA: readonly Soc2Criterion[] = [
  c('CC1.1', 'security', 'Integrity and ethics', 'Leadership shows and enforces integrity and ethical values.'),
  c('CC1.2', 'security', 'Board oversight', 'An independent body oversees the controls.'),
  c('CC1.3', 'security', 'Structure and authority', 'Reporting lines, authority and responsibilities are set.'),
  c('CC1.4', 'security', 'Competence', 'People are hired, trained and kept competent for their roles.'),
  c('CC1.5', 'security', 'Accountability', 'People are held accountable for their control duties.'),
  c('CC2.1', 'security', 'Quality information', 'Relevant, good-quality information supports the controls.'),
  c('CC2.2', 'security', 'Internal communication', 'Control responsibilities are communicated inside the company.'),
  c('CC2.3', 'security', 'External communication', 'Customers and others outside are told what they need to know.'),
  c('CC3.1', 'security', 'Clear objectives', 'Objectives are clear enough to identify the risks to them.'),
  c('CC3.2', 'security', 'Risk identification', 'Risks are identified and analysed.'),
  c('CC3.3', 'security', 'Fraud risk', 'The chance of fraud is considered.'),
  c('CC3.4', 'security', 'Changes that matter', 'Significant changes that could affect the controls are assessed.'),
  c('CC4.1', 'security', 'Control evaluation', 'Controls are evaluated, continuously or on a schedule.'),
  c('CC4.2', 'security', 'Fixing deficiencies', 'Deficiencies are reported to those who can fix them, and fixed.'),
  c('CC5.1', 'security', 'Control selection', 'Controls that reduce risk are selected and built.'),
  c('CC5.2', 'security', 'Technology controls', 'General controls over technology are selected and built.'),
  c('CC5.3', 'security', 'Policies and procedures', 'Controls are put into policies and procedures that people follow.'),
  c('CC6.1', 'security', 'Access protection', 'Systems and data are protected by access controls and encryption.'),
  c('CC6.2', 'security', 'User registration', 'Users are registered and authorised before they get access.'),
  c('CC6.3', 'security', 'Roles and removal', 'Access follows roles and least privilege, and is removed when no longer needed.'),
  c('CC6.4', 'security', 'Physical access', 'Physical access to facilities and hardware is restricted.'),
  c('CC6.5', 'security', 'Disposal', 'Assets and data are disposed of so they cannot be read.'),
  c('CC6.6', 'security', 'Outside threats', 'The system boundary is protected against threats from outside.'),
  c('CC6.7', 'security', 'Data in motion', 'Information moved or sent is restricted and protected.'),
  c('CC6.8', 'security', 'Malicious software', 'Malicious or unauthorised software is prevented or detected.'),
  c('CC7.1', 'security', 'Detecting weaknesses', 'Configuration changes and vulnerabilities are detected.'),
  c('CC7.2', 'security', 'Monitoring', 'Systems are monitored for anomalies that could be attacks or failures.'),
  c('CC7.3', 'security', 'Evaluating events', 'Security events are evaluated to decide if they are incidents.'),
  c('CC7.4', 'security', 'Incident response', 'Incidents are responded to by a defined programme.'),
  c('CC7.5', 'security', 'Recovery from incidents', 'The company recovers from incidents and learns from them.'),
  c('CC8.1', 'security', 'Change management', 'Changes are authorised, designed, tested, approved and implemented in a controlled way.'),
  c('CC9.1', 'security', 'Business disruption', 'Risks of business disruption are identified and reduced.'),
  c('CC9.2', 'security', 'Vendors and partners', 'Risks from vendors and business partners are assessed and managed.'),
  c('A1.1', 'availability', 'Capacity', 'Capacity is monitored and managed to meet availability commitments.'),
  c('A1.2', 'availability', 'Protection and backup', 'Environmental protections, backups and recovery infrastructure are in place.'),
  c('A1.3', 'availability', 'Recovery testing', 'Recovery plans are tested.'),
  c('C1.1', 'confidentiality', 'Confidential information', 'Confidential information is identified and protected.'),
  c('C1.2', 'confidentiality', 'Disposal of confidential data', 'Confidential information is disposed of when no longer needed.'),
];

export const SOC2_CRITERIA_BY_ID: ReadonlyMap<string, Soc2Criterion> = new Map(SOC2_CRITERIA.map((x) => [x.id, x]));

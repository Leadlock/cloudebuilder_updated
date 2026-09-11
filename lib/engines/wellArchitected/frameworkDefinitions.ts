/**
 * Well-Architected Framework Definitions
 *
 * Canonical definitions for AWS and Azure Well-Architected Frameworks.
 * Versioned, maintainable — never hard-code old documentation text here.
 * Only pillar names, IDs, and official reference URLs.
 *
 * AWS: https://docs.aws.amazon.com/wellarchitected/
 * Azure: https://learn.microsoft.com/azure/well-architected/
 */

import type { AwsPillar, AzurePillar } from './types';

// ─── Pillar Metadata ─────────────────────────────────────────────────────────

export interface PillarDefinition {
  id: AwsPillar | AzurePillar;
  label: string;
  abbreviation: string;
  description: string;
  referenceUrl: string;
}

// ─── AWS Pillar Definitions ───────────────────────────────────────────────────

export const AWS_PILLARS: PillarDefinition[] = [
  {
    id: 'operational_excellence',
    label: 'Operational Excellence',
    abbreviation: 'OE',
    description: 'Ability to run and monitor systems to deliver business value and to continually improve supporting processes and procedures.',
    referenceUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html',
  },
  {
    id: 'security',
    label: 'Security',
    abbreviation: 'SEC',
    description: 'Ability to protect data, systems, and assets to take advantage of cloud technologies to improve your security.',
    referenceUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html',
  },
  {
    id: 'reliability',
    label: 'Reliability',
    abbreviation: 'REL',
    description: 'Ability of a workload to perform its intended function correctly and consistently when expected to.',
    referenceUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html',
  },
  {
    id: 'performance_efficiency',
    label: 'Performance Efficiency',
    abbreviation: 'PERF',
    description: 'Ability to use computing resources efficiently to meet system requirements, and to maintain that efficiency as demand changes.',
    referenceUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html',
  },
  {
    id: 'cost_optimization',
    label: 'Cost Optimization',
    abbreviation: 'COST',
    description: 'Ability to run systems to deliver business value at the lowest price point.',
    referenceUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html',
  },
  {
    id: 'sustainability',
    label: 'Sustainability',
    abbreviation: 'SUS',
    description: 'Long-term environmental, economic, and societal impact of your business activities.',
    referenceUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html',
  },
];

// ─── Azure Pillar Definitions ─────────────────────────────────────────────────

export const AZURE_PILLARS: PillarDefinition[] = [
  {
    id: 'reliability',
    label: 'Reliability',
    abbreviation: 'RE',
    description: 'Ability of a system to recover from failures and continue to function.',
    referenceUrl: 'https://learn.microsoft.com/azure/well-architected/reliability/',
  },
  {
    id: 'security',
    label: 'Security',
    abbreviation: 'SEC',
    description: 'Protect your workload from threats and vulnerabilities.',
    referenceUrl: 'https://learn.microsoft.com/azure/well-architected/security/',
  },
  {
    id: 'cost_optimization',
    label: 'Cost Optimization',
    abbreviation: 'CO',
    description: 'Maximize the value of investments in your workload.',
    referenceUrl: 'https://learn.microsoft.com/azure/well-architected/cost-optimization/',
  },
  {
    id: 'operational_excellence',
    label: 'Operational Excellence',
    abbreviation: 'OE',
    description: 'Operations processes that keep a system running in production.',
    referenceUrl: 'https://learn.microsoft.com/azure/well-architected/operational-excellence/',
  },
  {
    id: 'performance_efficiency',
    label: 'Performance Efficiency',
    abbreviation: 'PE',
    description: 'Ability to adapt to changes in load.',
    referenceUrl: 'https://learn.microsoft.com/azure/well-architected/performance-efficiency/',
  },
];

// ─── Framework Definitions ────────────────────────────────────────────────────

export interface FrameworkDefinition {
  provider: 'aws' | 'azure';
  framework: string;
  frameworkVersion: string;
  documentationUrl: string;
  lastUpdated: string;
  pillars: PillarDefinition[];
}

export const AWS_WELL_ARCHITECTED_FRAMEWORK: FrameworkDefinition = {
  provider: 'aws',
  framework: 'AWS Well-Architected Framework',
  frameworkVersion: '2024',
  documentationUrl: 'https://docs.aws.amazon.com/wellarchitected/',
  lastUpdated: '2024-11-01',
  pillars: AWS_PILLARS,
};

export const AZURE_WELL_ARCHITECTED_FRAMEWORK: FrameworkDefinition = {
  provider: 'azure',
  framework: 'Microsoft Azure Well-Architected Framework',
  frameworkVersion: '2024',
  documentationUrl: 'https://learn.microsoft.com/azure/well-architected/',
  lastUpdated: '2024-10-01',
  pillars: AZURE_PILLARS,
};

// ─── Lookup helpers ────────────────────────────────────────────────────────────

export function getPillarDefinition(
  provider: 'aws' | 'azure',
  pillarId: string,
): PillarDefinition | undefined {
  const pillars = provider === 'aws' ? AWS_PILLARS : AZURE_PILLARS;
  return pillars.find((p) => p.id === pillarId);
}

export function getFramework(provider: 'aws' | 'azure'): FrameworkDefinition {
  return provider === 'aws'
    ? AWS_WELL_ARCHITECTED_FRAMEWORK
    : AZURE_WELL_ARCHITECTED_FRAMEWORK;
}

export function getPillarsForProvider(provider: 'aws' | 'azure'): PillarDefinition[] {
  return provider === 'aws' ? AWS_PILLARS : AZURE_PILLARS;
}

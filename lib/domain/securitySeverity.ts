/**
 * Canonical severity ratings for cloud-configuration facts that are
 * independently checked by multiple engines (RDE security rules in
 * lib/resources/*.ts, SecurityAnalyzer rules, Well-Architected rules,
 * ArchitectureAdvisor recommendations, and the legacy generator.ts
 * recommendations).
 *
 * BACKGROUND: an audit of this codebase found the same underlying fact
 * (e.g. "RDS has Multi-AZ disabled") rated at different severities in
 * different engines — a user could see "medium" on the Security tab and
 * "high" on the Well-Architected tab for the identical finding. This module
 * is the single place that decides the severity for a given fact so every
 * engine agrees by construction instead of by coincidence. Each engine keeps
 * its own rule IDs, titles, and remediation text (those are legitimately
 * engine-specific), but MUST import the severity from here rather than
 * hardcoding its own literal for any fact listed below.
 *
 * Not exhaustive — only facts confirmed to be checked in more than one
 * engine are listed here. Adding a new cross-engine check should add its
 * canonical severity here first.
 */

export type CanonicalSeverity = 'critical' | 'high' | 'medium' | 'low';

export const SECURITY_SEVERITY = {
  // ── AWS RDS ──────────────────────────────────────────────────────────────
  AWS_RDS_NOT_ENCRYPTED: 'high',
  AWS_RDS_PUBLICLY_ACCESSIBLE: 'critical',
  // Single point of failure with no automatic failover. Standardized to
  // "high" (not "medium") to match the Well-Architected Reliability pillar
  // and Advisor engine, which independently arrived at "high" for this —
  // an availability gap this severe for a production database warrants
  // more than a "medium" rating.
  AWS_RDS_NOT_MULTI_AZ: 'high',

  // ── AWS S3 ───────────────────────────────────────────────────────────────
  AWS_S3_PUBLIC_ACCESS: 'critical',
  AWS_S3_NOT_ENCRYPTED: 'high',

  // ── AWS networking ───────────────────────────────────────────────────────
  // No Security Groups at all for an AWS compute/database architecture.
  // Standardized to "high" to match the Well-Architected and Advisor
  // engines, which treat a total absence of network-layer access control
  // as more severe than "medium".
  AWS_NO_SECURITY_GROUPS: 'high',
} as const satisfies Record<string, CanonicalSeverity>;

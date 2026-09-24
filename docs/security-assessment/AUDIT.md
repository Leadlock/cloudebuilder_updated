# Security & Well-Architected Engine Audit (ruleset 2026.09.2)

This records what was wrong with the assessment engines before this change, and what replaced them. The full per-rule matrix is in
[RULE_MATRIX.md](./RULE_MATRIX.md).

## 1. Root causes found in the previous implementation

### Well-Architected review (`lib/engines/wellArchitected/rules/{awsWaRules,azureWaRules}.ts`, now removed)

| Defect | Example | Effect |
|---|---|---|
| Rules targeted resource types that do not exist in the resource catalogue | `aws_cloudtrail`, `aws_redis_cache`, `azure_load_balancer`, `azure_application_gateway`, `azure_agw`, `azure_monitor`, `azure_log_analytics`, `azure_application_insights`, `azure_function_app`, `azure_redis_cache` | These rules could never fire. "No monitoring" checks passed silently. |
| Rules read configuration keys that no resource definition has | `publicAccessBlock`, `reservedInstance`, `diskEncryption`, `transparentDataEncryption` | These checks were dead, or read defaults that don't exist. |
| Findings were raised on absent evidence | `reservedInstance ?? false` flagged **every** EC2 instance as not using reserved capacity | Cost findings were fabricated. |
| The score counted "no finding" as a pass | Unevaluated pillars showed 100 | Scores were inflated. |
| Finding rows used deterministic primary keys | `wellArchitectedRepository` finding IDs collided on re-analysis | A second analysis of the same architecture failed. |

### Security analysis (`lib/engines/security/{awsRules,azureRules}.ts` and `securityRules` in `lib/resources/*`)

| Defect | Example | Effect |
|---|---|---|
| Keys absent from the resource definition | `blockPublicAccess` (the RDE has `blockPublicAcls`/`blockPublicPolicy`), `transparentDataEncryption` (the RDE has `transparentDataEncryptionEnabled`), `diskEncryption` | S3 public-access-block, Azure SQL TDE and VM disk encryption findings could never fire. |
| Two parallel rule sets with different IDs and severities for the same control | `AWS-RDS-PUBLICLY-ACCESSIBLE` vs `rds-public-access` | The same issue was counted twice, or with different severities, depending on the screen. |
| Score formula ignored coverage | `calculateSecurityScore([]) === 100`; `securityScore: 100` hard-coded for new/API projects | An empty or unevaluated architecture showed 100/100. |
| Discovery fabricated S3 settings | The AWS adapter hard-coded `versioning: true, encryption: true, publicAccess: false` for every discovered bucket | Imported buckets were assessed on invented data. |
| Security scans reused finding primary keys | `SecurityFinding` IDs collided on re-scan | Persisted scans failed after the first one. |
| No provenance, no NOT_EVALUATED state | Missing data was indistinguishable from compliant | "Pass" was reported for things never checked. |

### Compliance (`lib/engines/compliance`)

| Defect | Effect |
|---|---|
| `passed: affected.length === 0`: a control passed whenever no resource of the checked type existed, e.g. logging controls with no log resources | Compliance was fabricated. Now `not_evaluated`. |
| SOC 2 backup check mapped to CC9.2 (vendor/business-partner risk) | Remapped to A1.2 (availability: backup/recovery). |
| PCI DSS control IDs used v3.2.1 numbering | Updated to v4.0 identifiers (1.3.1, 1.4.4, 3.5.1, 4.2.1, 6.4.2, 8.4.2, 10.2.1). |
| `CompliancePanel` read `r.rule.id` from a result shape that no longer had it | The panel crashed. It was rewritten for the new shape. |

### Auto-Fix

- Fixes were generic `fixAction` config patches, with no check that the finding actually cleared.
- Verification used the legacy `lib/analysis.generateTerraform`, which ignores several fields. For example, the EC2
  monitoring change produced no Terraform diff, so "verified" fixes were never reflected in Terraform.
- Nothing distinguished changes that are safe on a design-only resource from changes that force replacement on a
  deployed one. Encryption at rest is the main example.

### Templates

Template nodes stored only a partial configuration, so most rule inputs were missing. Coverage was about 29%, and the
canvas, Terraform and assessment each filled the missing fields with different defaults.

## 2. Rules removed as incorrect

These legacy IDs now resolve to `null` in `LEGACY_RULE_IDS`.

| Legacy ID | Why it was removed |
|---|---|
| `ec2-key-pair` | Flagged HIGH when an EC2 instance has **no** SSH key pair. Having no key pair (access through SSM Session Manager) is the more secure posture. No FSBP control requires a key pair. |
| `kms-short-deletion-window` | Flagged deletion windows under 14 days. AWS allows 7–30 days, and no authoritative source sets a 14-day minimum. |
| `waf-default-allow` | Flagged a web ACL whose default action is Allow. Default-allow with managed block rules is the standard pattern. FSBP WAF controls check for rules and logging, not the default action. Empty web ACLs are covered by `AWS-WAF-001`. |
| `dynamodb-encryption` | Reported "encryption disabled". DynamoDB always encrypts at rest and this cannot be turned off. `serverSideEncryption=false` means an AWS-owned key. It is replaced by `AWS-DDB-001`, an INFORMATIONAL evidence check that records which key type is used. |
| `vm-managed-disk` | The generated Terraform (`azurerm_linux/windows_virtual_machine`) only supports managed disks, so the finding described a configuration the deployment cannot have. |
| `functions-public-access` | Flagged every Function App with a public endpoint. For HTTP-triggered functions that is usually the intended interface, and the diagram does not record trigger types or front-door fronting. It could be reintroduced as a context-aware rule (see §6). |

Every other legacy ID maps to its replacement rule (for example `rds-public-access` → `AWS-RDS-001`).

## 3. What replaced them

There is one engine, `lib/engines/assessment`. It runs on the same `CanvasNode`/`CanvasEdge` graph as the canvas,
Terraform and cost engines, and is shared by client and server.

- **Provider-native rules**: 62 AWS rules (`rules/aws.ts`) and 53 Azure rules (`rules/azure.ts`). AWS rules reference
  FSBP and the AWS WA pillars (6); Azure rules reference MCSB, Azure Policy and the Azure WA pillars (5, no
  Sustainability). Tests enforce that no rule mixes providers.
- **One evaluation per (rule, resource)**, each with a status (`PASS`, `FAIL`, `WARNING`, `NOT_APPLICABLE`,
  `NOT_EVALUATED`, `INSUFFICIENT_DATA`), structured evidence (field, observed, expected, basis) and provenance
  (`DESIGN_TIME`, `DISCOVERED_CONFIGURATION`). `LIVE_VERIFIED` is never set, because field-level provenance is not
  recorded.
- **Missing required fields → `INSUFFICIENT_DATA`**, never PASS. A test asserts that every rule reads only keys that exist
  in the resource definition.
- **Stable finding IDs**: `<RULE>-<6 hex of FNV-1a(resourceId)>`.

## 4. Score and coverage methodology

- Score = 100 × (1 − Σ weight of failed checks ÷ Σ weight of evaluated checks).
- Weights: CRITICAL 10, HIGH 6, MEDIUM 3, LOW 1, INFORMATIONAL 0. A WARNING counts as half a failure.
- Caps: any failing CRITICAL caps the score at 40; any failing HIGH caps it at 70.
- Not scored when nothing weighted was evaluated. It is never shown as 100.
- Coverage = evaluated ÷ applicable checks. Below 60% the result is flagged as low coverage.
- Ratings: Strong ≥ 90, Good ≥ 75, Needs improvement ≥ 50, Weak below 50.

## 5. SOC 1-oriented analysis: scope and limits

The engine covers 11 technical control areas (logical access, data protection, operations, change management). Each one
lists the technical evidence found, the gaps, the checks it could not evaluate, and the organizational evidence it needs.
Every area always carries `REQUIRES_ORGANIZATIONAL_EVIDENCE` and `REQUIRES_AUDITOR_ASSESSMENT`.

CloudCraft does **not** perform a SOC 1 examination and does not issue an opinion. It maps design-time technical
observations to control areas as input for control owners and auditors.

## 6. Still requiring verification

- AWS FSBP identifiers, titles and severities were cross-checked against a maintained machine-readable mapping, because
  `docs.aws.amazon.com` was unreachable from the build environment. Re-check them against the Security Hub user guide.
- The AWS and Azure Well-Architected URLs and the AICPA SOC 1 reference come from existing metadata and were not verified
  in this build.
- Discovery adapters map provider APIs to canvas fields. None of this has been exercised against a live account in this
  change.
- `functions-public-access` could be reintroduced as a context-aware check once trigger type and fronting are modelled.

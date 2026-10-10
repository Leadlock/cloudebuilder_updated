# Security & Well-Architected Engine Audit (ruleset 2026.10.1)

This records what was wrong with the assessment engines before this change, and what replaced them. The full per-rule matrix is in
[RULE_MATRIX.md](./RULE_MATRIX.md).

## 0. Changes in ruleset 2026.10.1

Found by running the engine on an AI-generated design and comparing every verdict with the real configuration, and by running it on a
deliberately insecure design to confirm each check fires. The checks and the arithmetic were correct; these were the weaknesses.

| Weakness | Change |
|---|---|
| A rule was weighed once **per resource**, so a design with more resources carried more weight per rule: many passing checks hid medium and low failures and larger designs drifted toward "Strong". | A rule now counts **once**, however many resources it is checked on; its weight is shared between them and a failure is proportional (scoring.ts). CRITICAL/HIGH caps are unchanged. |
| Performance Efficiency, Sustainability and Cost had 1-2 checks each (Azure Performance 1, informational only), so a pillar score rested on almost nothing. | 15 new rules (10 AWS, 5 Azure): CloudFront compression and HTTP version, Auto Scaling scaling policy, RDS Performance Insights, Graviton (EC2, Auto Scaling, RDS), SQS long polling, log retention, App Service HTTP/2 and Always on, Front Door caching, scale set and Application Gateway autoscale. Pillar cards now show **how many different checks** a pillar rests on and flag fewer than 5 as *Limited evidence*. Sustainability (AWS) and Azure Cost and Operational Excellence are **still thin**; the card says so. |
| `AWS-VPC-003` (VPC DNS) was filed under Operational Excellence, where as a MEDIUM check it carried most of that pillar's weight. | Moved to Reliability (plan the network topology). |
| No check for load balancer, CDN or web ACL visibility. | `AWS-ELB-005` (ALB access logs), `AWS-CF-003` (CloudFront standard logging), `AWS-WAF-002` (WAF metrics and sampling). The ALB and CloudFront logging settings were added to the resource forms and reach the generated Terraform (the bucket name is validated). Full WAF request logging is still not modelled. |
| A placeholder certificate ARN (`REPLACE-WITH-YOUR-CERTIFICATE-ID`) read as "a certificate is attached". | Still a PASS, because the AI generator and templates deliberately use it and the deploy gate rejects insufficient data, but the observation now says it is a placeholder. |
| Live providers for the AWS Well-Architected Tool and Azure Advisor were never called, and the AWS one gave every pillar the same workload-wide score. | Removed, together with the two SDK dependencies only they used. The tab is design-time only. |

All new rules are LOW and manual-only, so none blocks a deployment or changes a design by itself.

### Follow-ups in the same ruleset

| Weakness | Change |
|---|---|
| A pillar score that rests on two checks (for example two low-severity findings) read as a "25", as if it were a verdict. | Pillar results now carry `evaluatedRules` (different scored rules, informational ones excluded) and `limitedEvidence` (fewer than 5). The pillar cards show a **Limited** tag and an "indicative score"; the HTML and PDF reports print "(limited)" with a one-line footnote, and the per-pillar text says "indicative: limited evidence, N checks". |
| A saved review was shown as current even after the rules changed, because the database did not record which ruleset produced it (only canvas edits marked a review stale). | New column `wellArchitectedAssessment.rulesetVersion` (additive migration `add_wa_ruleset_version`). A review from another ruleset, or from before it was recorded, is stale with `staleReason: ruleset`; the review tab re-runs a stale review automatically and says why. |
| Every "Run Review" was saved but nothing read the history. | `GET /api/projects/:id/well-architected/history` and a **Since the last review** card: score and pillar movement, findings that appeared, findings that were fixed, and a note when the ruleset changed in between. Identical consecutive re-runs collapse into one entry. |
| The claim that rules read the same settings as the resource forms and the Terraform generator was not enforced. | `__tests__/ruleSchemaConsistency.test.ts` checks, for every rule, that each setting it reads exists in the resource definition, that a default resource never gives "insufficient data", that Auto-Fix patches write real settings, and that each setting changes the generated Terraform. It found Azure Front Door `cachingEnabled` read by a rule but never emitted (fixed). Two known gaps remain, listed in the test with reasons: `aws_ebs.snapshotSchedule` (no Backup/DLM resources) and `aws_s3.loggingEnabled` (needs a target bucket). The list is itself checked, so it cannot hide a new gap or outlive a fixed one. |

### Well-Architected questionnaire

Four of the six pillars rested on one to five automated checks, because a diagram cannot show how a workload is run. The review now has
a questionnaire of practice questions (`lib/engines/assessment/questionnaire/questions.ts`, 35 questions across all pillars):
deployment and rollback, on-call, restored backups, tested DR, SSO and MFA, secrets, budget ownership, and so on.

- **An answer is a check.** Each question becomes a rule per framework it belongs to (`WAQ-AWS-REL-01`, `WAQ-AZ-REL-01`), so pillar,
  severity weight, findings, coverage and reports work unchanged. Yes passes, Partly counts as half a failure, No fails, Not applicable
  is excluded. A "No" on a HIGH question caps the pillar at 70 like any failing HIGH check.
- **Unknown is never a pass.** An unanswered question is `NOT_EVALUATED` and "Don't know" is `INSUFFICIENT_DATA`; both only lower coverage.
- **Opt-in.** Question rules are not in `ALL_RULES`; they join an assessment only when answers are supplied. A project that has not
  answered anything is assessed exactly as before, and the Security tab, the AI generator's deploy gate and stored scans never see them.
  After the first answer, unanswered questions count as not evaluated.
- **Answers belong to the project** (table `wellArchitectedAnswer`, one row per project and question, shared by its environments).
  `GET/PUT /api/projects/:id/well-architected/questions`; writing needs the owner, admin or member role; the body is validated
  (known question id, known answer, note up to 500 characters, up to 100 answers per request).
- **Consistency.** The review, the saved-review staleness check (a review made before the answers last changed is stale, reason
  `answers`) and the Well-Architected report (HTML, PDF, JSON) all include the answers, so an export says what the tab says.
- Answering enough questions is what clears a pillar's "Limited evidence" flag.

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

## 7. Production hardening pass (2026-09-24)

- **References.** docs.aws.amazon.com, learn.microsoft.com, aka.ms, azure.microsoft.com,
  aicpa-cima.com and github.com are blocked by the build environment's network policy.
  Only raw.githubusercontent.com is reachable, so primary verification could be done only
  for Microsoft's machine-readable sources:
  - All 41 MCSB control and Azure Policy references were re-verified in Azure/azure-policy
    (MCSB initiative v57.58.0).
  - All 49 FSBP IDs, titles and severities were re-cross-checked against the secondary mapping.
  - AWS FSBP, the AWS/Azure Well-Architected URLs and the AICPA reference are still
    unverified against primary documentation. The affected rules stay at
    IMPLEMENTED — LIVE/REFERENCE VERIFICATION REQUIRED.
- **Discovery integrity.** Adapters replaced missing API values with literals that read as
  discovered facts. All of these were removed; a missing value is now unknown. RDS discovery
  now maps the security settings that DescribeDBInstances returns. Field-level provenance
  (`_discovery`) separates DESIGN, DISCOVERED and LIVE evidence per field. LIVE_VERIFIED can
  only come from a fresh provider read supplied to the assessment; nothing in production
  supplies one.
- **Not evaluated.** AWS-EC2-003 (IMDSv2) is now evaluated from design, discovery and
  Terraform. The 11 remaining controls are classified in `evidenceAvailability.ts`.
- **SOC 1.** The section is renamed "SOC 1 Readiness Analysis". Evidence is separated by
  source, and every area is "not concluded".
- **Pricing and FX.** Every price and exchange rate is tiered: live, cached live, fallback
  estimate or unavailable. Azure fallback prices labelled as live were fixed. The offline UI
  no longer invents exchange rates.
- **Scores.** Coverage below 60% can no longer rate Strong or Good; those ratings become
  "Limited evidence".
- **Auto-Fix.** Full SAFE sequence tests, REVIEW preview completeness tests, forced-rollback
  tests at each verification gate, and batch verification for bulk fixes (22 s → 0.1 s at
  500 resources).
- **Platform.** Template instances get unique IDs. The migration MARKER_MISMATCH was fixed
  without resetting data (see `docs/database/MIGRATION_MARKER_MISMATCH.md`).

### Closing the last coverage gaps

- **VPC flow logs are modelled.** `aws_vpc` has `flowLogsEnabled`, `flowLogsBucket` and `flowLogsTrafficType`; `AWS-VPC-002` (LOW, so it
  never blocks the AI generator) evaluates them, and the Terraform generator writes an `aws_flow_log` to S3 only for a valid bucket name.
  ALB access logs and CloudFront logging follow the same pattern.
- **Account-level controls can be read live.** CloudTrail, GuardDuty, root MFA and AWS Config (`AWS-ACCT-001..004`) are settings of the
  account, not of the diagram. With a connected AWS account, **Account checks** in the review makes read-only calls
  (`lib/cloud/accountControls/readAwsAccountControls.ts`) through the discovery role and stores one dated reading per control
  (`accountControlEvidence`).
  - A reading counts for 7 days and is marked `LIVE_VERIFIED`; after that, or when no check was made, the control is NOT EVALUATED.
  - A refused or failed read is `UNAVAILABLE` with the permission to add. It is never a pass and never a fail.
  - A clear negative in one Region stays a FAIL even if another Region could not be read.
  - A review made before the account was last checked is stale (reason `account`). Scans and both reports use the same readings.
  - `GET/POST /api/projects/:id/well-architected/account-controls`; running a check needs the owner, admin or member role. The seven
    extra read actions are listed in `lib/cloud/discoveryPolicy.ts` and are optional: discovery works without them.
- **Still not covered:** Azure account-level controls (`AZ-ACCT-*`) stay NOT EVALUATED, and the 30 unanswered questions count until answered.

# CloudCraft Roadmap — Policy, Governance & Operations

> Status: proposal · Source: competitive review of codly.ai (website + 7 demo videos) against the current codebase.
> Effort key: **S** ≈ days · **M** ≈ 1–2 weeks · **L** ≈ multiple weeks. Estimates are rough and unvalidated.

## 1. Positioning

Codly is a **Day-2 operations** product (compliance scanning, FinOps, runbook execution on running accounts) for regulated enterprises.
CloudCraft is a **Day-0/1 design** product (canvas → Terraform → review → deploy).

We should not chase Codly's breadth (ITSM, log analytics, inventory, air-gapped, autonomous agents). We should borrow the
**ideas that make design and deployment governed**, and extend our existing review/drift machinery toward ongoing operation:

> *Design it visually, and only ever be able to design (and deploy) what your organization's policy allows.*

## 2. What already exists (do not rebuild)

A first-pass comparison overstated some gaps. Verified in the repo:

| Capability | Where | State |
|---|---|---|
| Auto-fix with preview, safety level, cost delta, Terraform verification, rollback | `lib/engines/assessment/autofix.ts` (`AutoFixPlan`, `AutoFixSafety`) | Exists — **design-time only** |
| Accepted-risk / false-positive / N-A reviews with reason, approver, **expiry**, revoke | `FindingReview` model, `lib/engines/assessment/types.ts` | Exists — needs hardening (see P1) |
| Approval gate for Terraform apply/destroy, bound to plan hash | `TerraformApproval`, `components/panels/TerraformApprovalBar.tsx` | Exists |
| Drift / modified / deleted / new-in-cloud detection | `lib/cloud/sync/InfrastructureSyncService.ts` (`detectChanges`) | Exists — **on demand only** |
| Durable background jobs (pg-boss) | `lib/jobs/queue.ts`, `workers/` | Exists |
| Org roles, environments (`envKey`, region) | `OrgMember`, `Environment` | Exists |
| Email | `lib/email/emailService.ts` | Exists — no chat/webhook channel |
| SOC 2 / HIPAA / PCI DSS mapped onto assessment rules | `lib/engines/compliance/rules/index.ts` | Exists — mapping-based by design |

## 3. Real gaps

1. **No organization policy layer.** Nothing constrains regions, instance families, AMIs, tags, or naming per org/environment.
2. **No tag governance.** The Terraform generator emits tags, but no rule or UI checks them against an approved set. (Codly's FinOps story rests on this.)
3. **Auto-fix has no risk narrative.** Plans show field changes, cost and Terraform diff, but not blast radius, reversibility or a pre-execution checklist.
4. **Drift is not continuous.** Detection exists but nothing schedules it, stores history, or tells anyone.
5. **Compliance frameworks are narrow** (3 vs Codly's 20+), and CIS/NIST — the most requested — are missing.
6. **No outbound notifications** beyond email (Slack/webhook for approvals and findings).
7. **GCP is unsupported** (adapters: AWS, Azure only).

## 4. Phased plan

### Phase 1 — Policy foundation (highest leverage)

**P1.1 Organization policy model — M**
- New `OrgPolicy` (per org, optional per-`Environment` override): approved regions, allowed instance families/types, approved AMIs/images, required tag keys + allowed values, naming pattern, required encryption/key separation per environment.
- Prisma: add model in `src/prisma/contract.prisma` + migration; repository next to `orgRepository.ts`; owner/admin-only writes.
- Versioned (like `ArchitectureVersion`) so assessments can record which policy version they ran against.

**P1.2 Enforce policy at design time — M**
- Properties panel: `ConfigField` select options filtered by policy (`components/canvas/PropertiesPanel.tsx`, `lib/resources/*`). Non-compliant values are hidden or flagged, not silently allowed.
- Validator: policy violations surfaced by `ArchitectureValidator` so the deploy workflow's validate step blocks on them.
- Assessment: a new `POLICY` domain of rules in `lib/engines/assessment/rules`, so violations flow through scoring, review/accept-risk, and reports like any other finding.
- Terraform: preflight (`lib/terraform/execution/preflight.ts`) refuses to plan/apply a non-compliant graph.
- Acceptance: with a policy of "ap-south-1 only, AMD instances only", an `eu-west-1` or Intel EC2 node cannot be generated or applied, and the reason names the policy.

**P1.3 Tag governance — S/M** (depends on P1.1)
- Rules for required keys / allowed values on taggable resources; one-click "apply approved tags" through the existing auto-fix path.
- Acceptance: every taggable resource in a generated Terraform plan carries all required tags with allowed values.

**P1.4 Exceptions hardening — S**
- Extend `FindingReview`: optional evidence/attachment reference, ticket/link field, restrict who may approve (role check against `OrgMember.role`), exception report/export, and show "N accepted risks, M expiring in 30 days" next to the score so exceptions don't inflate it silently.
- Acceptance: an expired exception reverts the finding to OPEN on the next assessment and appears in the report.

### Phase 2 — Safer remediation

**P2.1 Remediation risk report — M**
- Extend `AutoFixPlan` with: blast radius (resources affected beyond the target, via the relationship graph), reversibility (does the patch destroy/replace — derivable from the Terraform diff and rule metadata), risk by dimension (availability / security / data integrity / access), and a pre-execution checklist.
- Render in the existing auto-fix confirmation UI; carry a short form into `TerraformApproval.summary` so approvers see it.
- Acceptance: enabling encryption on a deployed RDS instance is labelled "replacement — not reversible" with the checklist shown before apply.

**P2.2 Extend auto-fix from design to discovered accounts — L** (later)
- Today fixes patch the canvas graph and flow out through Terraform. For imported resources, generate a reviewed Terraform change rather than direct API writes, keeping the read-only discovery guarantee.

### Phase 3 — Continuous posture

**P3.1 Scheduled drift + posture scans — M**
- pg-boss recurring job (reuse `lib/jobs/queue.ts`) that runs `detectChanges` and the assessment per connected account/project; persist runs; show trend (score over time already exists for Well-Architected history — reuse its shape).
- Acceptance: new-in-cloud / drifted / deleted resources are visible with a timeline and without a manual refresh.

**P3.2 Notifications — S/M**
- Generic outbound webhook + Slack for: approval requested/decided, drift detected, critical finding, exception expiring. Per-org config; secrets encrypted like cloud-account credentials.

**P3.3 More frameworks — M each** (mapping-only, reuse the pattern in `compliance/rules/index.ts`)
- Order: CIS AWS/Azure Benchmarks → NIST CSF → ISO 27001 Annex A. Keep the existing disclaimer: technical indicators ≠ compliance.
- Add to the existing rule/form/Terraform consistency guard so mappings can't drift from rule IDs.

### Phase 4 — Optional, demand-driven

| Item | Effort | Note |
|---|---|---|
| Policy-based waste rules (e.g. prod snapshot > 30d, non-prod > 7d) | M | Needs discovery data; build on P1.1 |
| Cost anomaly / forecast on connected accounts | L | Requires billing API access — new permission scope |
| Budgets & chargeback | L | Only if we commit to FinOps buyers |
| Natural-language Q&A over cost/inventory | M | After the data exists |
| GCP provider | L | Adapter + resource catalog + pricing + rules |

## 5. Explicitly out of scope

Autonomous agent loops that mutate live accounts, ITSM/log-analytics/inventory modules, air-gapped deployment, and RBI/SEBI-specific
frameworks (unless we target that market deliberately). Codly's own demos show *human-triggered* remediation, so the autonomy claim isn't a gap we need to close.

## 6. Risks & open questions

- **Policy UX complexity.** Per-environment overrides can become unmanageable; start with org-level plus an env override of the same schema.
- **Policy vs. generated AI architectures.** The AI generator (`lib/ai/*`) must be policy-aware or it will emit designs the validator rejects.
- **Backward compatibility.** Existing projects have no policy; default must be "no policy = no restriction", with findings (not blocks) first.
- **Open:** who approves exceptions (owner/admin only?). Does the approval gate need a second approver? Which frameworks do target customers actually ask for?

## 7. Suggested order

`P1.1 → P1.4 (parallel) → P1.2 → P1.3 → P2.1 → P3.1 → P3.2 → P3.3`

P1 alone delivers the most visible Codly-style outcome — users cannot pick a non-compliant option — using models, rule engine and
approval flow we already have.

*Basis: competitor claims come from marketing pages and a handful of low-view demo videos; verify against a real trial/demo before
treating any as a spec.*

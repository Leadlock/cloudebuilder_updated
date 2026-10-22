# Scan of the generated files

CloudBuilder generates Terraform, Dockerfiles and Kubernetes manifests for its customers. `scripts/scan-generated.ts` generates a spread of them (every
deployment target as a project and as a single service, the release variants, and 18 canvas designs on AWS and Azure) and scans them with
[Trivy](https://github.com/aquasecurity/trivy) for misconfigurations. It runs in CI (the `scan-generated` job) and by hand:

```bash
npx tsx --tsconfig tsconfig.json scripts/scan-generated.ts            # needs Docker (the pinned Trivy image) or TRIVY_BIN
```

- **Pinned.** `security/trivy.json` names the Trivy version and the image by digest, and the scan uses the checks inside that version (`--skip-check-update`), so the same files always give the same findings. To move to a newer Trivy, change the pin, run the scan, and decide what is new.
- **The policy** is `security/scan-policy.json`. A finding at `failOn` (HIGH) or above fails the scan unless its rule has a decision with a reason: `accept` (this is how the product is meant to behave) or `todo` (a known gap that may not grow: `max` is the count today). A decision about a rule that no longer fires must be removed. Lower severities are counted in the report and do not fail.
- **The report** (`scan-report.md`, also in the GitHub job summary and the `scan-report` artifact) lists every rule that fired with its severity, Well-Architected pillar, how many findings and in how many cases.
- **What it is, and is not.** It finds misconfigurations in the files we generate: it is evidence for a design and generated-files review, and a way to see where our own generators fall short. It is not a Well-Architected review. It cannot see how a workload is run, what it costs, or whether recovery has been tested.

## What the first scan found (35 cases, Trivy 0.76.1)
82 critical, 107 high, 96 medium and 123 low findings. Of the 19 critical and high rules, 6 are accepted with a reason (open egress, a public load balancer, plain HTTP without a certificate, S3-managed keys) and 13 are known gaps with a ceiling. The ones that are real defects in the generators, to fix and then remove from the policy:

| Rule | What | Where |
| --- | --- | --- |
| DS-0002 | The Frontend image's Dockerfile runs as root | project Dockerfiles |
| AWS-0052 | Canvas load balancers do not drop invalid headers | canvas AWS designs |
| AWS-0130 | Canvas launch templates do not require IMDSv2 | canvas AWS designs |
| AZU-0042 | AKS RBAC is on by default but not stated, so it cannot be seen | AKS targets |
| KSV-0014, KSV-0118 | Generated Deployments have no read-only root filesystem or pod security context | Kubernetes and AKS |

The others (key vault and storage network rules, AKS authorized ranges and network policy, mutable ECR tags, no WAF in front of CloudFront, trusted-service bypass) need a setting or a customer decision before they can be fixed.

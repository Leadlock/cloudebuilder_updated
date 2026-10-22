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

## What the scan found, and what was fixed
The first scan (35 cases, Trivy 0.76.1) found 82 critical, 107 high, 96 medium and 123 low findings. Four defects in the generators were then fixed and their decisions removed from the policy, which took the high findings to 81:

| Was | Fix |
| --- | --- |
| DS-0002: the static Frontend Dockerfile did not say which user it runs as (the image is nginx-unprivileged, so it was not root) | `USER 101` in the final stage |
| AWS-0052: canvas application load balancers did not drop invalid headers | `drop_invalid_header_fields = true` (not on network load balancers, where it is not valid) |
| AWS-0130: canvas launch templates did not require the instance metadata session token | `metadata_options` with `http_tokens = "required"` and a hop limit of 2 |
| AZU-0042: AKS role-based access control was on by default but not stated | `role_based_access_control_enabled = true` |

Of the critical and high rules that remain, 6 are accepted with a reason (open egress, a public load balancer, plain HTTP without a certificate, S3-managed keys) and 9 are known gaps with a ceiling. Still to fix, and then to remove from the policy: KSV-0014 and KSV-0118 (a read-only root filesystem and a pod security context in the generated Deployments, which needs a writable temp folder per stack and a test of every stack's image with `--read-only`). The others (key vault and storage network rules, AKS authorized ranges and network policy, mutable ECR tags, no WAF in front of CloudFront, trusted-service bypass) need a setting or a customer decision first.

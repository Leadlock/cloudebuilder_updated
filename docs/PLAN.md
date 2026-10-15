# Plan

Where the work stands and what comes next. Effort: S is under a day, M a few days, L a week or more. Update the status column as items finish.

## Done so far

- **Security:** no built-in passwords or SSH key in generated Terraform or in the runner; no stand-in admin under `next dev` and the dev server listens only on this machine; earlier fixes to login checks and unused identity headers.
- **Cost:** prices fixed across the engine; the AI generator no longer shows an estimate.
- **Well-Architected review:** audited and fixed, plus a questionnaire, review history and live AWS account checks (CloudTrail, GuardDuty, root MFA, AWS Config).
- **Container Templates:** Dockerfile, compose and env files for Node, Python, Java and static sites; Deploy to EC2 with `deploy.sh` / `destroy.sh`; GitHub Actions workflow and its AWS role; sample apps and starter templates. Security checks (16 kinds), a Trivy image scan in the workflow, an EC2 cost estimate, templates saved for the organization, and a "Container service" canvas node (cost, review, Terraform, policy). More deploy targets: AWS ECS Fargate (load balancer, autoscaling, HTTPS), Azure Container Apps (secrets in Key Vault), an Azure VM (Key Vault secrets, no SSH), AKS (cluster, registry, the Kubernetes manifests, secrets from Key Vault through the CSI driver and workload identity), and Kubernetes manifests with a Helm chart for any cluster; one target at a time. On the canvas: Docker on EC2, Docker on an Azure VM, and the existing Container Apps resource all open in Container Templates and can be filled from it. Run an image that already exists (nginx:1.27, ghcr.io/you/app:1.0) on any target instead of building one: no Dockerfile, no registry, public images only. Stacks: Node, Python, Java, Go, .NET, Ruby, static. Companion services in compose: PostgreSQL, Redis, MySQL, MongoDB, RabbitMQ, and a Caddy HTTPS proxy. `scripts/validate-containers.ts` runs `terraform validate`, `kubectl kustomize` and `helm lint` on them in CI.
- **Azure:** private endpoints, PostgreSQL, MySQL, Service Bus, Container Registry, Azure Monitor, Firewall, Event Hubs, Event Grid, API Management, Container Apps; NSGs and route tables attached to subnets; Front Door origin and WAF; static websites; discovery and cost comparison for the new services. `scripts/tf-validate-azure.ts` runs `terraform validate` on the generated code.

## Phase 1: close the remaining holes (about 1 week)

| # | Task | Why | Done when | Status |
|---|---|---|---|---|
| 1 | CI workflow (S) | Nothing ran on a push, so regressions went unnoticed. | `tsc`, lint, tests, the production build and the Terraform validation run on every push and pull request, and a red build blocks merging. | Workflow added (`.github/workflows/ci.yml`); making it required is a GitHub setting (see the file's header) |
| 2 | Remove the other dev-only shortcuts (S) | A signed-in user with no organization gets a shared "dev org" with sample data. Under `next dev` any owner or admin can run Terraform with no allow-list. | Both need an explicit opt-in flag, with tests. | Done: all development shortcuts need `CLOUDCRAFT_DEV_SHORTCUTS=1` as well as `NODE_ENV=development` (`lib/dev/shortcuts.ts`) |
| 3 | Stop flaky tests (S) | `assessmentPerformance` is timing based and fails under parallel load. Retrieval accuracy is 96% against a 95% bar. | The suite is green three runs in a row. | Done: the timing guard passes if any of five attempts is within the limit; the full suite passed twice under 8 CPU burners. Retrieval search now combines meaning and words (89% to 99% first-choice accuracy on the held-out set, 82% to 89% on the hand-written one) |
| 4 | One worktree per task (S) | Two sessions mixed their changes in one folder. | Documented in the README, with a helper script. | Open |

## Phase 2: prove it works on a real cloud (about 1 to 2 weeks)

| # | Task | Done when |
|---|---|---|
| 5 | Deploy one Azure design to a throwaway subscription (M). Everything so far is checked by `terraform validate` only; expect API-level failures (names taken, a region without zones, quotas). | A design applies, works, and destroys cleanly; every failure found is fixed and covered by a test; a "plan only" check runs on a schedule. |
| 6 | Run the Container Templates EC2 deploy once on a test AWS account (M). | `deploy.sh` then `destroy.sh` work end to end. |
| 7 | Build the generated Dockerfiles for real (S). | A test builds all four sample apps. |

## Phase 3: finish the product gaps (2 to 3 weeks)

| # | Task |
|---|---|
| 8 | One-click "Add Private Endpoint" from the review screen (M). |
| 9 | Org policy covers the new resources (PostgreSQL, MySQL, Container Apps sizes) and can block a deploy as well as warn (M). |
| 10 | Live price lookups for the new Azure services; today they use stored prices (M). |
| 11 | Container Templates: saved templates, and a canvas "Container service" node that feeds cost, review and Terraform (L). Done: saved templates (`/api/container-templates`), node `aws_container_service` with cost, 4 review rules (`AWS-CTR-001` to `004`), Terraform, relationships and org policy. Not yet applied to a real AWS account; the Terraform is validated in CI. |
| 12 | Remaining Azure gaps: Front Door Premium with Private Link, Event Grid subscriptions, role assignments for Entra-only access, Logic Apps (M each). |

## Done: deploy access without editing `.env` per organization

Nothing has to be configured. The person who first signed up is the operator (`CLOUDCRAFT_OPERATOR_EMAILS` overrides that) and enables Terraform for their own organization with one click; they approve, deny or revoke others on the "Deploy access" page. Any other organization enables it itself once its owner has the authenticator app on, it has a cloud account that passed its check and, on a production server, the server has its own encryption key (`CLOUDCRAFT_TERRAFORM_AUTO_APPROVE=0` makes every request wait for an operator). The old `CLOUDCRAFT_TERRAFORM_ORG_IDS` list still works as an override. Every request and decision is in the Terraform audit trail.

## Server software (done)

EC2 and Azure VM nodes have an "Install on the server" setting (nginx, Apache, PHP, Node.js, Python, Java, Docker, Git, MariaDB, PostgreSQL, Redis). The software is installed at first boot by a generated script (`lib/engines/servers/software.ts`), the web ports are opened only to the range the person types, and EC2 finds the current OS image by name. The `server-software` CI job runs the script for every item in Amazon Linux 2023, Ubuntu and Debian containers. Nothing has been run on a real AWS or Azure account yet.

## Databases as containers (done)

Container Templates has a Stack area with Frontend, Backend, API and Database. A database (PostgreSQL, MySQL, MongoDB, Redis, RabbitMQ) runs from its official image with a data volume, passwords from the secret store, and a port that is never open to the internet. It deploys to EC2 or an Azure VM (the data folder is kept even if a setting changes) or runs with Docker Compose; ECS, Container Apps, Kubernetes and AKS refuse it and point to the cloud's managed database. The `databases` CI job starts each engine from the generated files, checks the password and that data survives a replaced container. It is not yet offered on the canvas (add RDS or Azure Database there) and not on Kubernetes (needs a StatefulSet).

## Phase 4: code health (ongoing)

| # | Task |
|---|---|
| 13 | Split `TerraformGenerator.ts` (4,500 lines) and `rules/azure.ts` (1,100 lines) by service. |
| 14 | Stop committing regenerated datasets in every change (thousands of lines each time); regenerate them in CI. |

## Open decisions

1. Is there a throwaway Azure subscription and AWS account for Phase 2? Real credentials are never used without an explicit go-ahead.
2. Should org policy be able to block a deploy, or stay advisory?
3. Is the goal to ship to real users soon (Phase 2 before 3) or to keep building features?

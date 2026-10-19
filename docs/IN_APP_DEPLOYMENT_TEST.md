# Trying "Deploy from CloudBuilder" on a real Azure subscription

This is the checklist for the first real run. Everything below the cloud (the state machine, the routes, the zip reader, the panel) is tested with fakes;
**the Azure REST calls and the generated Terraform and start-up scripts have never run against Azure.** Expect to find something. Use a throw-away subscription.

## 0. What you need
- An Azure subscription you may spend a few dollars in, with a **service principal** connected in CloudBuilder (Cloud Accounts) that has **Owner**, or **Contributor +
  User Access Administrator**, on it. Terraform creates role assignments (AcrPull, Key Vault Secrets Officer/User), so Contributor alone is refused. The principal also
  stores secrets in the Key Vault it creates: that works through the Key Vault Secrets Officer role Terraform gives it (it can take a minute to apply; CloudBuilder retries for 5 minutes).
- A **storage account and container** for Terraform's state (the Deploy tab's "create backend" button makes one). The deployment uses its own state file in it.
- You are on the restricted-features list and an owner/admin; Terraform access is approved for your organization (same as the Deploy tab).

## 1. Switch it on (on the machine that runs CloudBuilder)
1. Put `CLOUDBUILDER_PROJECT_RELEASES=1` in `.env` and restart the web server **and** the worker (`npm run worker:terraform-apply`, or `pm2 restart cloudcraft-web cloudcraft-tf-apply --update-env`).
2. The database must have the two new tables: `npm run db:migrate` (or `prisma db migrate`). Migrations: `add_project_releases`, `add_project_sources`.
3. Behind nginx: `client_max_body_size 6m;` so a zip of up to 5 MB can be uploaded.

## 2. Make the project
Container Templates, then Stack: tick **Backend** and **API** (add Frontend and Database on a second run). Choose **Azure VM** under "Deploy to". For the first run leave the
sample apps (tick "Include a sample app" on each part) so there is something to build; the "Deploy from CloudBuilder" box appears under the settings.

## 3. Run it
1. Pick the Azure account; check the state storage (prefilled from the Deploy tab); **Plan the deployment**. You should see "N to create, 0 to change, 0 to destroy" and a cost.
2. Enter your password (and authenticator code if asked) and **Confirm and deploy**.
3. Watch the steps. The first ones take the longest (Terraform about 5 to 10 minutes). When it says it waits for secrets, enter them (the database password is yours to choose: letters, digits and `. _ ~ -`) and press the button.
4. When it succeeds it shows the address. Open it.

## 4. What to check, and what to send me if it fails
| Step | If it fails, send | Likely cause |
|---|---|---|
| Plan | the message in red | state storage name, permissions, a Terraform error |
| infrastructure | the release's last log lines | role assignment missing (AuthorizationFailed), quota or SKU not available in the region |
| secrets | the message | the role has not applied yet (wait and press Continue); the principal lacks Key Vault Secrets Officer |
| build | the message (it includes the end of the build log) | a Dockerfile problem; the registry task not allowed in the subscription |
| publish / start | the message | the VM agent is not ready yet (wait, Retry) |
| verify | the message | the address is closed to your network (the range in "who can connect"), or the services are still starting |

Server side, the worker log (`pm2 logs cloudcraft-tf-apply`) has one line per step (`[project-release …]`) and the audit trail records every request (`action: release`).

## 5. Then try
- **A second release** (change the image tag): it should plan with no changes to the VM, build, publish and restart without replacing the VM; database data (if ticked) survives.
- **Put an earlier release back** ("Earlier releases that worked").
- **Your own code**: upload a zip for one service; the generated Dockerfile builds it.
- **A failing release**: use a tag that does not build; the previous release should keep answering.
- **Remove everything**: preview, type the project name, confirm. Check in the portal that `rg-<project>` is gone and the page says "destroyed".

## 6. Cost and cleanup
About $60 to $90 a month while it runs (VM, disk, IP, registry). Always finish with **Remove everything** (or `az group delete -n rg-<project>`); a key vault that was deleted by hand stays soft-deleted for 7 days, and the next deployment of the same project recovers it.

---

# The same on AWS (EC2 target)

Pick **AWS EC2** as the project's deploy target; the panel then asks for an AWS account and an S3 state bucket. Same caveat: the AWS calls (CodeBuild, SSM, S3,
Parameter Store) and the generated Terraform have only been checked with `terraform validate` and fakes. Use a throw-away account.

## What you need
- An AWS account connected in CloudBuilder with a role that can create what the bundle creates: EC2, VPC pieces, ECR, S3, IAM roles and instance profiles, CodeBuild, plus
  `ssm:PutParameter/GetParameter/SendCommand/GetCommandInvocation` and `s3:PutObject/GetObject/DeleteObject/HeadBucket`. (Admin on a test account is simplest.)
- An **S3 bucket** for Terraform's state (and optionally a DynamoDB lock table) that already exists. The deployment uses its own state file in it.
- Same restricted-features and approval requirements as above.

## What happens
Terraform creates the instance (with Docker and the SSM agent), an ECR repository per built service, a release bucket (`compose.yml`, `release.env`), a source bucket and a
CodeBuild project. Secrets you type go straight to Parameter Store under `/<project>/<NAME>`. Images are built by CodeBuild from the generated sample (or your zip) and
pushed to ECR; the release files are written to the bucket and the service is restarted over SSM; the page then checks the address.

## What to check
- A first release reaches `succeeded` and the address answers (port 8080 by default; allow a minute after start).
- A tag that does not build fails at `build` and the previous release keeps answering. A release whose address does not answer is rolled back to the previous one.
- **Remove everything** deletes the Terraform-made resources. **Parameter Store secrets are not Terraform-managed and stay**: delete `/<project>/*` by hand.
- CodeBuild needs a few minutes the first time (image pulls); CloudBuilder gives up on a build after 30 minutes.

## Cost
A small instance, Elastic IP (if ticked), ECR storage and CodeBuild minutes: roughly $15 to $40 a month plus builds. Always finish with **Remove everything**.

---

# ECS Fargate (AWS)

Pick **AWS ECS Fargate** as the project's deploy target. It needs the same AWS account, role and S3 state bucket as the EC2 target above, plus ECS permissions
(`ecs:*` on the cluster, `elasticloadbalancing:*`, `servicediscovery:*`, `iam:PassRole` for the two task roles). Same caveat: only `terraform validate` and fakes so far.
**No database**: tick Frontend, Backend and API only, and give the Backend/API a secret `DATABASE_URL` that points at RDS.

## What happens
Terraform creates the cluster, an ECR repository per built service, a load balancer that reaches the public service, a Service Connect namespace (so `api` and `backend`
resolve as in Docker Compose), the task definitions and the services with **zero tasks**, and the CodeBuild project. You then type the secrets (Parameter Store,
`/<project>/<NAME>`); CodeBuild builds the images; CloudBuilder registers a new task definition revision per service with the new tag, starts the services with the task count
and waits until every service has one finished deployment with all tasks running; finally it checks the load balancer address.

## What to check
- The release reaches `succeeded`; the address (the load balancer's DNS name) answers a minute or so after the services are steady.
- **Service Connect names**: from the frontend, `api` / `backend` must resolve (a static frontend's nginx proxies to them). If a frontend fails at start with "host not found", tell me: that is the first thing to look at.
- A tag that does not build fails at `build`; one whose tasks cannot start fails at `start` (ECS's circuit breaker rolls the service back, then CloudBuilder puts the previous images back).
- **Put an earlier release back** registers a revision with the old tag and starts the services on it; nothing is built.
- **Remove everything** deletes the Terraform-made resources. Parameter Store secrets stay, and old task definition revisions stay registered (they are free).

## Cost
Per service: a Fargate task (default 0.5 vCPU / 1 GB), plus one load balancer (about $22 a month), public IPv4 addresses and logs; at the default size the page shows the estimate (about $90 for three services with one task each, about $22 per extra task). Always finish with **Remove everything**.

---

# Azure Container Apps

Pick **Azure Container Apps** as the project's deploy target. Same Azure account, role and state storage as the Azure VM target above (Owner, or Contributor + User Access Administrator).
**No database**: tick Frontend, Backend and API only, and give the Backend/API a secret `DATABASE_URL` that points at Azure Database for PostgreSQL / MySQL. A release needs at least 1 minimum replica.

## What happens
Terraform creates the resource group, registry, Key Vault (with a *marker* in each secret, tagged `cloudbuilder=placeholder`), identity, environment and one Container App per service, with **zero replicas** and a placeholder
image. You then type the secrets (they replace the markers in Key Vault); the registry builds the images; CloudBuilder points each built app at its new image (a new revision) and scales every app to the minimum replicas,
waiting until each newest revision is ready and running; finally it checks the public address.

## What to check
- **The first apply**: Terraform writes the Key Vault markers right after assigning itself the Secrets Officer role; a 403 there is the role not having taken effect yet. Run the plan/apply again after a minute.
- **App names**: the services call each other as `http://<project>-api` (no port; Container Apps ingress listens on 80), and the frontend's nginx sends that name as the Host header. If the frontend gets 404/502 from `/api/`, that is the first place to look.
- A tag that does not build fails at `build`; one whose revision never becomes ready fails at `start`, and CloudBuilder puts the previous images back.
- **Put an earlier release back** points the built apps at the old tag and starts them; nothing is built.
- **Remove everything** deletes the resource group's Terraform-made resources (including the Key Vault, purged).

## Cost
Per app: replicas billed by use after the monthly free grant, plus a Basic registry (about $5) and almost nothing for the vault and logs; the page shows the estimate.

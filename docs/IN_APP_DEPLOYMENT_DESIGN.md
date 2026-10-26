# Design: deploying a project from inside CloudBuilder

Status: phase 1 (Azure VM) and phase 2 (AWS EC2: CodeBuild, Parameter Store, S3 release bucket, SSM restart) and ECS Fargate (a service per service behind one load balancer, Service Connect, task definition revisions per release) are built and tested with fakes and, for the database and the zip reader, against real Postgres and hand-made hostile archives. Neither has been
run against a real cloud account. Switched off by default (`CLOUDBUILDER_PROJECT_RELEASES=1`). How to try it: [IN_APP_DEPLOYMENT_TEST.md](IN_APP_DEPLOYMENT_TEST.md).
Built: release state machine with waiting-for-secrets, retry from the failed step, automatic and manual rollback, cancel and kill switch; Azure REST operations; the
Terraform plan/approval/apply path through the existing machinery; routes; worker queue; the panel; uploaded code (zip); teardown. Phases 2 to 4 (EC2, AKS and Kubernetes, Git sources) are not built.
Written 2026-10-16.

## 1. The problem

Container Templates can already produce a complete deployment for a project of several services (Frontend, Backend, API, Database): Terraform plus a `deploy.sh` for an EC2 server, an Azure VM, any Kubernetes cluster, or AKS. Today the person downloads the files and runs `bash deploy.sh` in their own terminal. The goal is a **Deploy** button that does this from inside CloudBuilder, against a connected cloud account, with the safety rules the Deploy tab already has.

## 2. What already exists and is reused unchanged

| Need | Existing piece |
|---|---|
| Who may deploy | `RESTRICTED_FEATURES_ALLOWED_EMAILS`, the org's Terraform access record, owner/admin role (`lib/api/terraformAccess.ts`) |
| Cloud credentials | Connected cloud accounts, short-lived credentials from `resolveExecutionCredentials` (role is assumed; Azure service principal) |
| Remote state | The mandatory state backend and its provisioner (`stateBackendProvisioner.ts`) |
| Plan, then confirm | Plan generation with guardrails, a plan hash, single-use approvals bound to that hash (`approvals.ts`, `passwordConfirm.ts`) |
| Durable background work | pg-boss queue, the apply worker, progress records, worker heartbeat, project lock, kill switch (`terraformApplyJob.ts`, `applyProgress.ts`, `projectLock.ts`) |
| Destroy | Preview, typed confirmation, run (`destroyPlans.ts`, `destroyConfirmation.ts`) |
| Audit | `recordTerraformAudit` |
| Required cloud permissions card | `requiredPermissions.ts` |

What is **new** is everything the generated `deploy.sh` does that is not Terraform.

## 3. What `deploy.sh` does, and what each piece becomes

| Step in `deploy.sh` | Azure VM | EC2 | AKS | Kubernetes |
|---|---|---|---|---|
| Create infrastructure | Terraform | Terraform | Terraform | none (cluster already exists) |
| Store secrets | Key Vault | SSM Parameter Store | Key Vault | cluster Secret |
| Build images | ACR build | **needs a builder** | ACR build | **needs a builder and a registry login** |
| Put the compose file / manifests in place | VM run-command | Terraform (S3 object) | kubectl apply | kubectl apply |
| Restart and wait | VM run-command + HTTP check | SSM send-command + HTTP check | rollout status | rollout status |

Terraform steps go through the existing plan/approve/apply machinery. The rest become **typed steps** (section 5).

## 4. Decision: typed steps, not "run deploy.sh on the server"

Running the generated script on the worker would be the fastest build, and I recommend **against** it:

- It runs `terraform apply` itself, which bypasses the plan hash and approval gate.
- It needs `az`, `docker`, `kubectl` and `aws` installed on the CloudBuilder host and signed in as someone.
- It prompts for secrets on a terminal, so secrets would have to be fed through stdin and shell variables on a shared host.
- Its inputs end up inside shell source (even though they are validated), a bigger surface than function arguments.

Instead, each step is a TypeScript function with a fixed signature and injected cloud clients, so each can be unit-tested with fakes and audited individually. `deploy.sh` stays what it is: the way to deploy from your own terminal.

## 5. Architecture

```
Browser (Container Templates, "Deploy from CloudBuilder")
   │  1. choose account, state backend, source, secrets, image tag
   ▼
API  POST /api/projects/:id/releases/plan
   │  - same gates as plan (email list, org access, owner/admin, kill switch, rate limit)
   │  - regenerate the bundle from the saved project (never trust files from the browser)
   │  - bundleHash = SHA-256 over every generated file + target + tag + source digest
   │  - terraform plan (existing) → planHash
   │  - secrets: names only are recorded; values are written to the cloud's secret store NOW,
   │    by the API, over the connected account, and are never kept by CloudBuilder
   │  returns: releaseId, plan summary, step list, cost estimate
   ▼
Person reviews, confirms with their password (approval bound to releaseId + bundleHash + planHash)
   ▼
API  POST /api/projects/:id/releases/:rid/run   → enqueue job { releaseId, orgId, accountId } (no secrets, no credentials)
   ▼
Worker (second queue in the existing terraform-apply worker process)
   steps, in order, each idempotent:
   1 infrastructure     existing runApply on the saved plan
   2 build images       cloud-side build (ACR build / CodeBuild)
   3 publish release    compose file + tag to the VM / S3, or manifests to the cluster
   4 start              restart service / rollout
   5 verify             HTTP health check of the public service, processes stay up
   6 record             store release outputs (url, ids), mark previous release as rollback target
   on failure of 3-5: roll back to the previous release automatically (section 8)
   ▼
Browser polls progress (existing progress-store pattern): step list + sanitised log tail
```

### Data model (two tables, following the `terraformApproval` pattern)

- `projectRelease`: id, orgId, projectId, environment, target, bundleHash, planId, planHash, imageTag, status (`planned | approved | running | succeeded | failed | rolled_back | cancelled`), steps (JSON: name, state, startedAt, finishedAt, message), createdBy, timestamps. **No secret values and no credentials.**
- `projectDeployment`: one row per project and environment: current releaseId, previous releaseId, public URL, resource ids (instance id, registry name, vault name, cluster name).

### Where code goes

`lib/deploy/project/` (steps, orchestrator, release store), `app/api/projects/[id]/releases/...` (plan, run, status, rollback, destroy), a `ProjectDeployPanel` opened from the Deploy card, and a second queue `project-release` served by the existing worker. The bundle comes from `generateProjectFiles`, so the in-app and terminal paths can never drift apart; a test asserts the step sequence matches the generated `deploy.sh` for every target.

## 6. The hard problems

### 6.1 Where does the user's code come from?

Container Templates produces Dockerfiles and an optional sample app; real code is put into the service folders by the person. Server-side deployment needs a source:

| Source | Phase | Notes |
|---|---|---|
| The generated sample apps | 1 | Proves the whole pipeline end to end with no source handling |
| Git repository per service | after 4 | The code of a service can be taken from a Git repository instead of a zip (see below). |
| Zip upload per service | 1 | Size cap, zip-slip and symlink rejection, no executable bits needed, stored encrypted with a short TTL |
| Git repository + branch/commit | 3 | Read-only deploy token stored encrypted, host allow-list, SSRF checks, shallow clone in an isolated temp dir |

### 6.2 Building images without Docker on the CloudBuilder host

Builds must run **in the customer's cloud**, not on CloudBuilder's machines (untrusted code, CPU, disk):

- **Azure:** ACR Tasks: upload the source to the registry and call `scheduleRun` (a `DockerBuildRequest`). No Docker anywhere.
- **AWS:** AWS CodeBuild. Terraform creates a small CodeBuild project and an S3 source bucket for the release; the step uploads the source and starts the build, which pushes to ECR. This adds resources to the EC2 bundle.
- **Kubernetes (any cluster):** needs a registry the user owns plus a builder; deferred (phase 4). The terminal path covers it meanwhile.

### 6.3 Secrets

- Entered in a write-only form, sent over TLS to the API, **written straight to Key Vault / SSM by the API** with the account's credentials, then dropped. CloudBuilder's database, queue payloads, logs and progress records never contain a value.
- The database password can be generated server-side with `crypto.randomBytes` and written the same way, never returned.
- Same character rule as the scripts (`[A-Za-z0-9._~-]`) because the value is embedded in a connection URL.
- Log lines are scrubbed of any value that was just written (belt and braces: the steps never print values).

### 6.4 What the approval covers

The existing approval binds to `planId` + `planHash`. A release has more than a plan, so the approval binds to **`releaseId` + `bundleHash` + `planHash`**: changing the tag, the source, the target or any generated file invalidates it. Policy modes stay as they are (`password` default, `required` for a second approver, `off`).

### 6.5 Credentials and least privilege

The connected role needs write access to the services the bundle uses (registry, vault, VM, role assignments; for AWS also ECR, S3, SSM, CodeBuild, IAM roles). `requiredPermissions.ts` is extended to produce that policy **per bundle** and show it before the first run, as it does today for canvas architectures. Terraform creates role assignments, so Azure needs Owner or Contributor plus User Access Administrator; the card says so.

### 6.6 New dependencies

Azure: `@azure/arm-containerregistry` (builds), `@azure/keyvault-secrets` (data plane), `@azure/arm-compute` (already present, run-command). AWS: `@aws-sdk/client-ssm`, `client-ecr`, `client-codebuild`, `client-s3` (present). Kubernetes (phase 3): `@kubernetes/client-node`, or a checksum-pinned `kubectl` binary managed like Terraform (`binary.ts`).

## 7. Safety rules (all enforced server-side)

1. The browser never supplies files: the server regenerates the bundle from the saved project and hashes it.
2. Only the restricted-features list, an org with Terraform access, owner/admin; kill switch honoured by queued jobs.
3. One release per project at a time (project lock); rate limit on plan.
4. Typed steps with validated arguments; no shell is built from user input; no generated script is executed by the server.
5. A release that fails after infrastructure exists does **not** destroy it automatically. It stops, reports the step, and offers retry-from-step or rollback.
6. Cost shown and acknowledged before approval (the estimate already exists per target).
7. Destroy keeps the typed-confirmation flow and says explicitly when a database's data lives on the machine.
8. Audit entry per step: who, what, release id, outcome. No values.
9. Zip/Git input limits, isolated temp directories, deleted after the build.

## 8. Failure, retry and rollback

- Every step is idempotent (create-if-missing, overwrite-with-same, restart).
- **Retry from step N** reuses the same release and approval while it is unexpired.
- **Automatic rollback** for steps 3-5: the previous release's tag and compose/manifests are restored and the service restarted, then verified. If there is no previous release the infrastructure is left running and the failure is reported.
- **Manual rollback** is a button that starts a release pointing at the previous release's bundle (no rebuild, no plan).
- Terraform failures keep the existing behaviour: no retry, report, re-plan.

## 9. Phases

| Phase | Scope | Exit check |
|---|---|---|
| 0 | Real first deployment from the terminal into a test subscription (the scripts as they are). Fix what breaks. | A project reachable on a real VM, destroyed cleanly |
| 1 | Azure VM: sample apps and zip source; ACR build, Key Vault, run-command; release table, plan/approve/run/status UI, rollback, destroy | Same project deployed from the UI into the test subscription; typed steps match `deploy.sh`; fakes cover every step and failure |
| 2 | EC2: CodeBuild, SSM, S3 | Same on AWS |
| 3 | AKS: kubeconfig from ARM, manifests applied by a managed `kubectl`; Git sources | Same on AKS |
| 4 | Kubernetes with a user registry; drift view; scheduled redeploys | |

Phase 0 is not optional: the generated Terraform and start scripts have never run against a real cloud, and the in-app version would otherwise be debugging them inside a background worker.

## 10. Testing

- Unit: each step against fake SDK clients (success, retry, partial failure, idempotent repeat); the orchestrator state machine, resume and rollback; the approval binding (changed bundle, tag or source invalidates it); secret handling (a test greps every table row, queue payload, log and progress record for the secret values used).
- Contract: for every target, the step list equals the `deploy.sh` sequence generated for the same project.
- Security: zip bomb, zip-slip, symlink, oversized upload, hostile names; Git host allow-list and SSRF cases; log scrubbing; restricted-features and role gates on every new route.
- Real (opt-in, behind an environment variable and a test subscription): the Phase 1 deployment, then destroy, checking the resource group is gone.

## 11. Decisions (taken 2026-10-16)

1. **Source in v1:** the generated sample apps plus zip upload. Git: done, see "Code from a Git repository" below.
2. **AWS builds:** CodeBuild in the customer's account (phase 2).
3. **Who can deploy:** only the restricted-features list (today `ajinkya@neozaar.com`), with the existing approval mode (password confirmation by default). Nothing new to configure.
4. **Environments:** one deployment per project **environment**, as the Deploy tab does (the state key, the release record and the approval all carry the environment).
5. **Cost cap:** none in v1. The estimate is shown and must be acknowledged before approval. A cap can be added later without changing the flow.
6. **Worker:** the existing apply worker process, with a second queue `project-release`.

## 12. Refinements made while starting the build

- **Secrets come after the infrastructure, not at plan time.** The vault does not exist before Terraform creates it, so the release is a state machine that *pauses* at the `secrets` step ("waiting for secrets"), exactly where `deploy.sh` asks. The person enters the values in a write-only form; the API writes each one straight to the vault and the job is resumed. CloudBuilder still never stores a value (no encrypted holding row, no queue payload).
- **Azure calls use the cloud's REST APIs with `@azure/identity` tokens**, not new SDK packages (the registry-build and Key Vault data-plane SDKs are not dependencies yet). A small `AzureOps` interface wraps them, so every step is tested with a fake and the real implementation is one file.
- **The release is behind a switch.** `CLOUDBUILDER_PROJECT_RELEASES=1` turns it on; it is off by default until phase 0 (a real test deployment from the terminal) has been done, because none of the generated Terraform or start scripts has run on a real cloud yet.
- **Release records keep the compose file and tag of every release**, so a rollback needs no rebuild and no plan.


## Code from a Git repository

Each built service can take its code from a Git repository instead of an uploaded zip: `POST /api/projects/{id}/releases/sources/git` with `layer`, `url`, and optionally
`ref` (branch, tag or commit), `subdir` (a folder of the repository) and `token` (for a private repository). The repository is fetched on the server, turned into the same
kind of zip an upload is, read again with the same strict checks (`lib/deploy/project/zip.ts`) and stored with the same short TTL. The response carries the commit that
was taken, and the approval covers the SHA-256 of exactly that content, so a release builds what was approved even if the branch moves. Everything after that is the same
as an uploaded zip: the generated Dockerfile is used, not one from the repository.

What it will and will not do (`lib/deploy/project/gitSource.ts`):

- Only `https`, only hosts on the allow-list: `CLOUDBUILDER_GIT_ALLOWED_HOSTS` (comma separated; default `github.com,gitlab.com,bitbucket.org,dev.azure.com`). No user name,
  password, port, query or fragment in the address. A host that resolves to a private, loopback or link-local address is refused, so it cannot be used to reach the network.
- `git` runs without a shell, with hooks, submodules, redirects, prompts and every protocol but https turned off, with no user or system configuration, a two-minute limit
  and a size limit on what is downloaded. Symbolic links are not followed (they arrive as small text files). A repository's own `.git` folder is never included.
- The token for a private repository goes to git through its environment (an `Authorization` header), never a command line, a file or a log, and is not stored. Errors have it
  removed. It is a personal access token the person creates with read access (GitHub: `x-access-token`; GitLab: `oauth2`; Bitbucket: `x-token-auth`; Azure DevOps: a PAT).
- Limits are the zip limits: 5 MB zipped, 30 MB expanded, 2000 files. For a larger repository use `subdir` or upload a zip.
- The audit log records who took which repository and commit, and whether a token was used (never its value).

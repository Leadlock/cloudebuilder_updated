# CloudBuilder

**Design, check, price and deploy AWS and Azure infrastructure from one canvas.**

CloudBuilder turns a drawn architecture into reviewed, priced, security-checked Terraform, and into the reports a team needs to show that it is well built. You drag cloud services onto a canvas, connect them, and CloudBuilder checks the design against 168 security and Well-Architected rules, estimates the monthly cost, generates the Terraform, and (with approval) deploys it. It also helps a company get ready for a SOC 2 examination.

> CloudBuilder is the product name; the repository and some folders still say `cloudcraft`.

---

## What it does

| Area | What you get |
| --- | --- |
| **Build** | Visual canvas for AWS, Azure and multi-cloud designs. Architecture wizard, a gallery of reference templates, an AI generator, import of existing infrastructure from a connected cloud account, container templates, and a *third-party service* node (Datadog, Atlas, Auth0, Stripe and so on) so the services outside your cloud account are part of the design. |
| **Check** | An assessment engine with 168 rules (76 AWS, 92 Azure) mapped to AWS Foundational Security Best Practices, Microsoft cloud security benchmark and Well-Architected pillars. Every result says what it was based on: the design, a reading of the cloud account, or a live check. Findings can be reviewed (accepted risk, false positive) without hiding the technical result. |
| **Well-Architected** | A pillar-by-pillar review for AWS and Azure, a questionnaire for what a design cannot show, the AWS Well-Architected Tool sync, an Azure review sheet, and an agent package. |
| **Readiness reports** | SOC 2 Type 1 readiness (Word and PDF), AWS and Azure Well-Architected control reports (PDF), an evidence vault, findings with management's response, sign-offs, evidence over time, an auditor package and read-only auditor links. See [docs/READINESS_REPORTS.md](docs/READINESS_REPORTS.md). |
| **Cost** | Per-resource monthly estimates (AWS from a maintained price table, Azure from the live Retail Prices API), a cost comparison across designs and regions, and optimization advice. Third-party services count at the monthly cost you enter. |
| **Deliver** | Terraform generation, plan, a review workflow with approvals, and a gated apply run by a background worker. Stacks, drift detection and reconcile, deployment of container projects from a Git source, and a disaster-recovery designer. |
| **Manage** | Cloud accounts (credentials encrypted at rest), environments, version history, organization policy, team and roles, and read-only API keys for the architecture templates. |

What it is **not**: an auditor, a certifier or a guarantee. A readiness report is not a SOC 2 report; only a licensed CPA firm issues one. Cost figures are estimates and do not reflect discounts, Reserved Instances or Savings Plans.

---

## Tech stack

- **App:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, React Flow for the canvas.
- **Database:** PostgreSQL through Prisma Next (a contract-first data layer: `src/prisma/contract.prisma`).
- **Jobs:** pg-boss on the same Postgres database, run by separate worker processes.
- **Infrastructure code:** Terraform (installed with `npm run terraform:install`).
- **Reports:** `docx` for Word, `pdfkit` for PDF, `jszip` for packages.
- **Tests:** Jest (about 7,500 tests), plus integration tests against a real Postgres.

---

## Getting started

**Prerequisites:** Node.js 20+, npm, Docker (for the local database).

```bash
npm install

# Local PostgreSQL (docker-compose.yml)
docker compose up -d

# Configuration: copy the example and fill in DATABASE_URL and ENCRYPTION_KEY
cp .env.example .env
npm run credentials:new-key        # prints a fresh 64-character key for ENCRYPTION_KEY

# Create the schema
npm run db:migrate                 # or: npx prisma db init   (first time, empty database)

# Start the app and the workers together
npm run dev
```

Open <http://localhost:3000> and register. `npm run dev` also starts the background workers; to run the web app alone use `npm run dev:web`.

If `db:migrate` reports `MARKER_MISMATCH` or `PATH_UNREACHABLE`, your local database has drifted from the contract (usually a stale Docker volume). It is disposable, so `npm run db:reset` recreates it. See [docs/database/MIGRATION_MARKER_MISMATCH.md](docs/database/MIGRATION_MARKER_MISMATCH.md).

### Configuration

All settings are environment variables; `.env.example` lists them with comments. The ones you must set:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `ENCRYPTION_KEY` | 64 hex characters. Encrypts cloud credentials and evidence files at rest (AES-256-GCM). Production refuses anything weaker, and refuses any key that was ever published as an example. |
| `SESSION_SECRET` | Signs session cookies. |
| `RESTRICTED_FEATURES_ALLOWED_EMAILS` | In production, who may use Deploy, the AI Generator and Cloud Accounts. The server will not start without it. |

Optional: Cognito (sign-in directory), SMTP (email), Azure AI Foundry (AI features), `APP_URL`.

### Background workers

Discovery, Terraform apply and the nightly readiness snapshot run as durable jobs rather than inside web requests. Run each as its own process:

```bash
npm run worker:discovery          # cloud discovery and the 03:30 UTC readiness snapshot
npm run worker:terraform-apply    # terraform apply (needs the terraform CLI)
```

Both need the same `DATABASE_URL` and `ENCRYPTION_KEY` as the web app. Plans are read-only and run in the request; only an apply is a background job. See [lib/terraform/execution/TerraformExecutionService.ts](lib/terraform/execution/TerraformExecutionService.ts) for the gates: admin only, an approved review whose hash matches the plan, a mandatory remote state backend, and destroy blocked.

---

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Web app and workers. |
| `npm test` | Whole test suite. |
| `npm run test:integration` | Tests against a real Postgres (needs `docker compose up -d`). |
| `npx eslint .` | Lint. |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | Type check (needs the larger heap now that the contract is big). |
| `npm run build` | Production build. |
| `npm run contract:emit` | Rebuild `contract.json` and `contract.d.ts` after editing `contract.prisma`. |
| `npx prisma migration plan --name <slug>` then `npm run db:migrate` | Add and apply a migration. |
| `npm run docs:rule-matrix` | Regenerate the rule matrix. |
| `npm run templates:sync` | Sync the built-in architecture templates into the database. |

Changing the data model: edit `src/prisma/contract.prisma`, run `contract:emit`, plan and apply a migration, then restart any running dev server (it caches the contract).

---

## Project layout

```
app/                  Next.js routes: the UI shell and every API route (app/api)
components/           canvas, panels (Terraform, Security, Cost, Readiness ...), layout
context/              global app state
lib/
  engines/            assessment, cost, terraform, containers, advisor, Well-Architected ...
  compliance/         readiness reports: scoring, SOC 2 catalog, renderers, evidence, snapshots
  repositories/       database access
  terraform/          plan, approval and apply
  deploy/             in-app project deployment
  crypto/             credential and evidence encryption
  jobs/               pg-boss job definitions
workers/              worker process entry points
src/prisma/           the data contract and generated client types
migrations/           database migrations
scripts/              deploy, security checks, data builders
docs/                 deployment, security, readiness reports, rule matrix
__tests__/, integration/   unit and real-database tests
```

---

## Security

- Sign-in with scrypt-hashed passwords and optional authenticator (TOTP) second factor; sessions are revocable.
- Every project route checks the caller belongs to the organization that owns the project; administrative actions need an owner or admin role in that organization.
- Cloud credentials and evidence files are encrypted at rest with versioned, rotatable keys (`npm run credentials:rotate`); ciphertext is bound to the record it belongs to.
- A cross-site write guard, rate limits, strict security headers and a Content Security Policy.
- Dependency audit gate and image scan in CI; security fixes are tracked in the policy files under `security/`.
- Server hardening notes: [docs/SERVER_SECURITY.md](docs/SERVER_SECURITY.md). Scan details: [docs/SECURITY_SCAN.md](docs/SECURITY_SCAN.md).

Report a vulnerability privately to the maintainers rather than in a public issue.

---

## Deploying

One command from your own computer, on `main` with CI green:

```bash
scripts/deploy.sh --dry-run    # shows what would be sent
scripts/deploy.sh              # deploys origin/main after you confirm
scripts/deploy.sh --rollback   # restores the newest backup
```

It backs up the running version (keeping the newest and the database dump), builds, restarts only CloudBuilder's own processes, and rolls back by itself if the site does not come up. Full details: [docs/DEPLOY.md](docs/DEPLOY.md).

---

## Adding a resource type

Add an entry to `lib/resources/aws.ts` or `lib/resources/azure.ts` (type key, label, provider, category, default configuration and a form schema). It then appears in the palette and properties panel. Add assessment rules under `lib/engines/assessment/rules`, a price in the pricing tables, and Terraform generation in `lib/engines/terraform`, each with tests. The rule matrix generator fails if a rule is incomplete.

---

## More documentation

- [docs/PLATFORM_OVERVIEW.md](docs/PLATFORM_OVERVIEW.md): a longer feature tour of the canvas, Terraform generation and advisory (from the `testing` branch; some version numbers in it are older)
- [docs/READINESS_REPORTS.md](docs/READINESS_REPORTS.md): SOC 2 readiness, control reports, evidence, auditor access
- [docs/DEPLOY.md](docs/DEPLOY.md): deploying and rolling back
- [docs/SERVER_SECURITY.md](docs/SERVER_SECURITY.md): hardening the server
- [docs/SECURITY_SCAN.md](docs/SECURITY_SCAN.md): the security scan
- [docs/security-assessment/RULE_MATRIX.md](docs/security-assessment/RULE_MATRIX.md): every assessment rule
- [docs/PRICING_SERVICES.md](docs/PRICING_SERVICES.md): how prices are sourced

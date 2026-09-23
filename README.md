# CloudCraft — Visual Cloud Infrastructure Builder

A production-quality SaaS web app for visually designing AWS and Azure infrastructure, generating Terraform, running security scans, and estimating costs.

## Features

- 🖱️ **Visual Drag-and-Drop Canvas** — Powered by React Flow. Drag AWS/Azure resources onto a canvas, connect them, and build real infrastructure diagrams.
- ☁️ **Multi-Cloud** — Supports AWS (9 resource types) and Azure (8 resource types) with realistic configurations.
- ⚙️ **Properties Panel** — Click any resource to configure it with a live form.
- 🔒 **Security Scan** — Automatically scans for misconfigurations (open SSH, unencrypted S3, public RDS, etc.) with severity ratings and recommendations.
- 💰 **Cost Estimate** — Live per-resource monthly cost estimates based on configuration.
- 📄 **Terraform Generation** — Converts the visual architecture into production-ready Terraform HCL.
- 🚀 **Deployment Workflow** — Step-by-step: Validate → Security Scan → Cost Check → Terraform Plan → Deploy.
- 📊 **Dashboard** — Project overview with security scores, resource counts, and cost estimates.
- 💾 **Project Save/Load** — Automatic in-memory save; projects persist across view changes.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4
- **Canvas**: React Flow
- **Icons**: Lucide React

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
# Navigate to the project
cd cloudcraft

# Install dependencies (already done if scaffolded)
npm install

# Start a local PostgreSQL database (see docker-compose.yml)
docker compose up -d

# Copy .env.example to .env and fill in DATABASE_URL / ENCRYPTION_KEY, then
# create the schema in the fresh database
npm run db:migrate   # or: npx prisma db init   (first-time / empty database)

# Start the development server
npm run dev
```

If `db:migrate` fails with a `MARKER_MISMATCH` or `PATH_UNREACHABLE` error, the
local database's schema state has drifted from `src/prisma/contract.prisma`
(usually a stale Docker volume from a previous checkout). Since this is a
disposable local dev database, the fastest fix is:

```bash
npm run db:reset
```

which recreates the Postgres container from scratch and reapplies the current
contract.

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build for Production

```bash
npm run build
npm start
```

### Background Worker (required for cloud account discovery)

Cloud infrastructure discovery (`POST /api/cloud-accounts/:id/discover`) runs
as a durable job on [pg-boss](https://github.com/timgit/pg-boss), not inside
the web server's request handler — the API route only enqueues the job
(persisted in the same Postgres database via `DATABASE_URL`) and returns
immediately. A separate, long-running worker process actually executes it:

```bash
npm run worker:discovery
```

This must be running (as its own process — a second `npm start`-style
process, not part of the Next.js server) for discovery runs to ever leave
the "pending" state. It needs the same `DATABASE_URL` and `ENCRYPTION_KEY`
environment variables as the main app. See `lib/jobs/queue.ts` and
`lib/jobs/discoveryJob.ts` for how the queue and job are defined, and
`workers/discoveryWorker.ts` for the worker entrypoint itself.

## Project Structure

```
cloudcraft/
├── app/               # Next.js App Router
│   ├── page.tsx       # Root page (shell)
│   └── layout.tsx     # Root layout with AppProvider
├── components/
│   ├── canvas/        # InfraCanvas, CloudNode, ResourcePalette, PropertiesPanel
│   ├── dashboard/     # Dashboard with project cards
│   ├── layout/        # Sidebar, TopBar
│   └── panels/        # TerraformPanel, SecurityPanel, CostPanel, DeployPanel
├── context/
│   └── AppContext.tsx  # Global state (projects, active view, canvas sync)
├── lib/
│   ├── resources/
│   │   ├── aws.ts     # AWS resource definitions + security rules
│   │   ├── azure.ts   # Azure resource definitions + security rules
│   │   └── index.ts   # Aggregated exports
│   ├── analysis.ts    # Security scanning, cost calculation, Terraform generation
│   └── mockData.ts    # Sample projects with pre-built architectures
└── types/
    └── index.ts       # All TypeScript interfaces
```

## Adding New Resources

To add a new resource type, add an entry to [`lib/resources/aws.ts`](lib/resources/aws.ts) or [`lib/resources/azure.ts`](lib/resources/azure.ts):

```typescript
{
  type: 'aws_lambda',           // Unique resource type key
  label: 'Lambda Function',     // Display name
  provider: 'aws',
  category: 'compute',
  icon: 'λ',                    // Short icon label (2-4 chars)
  color: '#F59E0B',             // Node color
  bgColor: '#FEF3C7',           // Node background
  borderColor: '#D97706',
  monthlyBaseCost: 0,
  defaultConfig: { functionName: 'my-function', runtime: 'nodejs18.x' },
  configSchema: [
    { key: 'functionName', label: 'Function Name', type: 'text', defaultValue: 'my-function', required: true },
    { key: 'runtime', label: 'Runtime', type: 'select', defaultValue: 'nodejs18.x', options: [...] },
  ],
  securityRules: [
    {
      id: 'lambda-env-secrets',
      severity: 'high',
      check: (config) => config.hasPlaintextSecrets ? 'Secrets in env vars' : null,
      message: 'Lambda has secrets in environment variables',
      recommendation: 'Use AWS Secrets Manager or Parameter Store',
    },
  ],
}
```

That's it — the resource will automatically appear in the palette, properties panel, security scanner, cost estimator, and Terraform generator.

## Notes

- Projects, versions, and org/team data are persisted in PostgreSQL via Prisma — not in-memory. Refresh does not reset your data.
- Cloud account credentials (for live infrastructure import) are encrypted at rest with `ENCRYPTION_KEY` (AES-256-GCM); see `.env.example`.
- Cost estimates and Terraform generation call real API routes backed by the engines in `lib/engines/`; if the API is unreachable, panels fall back to a deterministic offline estimate and say so in the UI — this is never silently presented as live data.
- AWS on-demand pricing is a static, hand-maintained reference table, not a live pricing API call; Azure pricing is fetched live from the Azure Retail Prices API. Neither reflects negotiated discounts, Reserved Instances, or Savings Plans.

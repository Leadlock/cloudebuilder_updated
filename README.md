# CloudBuilder — Visual Cloud Architecture & Terraform Engineering Platform

**CloudBuilder** is a production-grade visual cloud architecture and Infrastructure-as-Code (IaC) engineering platform. It bridges the gap between high-level architectural diagramming and real-world, secure, and production-ready cloud deployments for **AWS** and **Azure**.

---

## 🌟 Key Features & Capabilities

### 1. 🖱️ Intelligent Visual Canvas (React Flow)
- **Interactive Drag-and-Drop Designer**: Place compute, networking, database, storage, security, and AI components onto an infinite canvas.
- **Visual Grouping & Hierarchies**: Supports nested containment (Cloud Provider Boundary, VPCs, Subnets, and Visual Service Groups) without polluting generated Terraform with artificial resources.
- **Smart Dataflow Connectivity**:
  - **Live Connection Status**: Dataflow lines display real-time status indicators (🟢 green for verified configuration, 🔴 red when manual configuration or routing is required).
  - **Multi-Port Edge Routing**: Automatic directional handle separation prevents overlapping wires.
  - **Click-to-Highlight Tracing**: Click any dataflow line to visually highlight connected source and target resources.
- **2D Architecture Auto-Layout**: Optimized grid and boundary distribution designed to lay out complex, enterprise architectures (such as multi-AZ deployments with disaster recovery regions) cleanly.

### 2. ⚡ Production-Ready Terraform Generation Engine
- **Relationship-Aware HCL Generation**: Generates clean, idiomatic, multi-file Terraform code (`main.tf`, `variables.tf`, `outputs.tf`, `providers.tf`, `terraform.tfvars`).
- **Extensive Cloud Catalog**:
  - **AWS**: VPC, Multi-AZ Subnets, Internet & NAT Gateways, Route Tables, Application & Network Load Balancers (ALB/NLB), EC2, ECS, EKS, Lambda, RDS (Primary, Standby, Read Replicas), DynamoDB, DocumentDB, S3 (with lifecycle, encryption & public access blocks), CloudFront, Route53, WAF, KMS, IAM Roles & Policies, SQS, SNS, EventBridge, CloudWatch, **AWS Secrets Manager**, **Amazon GuardDuty**, **AWS Security Hub**, and **Amazon Bedrock AI**.
  - **Azure**: Resource Groups, Virtual Networks (VNet), Subnets, Network Security Groups (NSG), Virtual Machines, App Services, AKS, Azure SQL, CosmosDB, Storage Accounts, Key Vault, Application Gateway, and Azure Container Apps.
- **Dynamic Project Names & Variables**: Automatically slugifies project names and passes them through `variables.tf` and `terraform.tfvars`.
- **HCL Safety & Guardrails**: Sanitizes all strings, escaping injections, and passes plans through strict guardrails (`ALLOWED_TERRAFORM_RESOURCE_TYPES`, region whitelisting, and public exposure checks).
- **Auto-Sync Generation**: Automatically updates Terraform code in real-time as canvas nodes and wires change.

### 3. 🛡️ Terraform Deployment Advisory & AI Remediation
- **Context-Aware Advisory Center**: Scans architectures for cloud anti-patterns (e.g. internet-facing ALBs with only 1 public subnet, private subnets lacking NAT Gateways, or unsupported resource configurations).
- **1-Click Manual Remediation**: Provides exact step-by-step guidance and a 1-click instant canvas fix button.
- **Fix with AI**:
  - Dynamic parameter modal prompting for required inputs (e.g. CIDR blocks, Availability Zones, or target service mappings).
  - Executes instant remediation directly onto canvas resources.
- **Fix All with AI**: One-click batch remediation engine that resolves all detected architecture warnings across the diagram.
- **Synchronous Real-Time Updates**: Applying a fix immediately re-analyzes the architecture and clears resolved warnings with zero UI delay.

### 4. 🔒 Cloud Security & Compliance Scanning
- **Automated Policy Checks**: Detects open SSH/RDP ports (`0.0.0.0/0`), unencrypted storage, public databases, missing TLS certificates, and wildcard IAM administrative permissions.
- **IAM Automation Modal**: Automatically derives and links least-privilege IAM roles and access policies for compute resources connecting to databases or storage.

### 5. 💰 Real-Time Cost Estimation
- **Granular Cost Calculation**: Calculates monthly baseline and bandwidth costs per resource based on machine sizes, database engines, and storage volumes.
- **Multi-Currency Support**: View estimates in USD, EUR, GBP, INR, and other supported global currencies.

### 6. 📁 Architecture Import & State Migration
- **Terraform State & Canvas Import**: Import existing Terraform state files or CloudBuilder JSON diagrams; layout algorithms automatically reconstruct the architecture on canvas.

---

## 🛠️ Technology Stack

| Layer | Technologies |
|---|---|
| **Framework** | Next.js 15 (App Router, Server Actions) |
| **Language** | TypeScript (Strict mode) |
| **Styling** | Vanilla CSS & Tailwind CSS v4 |
| **Canvas & Graph** | React Flow, Custom SVGs, SVG marker dataflow paths |
| **Icons** | Lucide React, Custom Cloud Provider SVG Icon Suite |
| **Database & ORM** | PostgreSQL, Prisma 8 (Prisma Next) |
| **Testing** | Jest, React Testing Library, ts-node |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v18.18+ or v20+
- **npm**: v9+
- **Docker** (optional, for local PostgreSQL database)

### Installation & Local Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/ajinkya-petabyte/cloudcraft.git
   cd cloudcraft
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file in the root directory (refer to `.env.example`):
   ```env
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/cloudbuilder"
   ENCRYPTION_KEY="your-32-byte-hex-encryption-key"
   PORT=3000
   ```

4. **Start Database (Optional Docker Compose)**:
   ```bash
   docker compose up -d
   npm run db:migrate
   ```

5. **Run the Development Server**:
   ```bash
   npm run dev
   ```

6. Open your browser and navigate to [http://localhost:3000](http://localhost:3000).

---

## 🧪 Testing & Quality Assurance

CloudBuilder maintains a comprehensive test suite verifying canvas layouts, edge routing, Terraform generation safety, and warning analyzers.

```bash
# Run unit and integration tests
npm test

# Run specific test suites
npx jest __tests__/terraformWarningAnalyzer.test.ts
npx jest __tests__/planGuardrails.test.ts
npx jest __tests__/prismLayoutOptimization.test.ts
npx jest __tests__/edgeRoutingSeparation.test.ts

# Verify TypeScript type safety
npx tsc --noEmit
```

---

## 📂 Project Structure

```
cloudcraft/
├── app/                             # Next.js App Router (Layouts, API routes, Shell)
│   ├── api/                         # Backend API endpoints (Projects, Terraform, Deploy)
│   ├── layout.tsx                   # App root provider wrapper
│   └── page.tsx                     # Main application shell
├── components/
│   ├── canvas/                      # React Flow canvas, CloudNode, ContainerNode, Toolbars
│   ├── dashboard/                   # Project overview, metrics, and template browser
│   ├── layout/                      # TopBar, Sidebar, App Header navigation
│   ├── panels/                      # TerraformPanel, TerraformFixModal, SecurityPanel, CostPanel
│   └── wizard/                      # Architecture initialization wizard
├── context/
│   └── AppContext.tsx               # Global reactive application state
├── lib/
│   ├── canvas/                      # Auto-layout algorithms, dataflow line status computations
│   ├── cloud/                       # State and template file import parsers
│   ├── engines/
│   │   ├── relationship/            # Visual relation and network connectivity engine
│   │   └── terraform/               # Production Terraform HCL generator & safety analyzers
│   ├── resources/                   # Multi-cloud resource catalog definitions & pricing
│   └── terraform/                   # Warning analyzer, remediation actions, guardrails
├── __tests__/                       # Automated Jest test suites
└── types/                           # Central TypeScript definitions and models
```

---

## 📄 License

This project is licensed under the MIT License.

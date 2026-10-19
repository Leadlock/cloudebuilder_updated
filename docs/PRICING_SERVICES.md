# CloudBuilder Cloud Pricing Services Documentation

This document provides a comprehensive guide to CloudBuilder's real-time cloud pricing architecture, integrating Microsoft's **Azure Retail Prices API** and Amazon Web Services' **AWS Price List Query API**, along with caching, multi-currency conversion, and application-wide price synchronization.

---

## 1. Architecture Overview

CloudBuilder uses a unified, multi-cloud pricing pipeline that ensures exact cost consistency across:
- **AI Architecture Generator** (AI Builder preview and generation results)
- **Canvas Infrastructure Editor** (Canvas top bar, inspector, and Cost Estimation panel)
- **Dashboard & Project Cards** (Individual project monthly cost and total monthly cloud portfolio cost)
- **Review & Well-Architected Workflows** (Cost optimization reviews and executive summaries)
- **Multi-Cloud Cost Comparison Engine** (Side-by-side AWS vs. Azure cost translation)

```mermaid
flowchart TD
    subgraph UI ["CloudBuilder UI Layers"]
        AI[AI Architecture Generator]
        Canvas[Canvas & Cost Panel]
        Dash[Dashboard & Overview]
        Comp[Cloud Cost Comparison]
    end

    subgraph AppContext ["State & Synchronization"]
        AC[AppContext / Action: UPDATE_PROJECT_COST]
    end

    subgraph API ["Next.js Server API Routes"]
        Route1["/api/projects/:id/cost-estimates"]
        Route2["/api/projects/:id/cost-comparison"]
    end

    subgraph Engine ["Cost Estimation Engine"]
        CE[CostEstimator]
        CPPS[CloudProviderPricingService]
        Cache[PricingCache (Memory + Disk)]
        FX[CurrencyExchangeRateService]
    end

    subgraph Providers ["Official Cloud Price Providers"]
        AzureAPI["Azure Retail Prices API\n(prices.azure.com/api/retail/prices)"]
        AwsAPI["AWS Price List Query API\n(@aws-sdk/client-pricing: us-east-1)"]
    end

    AI --> Route1
    Canvas --> Route1
    Comp --> Route2
    Route1 --> CE
    Route2 --> CE
    CE --> CPPS
    CPPS --> Cache
    Cache -->|Cache Miss| AzureAPI
    Cache -->|Cache Miss| AwsAPI
    CE --> FX
    Route1 --> AC
    AC --> Dash
```

---

## 2. Azure Retail Prices API Integration

### 2.1 Service Overview
- **Official Documentation**: [Microsoft Learn - Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
- **API Endpoint**: `https://prices.azure.com/api/retail/prices`
- **Authentication**: **Unauthenticated / Public**. Microsoft makes this endpoint publicly accessible without requiring an Azure subscription, API key, or OAuth token.
- **Protocol**: HTTP GET with OData `$filter` queries.
- **Pricing Model**: Pay-As-You-Go retail list prices in USD (with optional regional currency parameter).

### 2.2 Query Structure & OData Filters
The Azure Pricing Provider (`lib/cloud/pricing/AzurePricingProvider.ts`) crafts optimized OData filters for specific resources.

#### Example Filter Query:
```http
GET https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Virtual Machines' and armRegionName eq 'eastus' and priceType eq 'Consumption' and contains(meterName, 'Spot') eq false and armSkuName eq 'Standard_D2s_v3'
```

#### JSON Response Schema:
```json
{
  "BillingCurrency": "USD",
  "CustomerEntityId": "Default",
  "CustomerEntityType": "Retail",
  "Items": [
    {
      "currencyCode": "USD",
      "tierMinimumUnits": 0.0,
      "retailPrice": 0.096,
      "unitPrice": 0.096,
      "armPath": "subscriptions/.../resourceGroups/.../providers/Microsoft.Compute/virtualMachines/...",
      "registrationDate": "2023-01-01T00:00:00Z",
      "productName": "Virtual Machines Dsv3 Series",
      "skuName": "D2s v3",
      "serviceName": "Virtual Machines",
      "serviceId": "DZH318Z0BQ3W",
      "serviceFamily": "Compute",
      "unitOfMeasure": "1 Hour",
      "type": "Consumption",
      "isPrimaryMeterRegion": true,
      "armSkuName": "Standard_D2s_v3",
      "location": "US East",
      "effectiveStartDate": "2023-01-01T00:00:00Z",
      "meterId": "...",
      "meterName": "D2s v3"
    }
  ],
  "NextPageLink": null,
  "Count": 1
}
```

### 2.3 Supported Azure Services
| Resource Type | Azure Service | Key Sizing Parameters | Billed Unit |
| :--- | :--- | :--- | :--- |
| `azure_vm` | Virtual Machines | `size` (e.g. `Standard_D2s_v3`, `Standard_B2s`), `os` | Per Hour (× 730 hrs/mo) |
| `azure_sql` | Azure SQL Database | `tier` (`GP_Gen5_2`, `S1`), `maxSizeGb`, `zoneRedundant` | Compute/hr + Storage/GB-mo |
| `azure_storage` | Storage Accounts | `sku` (`Standard_LRS`, `GRS`), `estimatedCapacityGb` | GB/Month + Operations |
| `azure_lb` | Load Balancer | `sku` (`Standard`, `Basic`) | Base rules + Data processed GB |
| `azure_app_gateway` | Application Gateway | `sku` (`Standard_v2`, `WAF_v2`), Capacity Units | Fixed gateway-hr + Capacity Units |
| `azure_functions` | Azure Functions | `hostingPlan` (Consumption vs Premium) | Executions & GB-s |
| `azure_aks` | Azure Kubernetes | Worker VM sizes + Managed control plane | Worker node VM rates |
| `azure_cosmos_db` | Cosmos DB | `throughputMode` (Serverless vs Provisioned RU/s) | 100 RU/s-hr + Storage GB |
| `azure_key_vault` | Key Vault | Operations & HSM keys | Operations / 10k |
| `azure_front_door` | Azure Front Door | `sku` (`Standard`, `Premium`) | Base fee + Data egress GB |

---

## 3. AWS Price List Query API Integration

### 3.1 Service Overview
- **Official Documentation**: [AWS Price List Query API Reference](https://docs.aws.amazon.com/awspricelist/latest/user-guide/price-list-api.html)
- **SDK**: `@aws-sdk/client-pricing` (`PricingClient`, `GetProductsCommand`)
- **API Endpoints**: Served exclusively from two AWS regions worldwide:
  - `us-east-1` (US East, N. Virginia) — default used by CloudBuilder
  - `ap-south-1` (Asia Pacific, Mumbai)
- **Protocol**: AWS Signature Version 4 (SigV4) signed JSON-RPC requests.

### 3.2 Authentication & Credential Resolution
Unlike Azure's retail prices, AWS requires signed requests with valid IAM credentials. CloudBuilder resolves credentials in the following hierarchical order:

1. **Dedicated Service Credentials**:
   `AWS_PRICING_ACCESS_KEY_ID` and `AWS_PRICING_SECRET_ACCESS_KEY`
2. **Standard AWS Credentials**:
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`
3. **Connected Customer Account Role**:
   If an organization has connected an AWS account via IAM Role, `ensureAwsPricingAccess(orgId)` assumes the role for 1 hour to query the Price List API with zero user friction.
4. **Resilient Static Fallback**:
   If credentials are not configured or the network times out, CloudBuilder seamlessly falls back to high-fidelity static baseline price tables (`lib/engines/cost/awsPricing.ts`).

#### Minimum Least-Privilege IAM Policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPricingListQuery",
      "Effect": "Allow",
      "Action": [
        "pricing:GetProducts",
        "pricing:DescribeServices"
      ],
      "Resource": "*"
    }
  ]
}
```
*(Note: The Pricing API is a metadata service; this permission cannot inspect or modify any infrastructure or user data.)*

### 3.3 Query Filters & Mapping
AWS Price List queries require matching human-readable location strings and product attributes:

#### Location Mapping Example:
| AWS Region Code | AWS Price List Location Attribute |
| :--- | :--- |
| `us-east-1` | `US East (N. Virginia)` |
| `us-east-2` | `US East (Ohio)` |
| `eu-west-1` | `EU (Ireland)` |
| `eu-central-1` | `EU (Frankfurt)` |
| `ap-south-1` | `Asia Pacific (Mumbai)` |

#### Code Implementation (`GetProductsCommand`):
```typescript
const command = new GetProductsCommand({
  ServiceCode: 'AmazonEC2',
  Filters: [
    { Type: 'TERM_MATCH', Field: 'instanceType', Value: 'm5.large' },
    { Type: 'TERM_MATCH', Field: 'location', Value: 'US East (N. Virginia)' },
    { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
    { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
    { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
    { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
  ],
  MaxResults: 10,
});
```

---

## 4. Multi-Tier Caching & Performance

To guarantee sub-second UI interactions without exceeding external API rate limits, CloudBuilder incorporates a robust caching architecture (`lib/cloud/pricing/PricingCache.ts`):

1. **In-Memory Cache (L1)**:
   - Ultra-fast Map lookup (`<1ms`).
   - Retains frequently accessed queries during active session.
2. **Persistent Disk Cache (L2)**:
   - Serialized JSON cache in `.cache/pricing/pricing_cache.json`.
   - Keys hash the provider, resource type, region, and price-relevant configuration parameters (e.g., `v3:aws:ec2:us-east-1:m5.xlarge`).
   - Ignores aesthetic settings (`name`, `label`, `description`, `tags`) to maximize cache hit rates.
3. **Time-To-Live & SWR**:
   - TTL: **24 hours**.
   - Stale-while-revalidate strategy: returns cached data immediately while refreshing in the background.

---

## 5. Pricing Transparency & Confidence Tiers

Every priced line item carries transparent confidence badges:

| Tier | UI Badge | Description |
| :--- | :--- | :--- |
| `LIVE` | 🟢 Emerald | Official list price returned in real time from Azure Retail API or AWS Price List API. |
| `CACHED_LIVE` | 🔵 Sky Blue | Official price retrieved from provider API and served from the 24-hour cache. |
| `FALLBACK_ESTIMATE` | 🟡 Amber | Static engineering fallback used when offline, API is down, or credentials are absent. |
| `UNAVAILABLE` | ⚪ Gray | Resource has no direct charge (e.g. VPC/VNet boundary) or cannot be priced. |

---

## 6. Real-Time Price Synchronization

All pricing touchpoints in the application share a single source of truth:

1. **Synchronous Baseline**:
   `lib/analysis.ts` (`calculateCosts`) evaluates the same deterministic pricing logic (`awsPricingProvider` / `azurePricingProvider`) as `CostEstimator`, eliminating the initial disparity between draft calculations and engine outputs.
2. **Live Estimate Ingestion**:
   When the canvas snapshot changes or when an AI architecture is generated, the client calls `POST /api/projects/:id/cost-estimates`. The route runs `costEstimator.estimateAsync(..., 'REAL')` using real-time Azure and AWS APIs.
3. **App-Wide State Dispatch**:
   When live estimates are returned, `UPDATE_PROJECT_COST` is dispatched to `AppContext`. The active project's `estimatedMonthlyCost` is updated in memory and localStorage.
4. **Dashboard & Header Alignment**:
   The Dashboard metrics cards, project summary badges, Canvas top bar, and Cost Estimation panel all display identical, real-time amounts formatted in the user's active display currency.

---

## 7. Verification & Health Monitoring

To verify live connectivity with cloud provider pricing APIs, run the price health verification tool:

```bash
# Verify live Azure Retail API connectivity and reference baseline
npm run price:health

# With AWS credentials set in .env:
# AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=xxx
npm run price:health
```

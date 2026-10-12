/**
 * Azure managed services that a typical application design needs next to compute and storage: PostgreSQL and MySQL flexible servers,
 * Service Bus (queues), Container Registry, Monitor (Log Analytics + Application Insights) and Private Endpoint.
 *
 * Settings read by the Terraform generator (lib/engines/terraform/azureServices.ts), the cost engine, the assessment rules and the AI
 * generator are all declared here, so they stay in step (see __tests__/ruleSchemaConsistency.test.ts).
 */
import type { ResourceDefinition } from '@/types';

const tags = { key: 'tags', label: 'Tags', type: 'keyvalue' as const, defaultValue: {}, section: 'Tags' };

const FLEX_HA = [
  { label: 'Disabled', value: 'Disabled' },
  { label: 'Zone redundant (standby in another zone)', value: 'ZoneRedundant' },
];

export const azureServiceResources: ResourceDefinition[] = [
  {
    type: 'azure_postgres',
    label: 'Azure PostgreSQL',
    service: 'Azure Database for PostgreSQL Flexible Server',
    provider: 'azure',
    category: 'database',
    icon: 'PG',
    color: '#0078D4',
    bgColor: '#FCE7F3',
    borderColor: '#DB2777',
    monthlyBaseCost: 12.41,
    defaultConfig: {
      name: 'my-postgres', version: '16', skuName: 'B_Standard_B1ms', storageGb: 32, databaseName: 'appdb',
      highAvailability: 'Disabled', backupRetentionDays: 7, geoRedundantBackup: false,
      publicNetworkAccess: false, allowAzureServices: false, requireSecureTransport: true, minimumTlsVersion: 'TLSv1.2', tags: {},
    },
    configSchema: [
      { key: 'name', label: 'Server Name', type: 'text', defaultValue: 'my-postgres', required: true },
      { key: 'databaseName', label: 'Database Name', type: 'text', defaultValue: 'appdb', section: 'General' },
      {
        key: 'version', label: 'PostgreSQL Version', type: 'select', defaultValue: '16', section: 'Compute / Capacity',
        options: [{ label: '16', value: '16' }, { label: '15', value: '15' }, { label: '14', value: '14' }, { label: '13', value: '13' }],
      },
      {
        key: 'skuName', label: 'Compute Size', type: 'select', defaultValue: 'B_Standard_B1ms', section: 'Compute / Capacity',
        description: 'Burstable sizes suit development and light workloads. Zone-redundant high availability needs General Purpose or Memory Optimized.',
        options: [
          { label: 'Burstable B1ms (1 vCore, 2 GB)', value: 'B_Standard_B1ms' },
          { label: 'Burstable B2s (2 vCore, 4 GB)', value: 'B_Standard_B2s' },
          { label: 'General Purpose D2ds v5 (2 vCore, 8 GB)', value: 'GP_Standard_D2ds_v5' },
          { label: 'General Purpose D4ds v5 (4 vCore, 16 GB)', value: 'GP_Standard_D4ds_v5' },
          { label: 'Memory Optimized E2ds v5 (2 vCore, 16 GB)', value: 'MO_Standard_E2ds_v5' },
          { label: 'Memory Optimized E4ds v5 (4 vCore, 32 GB)', value: 'MO_Standard_E4ds_v5' },
        ],
      },
      { key: 'storageGb', label: 'Storage (GB)', type: 'number', defaultValue: 32, min: 32, max: 16384, section: 'Storage', description: 'Rounded up to the nearest size Azure offers (32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384).' },
      { key: 'highAvailability', label: 'High Availability', type: 'select', defaultValue: 'Disabled', section: 'Availability & Scaling', options: FLEX_HA },
      { key: 'backupRetentionDays', label: 'Backup Retention (days)', type: 'number', defaultValue: 7, min: 7, max: 35, section: 'Backup & Recovery' },
      { key: 'geoRedundantBackup', label: 'Geo-Redundant Backup', type: 'boolean', defaultValue: false, section: 'Backup & Recovery' },
      {
        key: 'publicNetworkAccess', label: 'Public Network Access', type: 'boolean', defaultValue: false, section: 'Security',
        description: 'Off: the server is placed in its subnet (private access). The subnet must be dedicated to flexible servers. On: reachable through the public endpoint and firewall rules.',
      },
      {
        key: 'allowAzureServices', label: 'Allow Azure Services & Resources', type: 'boolean', defaultValue: false, section: 'Security',
        visibleWhen: (c) => c['publicNetworkAccess'] === true,
        description: 'Adds the 0.0.0.0 firewall rule that lets any Azure service reach the server.',
      },
      { key: 'requireSecureTransport', label: 'Require TLS', type: 'boolean', defaultValue: true, section: 'Security' },
      {
        key: 'minimumTlsVersion', label: 'Minimum TLS Version', type: 'select', defaultValue: 'TLSv1.2', section: 'Security', advanced: true,
        options: [{ label: 'TLS 1.2', value: 'TLSv1.2' }, { label: 'TLS 1.3', value: 'TLSv1.3' }],
      },
      tags,
    ],
  },
  {
    type: 'azure_mysql',
    label: 'Azure MySQL',
    service: 'Azure Database for MySQL Flexible Server',
    provider: 'azure',
    category: 'database',
    icon: 'MYSQL',
    color: '#0078D4',
    bgColor: '#FCE7F3',
    borderColor: '#DB2777',
    monthlyBaseCost: 12.41,
    defaultConfig: {
      name: 'my-mysql', version: '8.0.21', skuName: 'B_Standard_B1ms', storageGb: 20, databaseName: 'appdb',
      highAvailability: 'Disabled', backupRetentionDays: 7, geoRedundantBackup: false,
      publicNetworkAccess: false, allowAzureServices: false, requireSecureTransport: true, minimumTlsVersion: 'TLSv1.2', tags: {},
    },
    configSchema: [
      { key: 'name', label: 'Server Name', type: 'text', defaultValue: 'my-mysql', required: true },
      { key: 'databaseName', label: 'Database Name', type: 'text', defaultValue: 'appdb', section: 'General' },
      {
        key: 'version', label: 'MySQL Version', type: 'select', defaultValue: '8.0.21', section: 'Compute / Capacity',
        options: [{ label: '8.0', value: '8.0.21' }, { label: '5.7', value: '5.7' }],
      },
      {
        key: 'skuName', label: 'Compute Size', type: 'select', defaultValue: 'B_Standard_B1ms', section: 'Compute / Capacity',
        description: 'Burstable sizes suit development and light workloads. Zone-redundant high availability needs General Purpose or Memory Optimized.',
        options: [
          { label: 'Burstable B1ms (1 vCore, 2 GB)', value: 'B_Standard_B1ms' },
          { label: 'Burstable B2s (2 vCore, 4 GB)', value: 'B_Standard_B2s' },
          { label: 'General Purpose D2ds v4 (2 vCore, 8 GB)', value: 'GP_Standard_D2ds_v4' },
          { label: 'General Purpose D4ds v4 (4 vCore, 16 GB)', value: 'GP_Standard_D4ds_v4' },
          { label: 'Memory Optimized E2ds v4 (2 vCore, 16 GB)', value: 'MO_Standard_E2ds_v4' },
        ],
      },
      { key: 'storageGb', label: 'Storage (GB)', type: 'number', defaultValue: 20, min: 20, max: 16384, section: 'Storage' },
      { key: 'highAvailability', label: 'High Availability', type: 'select', defaultValue: 'Disabled', section: 'Availability & Scaling', options: FLEX_HA },
      { key: 'backupRetentionDays', label: 'Backup Retention (days)', type: 'number', defaultValue: 7, min: 1, max: 35, section: 'Backup & Recovery' },
      { key: 'geoRedundantBackup', label: 'Geo-Redundant Backup', type: 'boolean', defaultValue: false, section: 'Backup & Recovery' },
      {
        key: 'publicNetworkAccess', label: 'Public Network Access', type: 'boolean', defaultValue: false, section: 'Security',
        description: 'Off: the server is placed in its subnet (private access). The subnet must be dedicated to flexible servers. On: reachable through the public endpoint and firewall rules.',
      },
      {
        key: 'allowAzureServices', label: 'Allow Azure Services & Resources', type: 'boolean', defaultValue: false, section: 'Security',
        visibleWhen: (c) => c['publicNetworkAccess'] === true,
        description: 'Adds the 0.0.0.0 firewall rule that lets any Azure service reach the server.',
      },
      { key: 'requireSecureTransport', label: 'Require TLS', type: 'boolean', defaultValue: true, section: 'Security' },
      {
        key: 'minimumTlsVersion', label: 'Minimum TLS Version', type: 'select', defaultValue: 'TLSv1.2', section: 'Security', advanced: true,
        options: [{ label: 'TLS 1.2', value: 'TLSv1.2' }, { label: 'TLS 1.3', value: 'TLSv1.3' }],
      },
      tags,
    ],
  },
  {
    type: 'azure_service_bus',
    label: 'Service Bus',
    service: 'Azure Service Bus',
    provider: 'azure',
    category: 'messaging',
    icon: 'SB',
    color: '#0078D4',
    bgColor: '#FEF3C7',
    borderColor: '#D97706',
    monthlyBaseCost: 10.0,
    defaultConfig: {
      name: 'my-servicebus', sku: 'Standard', capacity: 1, queueNames: 'jobs', maxDeliveryCount: 10,
      minimumTlsVersion: '1.2', publicNetworkAccess: true, localAuthEnabled: true, zoneRedundant: false, tags: {},
    },
    configSchema: [
      { key: 'name', label: 'Namespace Name', type: 'text', defaultValue: 'my-servicebus', required: true },
      {
        key: 'sku', label: 'Tier', type: 'select', defaultValue: 'Standard', section: 'Compute / Capacity',
        description: 'Premium is the only tier that supports private endpoints, zone redundancy and VNet isolation.',
        options: [
          { label: 'Basic (queues only)', value: 'Basic' },
          { label: 'Standard (queues and topics)', value: 'Standard' },
          { label: 'Premium (dedicated, private endpoints)', value: 'Premium' },
        ],
      },
      {
        key: 'capacity', label: 'Messaging Units', type: 'select', defaultValue: 1, section: 'Compute / Capacity', visibleWhen: (c) => c['sku'] === 'Premium',
        options: [{ label: '1', value: '1' }, { label: '2', value: '2' }, { label: '4', value: '4' }, { label: '8', value: '8' }, { label: '16', value: '16' }],
      },
      { key: 'queueNames', label: 'Queues (comma separated)', type: 'text', defaultValue: 'jobs', section: 'General', placeholder: 'jobs, emails', description: 'One queue is created for each name.' },
      { key: 'maxDeliveryCount', label: 'Max Delivery Attempts', type: 'number', defaultValue: 10, min: 1, max: 100, section: 'General', advanced: true, description: 'After this many failed deliveries a message moves to the dead-letter queue.' },
      { key: 'zoneRedundant', label: 'Zone Redundant', type: 'boolean', defaultValue: false, section: 'Availability & Scaling', visibleWhen: (c) => c['sku'] === 'Premium' },
      {
        key: 'publicNetworkAccess', label: 'Public Network Access', type: 'boolean', defaultValue: true, section: 'Security',
        description: 'Turning this off needs the Premium tier and a private endpoint.',
      },
      { key: 'localAuthEnabled', label: 'Allow Shared Access Keys', type: 'boolean', defaultValue: true, section: 'Security', description: 'Off: only Microsoft Entra ID (managed identity) can send and receive. The application needs a role assignment.' },
      {
        key: 'minimumTlsVersion', label: 'Minimum TLS Version', type: 'select', defaultValue: '1.2', section: 'Security', advanced: true,
        options: [{ label: 'TLS 1.0', value: '1.0' }, { label: 'TLS 1.1', value: '1.1' }, { label: 'TLS 1.2', value: '1.2' }],
      },
      tags,
    ],
  },
  {
    type: 'azure_acr',
    label: 'Container Registry',
    service: 'Azure Container Registry',
    provider: 'azure',
    category: 'storage',
    icon: 'ACR',
    color: '#0078D4',
    bgColor: '#DBEAFE',
    borderColor: '#2563EB',
    monthlyBaseCost: 20.0,
    defaultConfig: { name: 'myregistry', sku: 'Standard', adminEnabled: false, publicNetworkAccess: true, zoneRedundant: false, estimatedStorageGb: 20, tags: {} },
    configSchema: [
      { key: 'name', label: 'Registry Name', type: 'text', defaultValue: 'myregistry', required: true, description: 'Letters and digits only; made unique automatically.' },
      {
        key: 'sku', label: 'Tier', type: 'select', defaultValue: 'Standard', section: 'Compute / Capacity',
        description: 'Premium is needed for private endpoints and zone redundancy.',
        options: [
          { label: 'Basic', value: 'Basic' },
          { label: 'Standard', value: 'Standard' },
          { label: 'Premium', value: 'Premium' },
        ],
      },
      { key: 'zoneRedundant', label: 'Zone Redundant', type: 'boolean', defaultValue: false, section: 'Availability & Scaling', visibleWhen: (c) => c['sku'] === 'Premium' },
      { key: 'adminEnabled', label: 'Admin User', type: 'boolean', defaultValue: false, section: 'Security', description: 'A shared username and password for the whole registry. Prefer managed identities or tokens.' },
      { key: 'publicNetworkAccess', label: 'Public Network Access', type: 'boolean', defaultValue: true, section: 'Security', description: 'Turning this off needs the Premium tier and a private endpoint.' },
      { key: 'estimatedStorageGb', label: 'Estimated Image Storage (GB)', type: 'number', defaultValue: 20, min: 0, max: 10000, section: 'Cost Estimation', description: 'Used only to estimate cost: storage above the tier allowance is billed.' },
      tags,
    ],
  },
  {
    type: 'azure_monitor',
    label: 'Azure Monitor',
    service: 'Log Analytics + Application Insights',
    provider: 'azure',
    category: 'monitoring',
    icon: 'MON',
    color: '#0078D4',
    bgColor: '#E0F2FE',
    borderColor: '#0284C7',
    monthlyBaseCost: 11.5,
    defaultConfig: {
      name: 'my-monitor', retentionDays: 30, dailyQuotaGb: -1, applicationInsightsEnabled: true,
      internetIngestionEnabled: true, internetQueryEnabled: true, estimatedIngestionGbPerMonth: 10, tags: {},
    },
    configSchema: [
      { key: 'name', label: 'Workspace Name', type: 'text', defaultValue: 'my-monitor', required: true },
      { key: 'applicationInsightsEnabled', label: 'Application Insights', type: 'boolean', defaultValue: true, section: 'Monitoring', description: 'Adds a workspace-based Application Insights component for application telemetry.' },
      { key: 'retentionDays', label: 'Retention (days)', type: 'number', defaultValue: 30, min: 30, max: 730, section: 'Backup & Recovery', description: 'The first 31 days are included; longer retention is billed per GB-month.' },
      { key: 'dailyQuotaGb', label: 'Daily Ingestion Cap (GB)', type: 'number', defaultValue: -1, min: -1, max: 10000, section: 'Cost Estimation', description: '-1 means no cap. A cap stops collection for the rest of the day when reached.' },
      { key: 'internetIngestionEnabled', label: 'Ingestion From the Internet', type: 'boolean', defaultValue: true, section: 'Security', advanced: true },
      { key: 'internetQueryEnabled', label: 'Queries From the Internet', type: 'boolean', defaultValue: true, section: 'Security', advanced: true },
      { key: 'estimatedIngestionGbPerMonth', label: 'Estimated Ingestion (GB per month)', type: 'number', defaultValue: 10, min: 0, max: 100000, section: 'Cost Estimation', description: 'Used only to estimate cost. The first 5 GB per workspace each month are free.' },
      tags,
    ],
  },
  {
    type: 'azure_private_endpoint',
    label: 'Private Endpoint',
    service: 'Azure Private Link',
    provider: 'azure',
    category: 'networking',
    icon: 'PE',
    color: '#0078D4',
    bgColor: '#D1FAE5',
    borderColor: '#047857',
    monthlyBaseCost: 7.3,
    defaultConfig: { name: 'my-private-endpoint', subresource: 'auto', privateDns: true, estimatedDataGbPerMonth: 100, tags: {} },
    configSchema: [
      { key: 'name', label: 'Endpoint Name', type: 'text', defaultValue: 'my-private-endpoint', required: true },
      {
        key: 'subresource', label: 'Sub-resource', type: 'select', defaultValue: 'auto', section: 'General',
        description: 'Which part of the target the endpoint reaches. "Automatic" picks the usual one (blob for a storage account). Connect the endpoint to the service it should reach.',
        options: [
          { label: 'Automatic', value: 'auto' },
          { label: 'Storage: blob', value: 'blob' },
          { label: 'Storage: file', value: 'file' },
          { label: 'Storage: queue', value: 'queue' },
          { label: 'Storage: table', value: 'table' },
          { label: 'Storage: Data Lake (dfs)', value: 'dfs' },
        ],
      },
      { key: 'privateDns', label: 'Private DNS Zone', type: 'boolean', defaultValue: true, section: 'Networking', description: 'Creates the private DNS zone and links it to the network, so the service name resolves to the private address. Almost always needed.' },
      { key: 'estimatedDataGbPerMonth', label: 'Estimated Data Processed (GB per month)', type: 'number', defaultValue: 100, min: 0, max: 1000000, section: 'Cost Estimation', description: 'Used only to estimate cost: inbound and outbound data is billed per GB.' },
      tags,
    ],
  },
];

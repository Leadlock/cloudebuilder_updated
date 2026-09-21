import { ResourceDefinition } from '@/types';

export const gcpResources: ResourceDefinition[] = [
  // ─── Hierarchy containers ─────────────────────────────────────────────────
  {
    type: 'gcp_project',
    label: 'GCP Project',
    service: 'Resource Manager',
    provider: 'gcp',
    category: 'networking',
    icon: 'PROJ',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 0,
    isContainer: true,
    allowedChildren: [
      'gcp_vpc', 'gcp_region', 'gcp_storage_bucket', 'gcp_iam', 'gcp_cloud_run',
      'gcp_cloud_function', 'gcp_api_gateway', 'gcp_cloud_cdn', 'gcp_cloud_dns',
    ],
    defaultWidth: 1100,
    defaultHeight: 800,
    defaultConfig: { projectId: 'my-project', name: 'My Project', billingAccount: '' },
    configSchema: [
      { key: 'projectId', label: 'Project ID', type: 'text', defaultValue: 'my-project', required: true },
      { key: 'name', label: 'Display Name', type: 'text', defaultValue: 'My Project', required: true },
      { key: 'billingAccount', label: 'Billing Account', type: 'text', defaultValue: '' },
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_project',
      generateHcl: (config, _ctx) =>
        `resource "google_project" "${config.projectId}" {\n  name       = "${config.name}"\n  project_id = "${config.projectId}"\n  billing_account = "${config.billingAccount}"\n}`,
    },
    costCalculator: () => ({ monthlyCost: 0, breakdown: [] }),
  },
  {
    type: 'gcp_region',
    label: 'Region',
    service: 'Compute Engine',
    provider: 'gcp',
    category: 'networking',
    icon: 'RGON',
    color: '#0F9D58',
    bgColor: '#E6F4EA',
    borderColor: '#188038',
    monthlyBaseCost: 0,
    isContainer: true,
    allowedChildren: [
      'gcp_vpc', 'gcp_subnet', 'gcp_zone', 'gcp_sql_instance', 'gcp_storage_bucket',
      'gcp_cloud_run', 'gcp_cloud_function', 'gcp_load_balancer', 'gcp_cloud_nat',
    ],
    defaultWidth: 860,
    defaultHeight: 620,
    defaultConfig: { name: 'us-central1' },
    configSchema: [
      {
        key: 'name', label: 'Region', type: 'select', defaultValue: 'us-central1',
        options: [
          { label: 'us-central1 (Iowa)', value: 'us-central1' },
          { label: 'us-east1 (South Carolina)', value: 'us-east1' },
          { label: 'us-west1 (Oregon)', value: 'us-west1' },
          { label: 'europe-west1 (Belgium)', value: 'europe-west1' },
          { label: 'europe-west2 (London)', value: 'europe-west2' },
          { label: 'asia-east1 (Taiwan)', value: 'asia-east1' },
          { label: 'asia-northeast1 (Tokyo)', value: 'asia-northeast1' },
          { label: 'asia-south1 (Mumbai)', value: 'asia-south1' },
          { label: 'australia-southeast1 (Sydney)', value: 'australia-southeast1' },
          { label: 'southamerica-east1 (São Paulo)', value: 'southamerica-east1' },
        ],
      },
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_compute_region',
      generateHcl: (config, _ctx) =>
        `# Region: ${config.name}\n# Note: GCP regions are referenced in resource configurations, not declared as separate resources.`,
    },
    costCalculator: () => ({ monthlyCost: 0, breakdown: [] }),
  },
  {
    type: 'gcp_zone',
    label: 'Zone',
    service: 'Compute Engine',
    provider: 'gcp',
    category: 'networking',
    icon: 'ZONE',
    color: '#0F9D58',
    bgColor: '#E6F4EA',
    borderColor: '#188038',
    monthlyBaseCost: 0,
    isContainer: true,
    allowedChildren: ['gcp_compute_instance', 'gcp_mig'],
    defaultWidth: 400,
    defaultHeight: 300,
    defaultConfig: { name: 'us-central1-a' },
    configSchema: [
      {
        key: 'name', label: 'Zone', type: 'select', defaultValue: 'us-central1-a',
        options: [
          { label: 'us-central1-a', value: 'us-central1-a' },
          { label: 'us-central1-b', value: 'us-central1-b' },
          { label: 'us-central1-c', value: 'us-central1-c' },
          { label: 'us-east1-b', value: 'us-east1-b' },
          { label: 'us-east1-c', value: 'us-east1-c' },
          { label: 'us-west1-a', value: 'us-west1-a' },
          { label: 'europe-west1-b', value: 'europe-west1-b' },
          { label: 'europe-west1-c', value: 'europe-west1-c' },
          { label: 'asia-east1-a', value: 'asia-east1-a' },
          { label: 'asia-northeast1-a', value: 'asia-northeast1-a' },
        ],
      },
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_compute_zone',
      generateHcl: (config, _ctx) =>
        `# Zone: ${config.name}\n# Note: Zones are referenced in zonal resource configurations (e.g. google_compute_instance).`,
    },
    costCalculator: () => ({ monthlyCost: 0, breakdown: [] }),
  },
  // ─── Existing resources (unchanged below) ─────────────────────────────────
  {
    type: 'gcp_vpc',

    label: 'VPC Network',
    service: 'VPC',
    provider: 'gcp',
    category: 'networking',
    icon: 'VPC',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 0,
    isContainer: true,
    allowedChildren: ['gcp_subnet', 'gcp_firewall'],
    defaultWidth: 780,
    defaultHeight: 520,
    defaultConfig: { name: 'my-vpc', autoCreateSubnetworks: false, routingMode: 'REGIONAL' },
    configSchema: [
      { key: 'name', label: 'Name', type: 'text', defaultValue: 'my-vpc', required: true },
      { key: 'autoCreateSubnetworks', label: 'Auto-create Subnets', type: 'boolean', defaultValue: false },
      { key: 'routingMode', label: 'Routing Mode', type: 'select', defaultValue: 'REGIONAL', options: [{label: 'Regional', value: 'REGIONAL'}, {label: 'Global', value: 'GLOBAL'}] },
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_compute_network',
      generateHcl: (config, ctx) => {
        const resourceName = ctx.name || config.name;
        return `resource "google_compute_network" "${resourceName}" {\n  name                    = "${config.name}"\n  auto_create_subnetworks = ${config.autoCreateSubnetworks}\n  routing_mode            = "${config.routingMode}"\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 0, breakdown: [] })
  },
  {
    type: 'gcp_subnet',
    label: 'Subnet',
    service: 'VPC Subnet',
    provider: 'gcp',
    category: 'networking',
    icon: 'SUB',
    color: '#0F9D58',
    bgColor: '#E6F4EA',
    borderColor: '#188038',
    monthlyBaseCost: 0,
    isContainer: true,
    allowedChildren: ['gcp_compute_instance', 'gcp_sql_instance', 'gcp_mig'],
    defaultWidth: 340,
    defaultHeight: 240,
    defaultConfig: { name: 'my-subnet', ipCidrRange: '10.0.0.0/24', region: 'us-central1' },
    configSchema: [
      { key: 'name', label: 'Name', type: 'text', defaultValue: 'my-subnet', required: true },
      { key: 'ipCidrRange', label: 'CIDR Block', type: 'cidr', defaultValue: '10.0.0.0/24', required: true },
      { key: 'region', label: 'Region', type: 'select', defaultValue: 'us-central1', options: [{label: 'us-central1', value: 'us-central1'}] }
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_compute_subnetwork',
      generateHcl: (config, ctx) => {
        const resourceName = ctx.name || config.name;
        return `resource "google_compute_subnetwork" "${resourceName}" {\n  name          = "${config.name}"\n  ip_cidr_range = "${config.ipCidrRange}"\n  region        = "${config.region}"\n  network       = \${google_compute_network.\${ctx.parentId}.id}\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 0, breakdown: [] })
  },
  {
    type: 'gcp_firewall',
    label: 'Firewall Rule',
    service: 'Cloud Firewall',
    provider: 'gcp',
    category: 'security',
    icon: 'FW',
    color: '#DB4437',
    bgColor: '#FCE8E6',
    borderColor: '#D93025',
    monthlyBaseCost: 0,
    isContainer: false,
    defaultConfig: { name: 'allow-internal', direction: 'INGRESS', action: 'allow', protocol: 'tcp', ports: '22,80,443', sourceRanges: '10.0.0.0/8' },
    configSchema: [
      { key: 'name', label: 'Name', type: 'text', defaultValue: 'allow-internal', required: true },
      { key: 'direction', label: 'Direction', type: 'select', defaultValue: 'INGRESS', options: [{ label: 'Ingress', value: 'INGRESS' }, { label: 'Egress', value: 'EGRESS' }] },
      { key: 'action', label: 'Action', type: 'select', defaultValue: 'allow', options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }] },
      { key: 'protocol', label: 'Protocol', type: 'text', defaultValue: 'tcp' },
      { key: 'ports', label: 'Ports', type: 'text', defaultValue: '22,80,443' },
      { key: 'sourceRanges', label: 'Source Ranges (CIDR)', type: 'text', defaultValue: '10.0.0.0/8' },
    ],
    securityRules: [
      {
        id: 'firewall-sensitive-port-open',
        severity: 'critical',
        check: (config) => {
          if (config.direction !== 'INGRESS' || config.action !== 'allow' || config.sourceRanges !== '0.0.0.0/0') return null;
          const sensitive = ['22', '3389', '3306', '5432', '6379', '27017'];
          const ports = String(config.ports || '').split(',').map((p) => p.trim());
          const hit = ports.find((p) => sensitive.includes(p));
          return hit ? `Firewall rule allows public access to port ${hit}` : null;
        },
        message: 'Firewall rule allows inbound access to a sensitive port from 0.0.0.0/0',
        recommendation: 'Restrict sensitive ports (SSH, RDP, database ports) to specific source ranges or use IAP',
        fixAction: (config) => ({ ...config, sourceRanges: '10.0.0.0/8' }),
      },
    ],
    terraform: {
      primaryResourceType: 'google_compute_firewall',
      generateHcl: (config, ctx) => {
        const resourceName = ctx.name || config.name;
        const block = config.action === 'deny' ? 'deny' : 'allow';
        const ports = String(config.ports ?? '').split(',').map((p) => `"${p.trim()}"`).join(', ');
        return `resource "google_compute_firewall" "${resourceName}" {\n  name      = "${config.name}"\n  network   = \${google_compute_network.\${ctx.parentId}.name}\n  direction = "${config.direction || 'INGRESS'}"\n\n  ${block} {\n    protocol = "${config.protocol}"\n    ports    = [${ports}]\n  }\n\n  source_ranges = ["${config.sourceRanges || '0.0.0.0/0'}"]\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 0, breakdown: [] })
  },
  {
    type: 'gcp_compute_instance',
    label: 'Compute Instance',
    service: 'Compute Engine',
    provider: 'gcp',
    category: 'compute',
    icon: 'VM',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 20,
    isContainer: false,
    defaultConfig: { name: 'my-instance', machineType: 'e2-micro', zone: 'us-central1-a', image: 'debian-cloud/debian-11', assignPublicIp: false, tags: '' },
    configSchema: [
      { key: 'name', label: 'Name', type: 'text', defaultValue: 'my-instance', required: true },
      { key: 'machineType', label: 'Machine Type', type: 'select', defaultValue: 'e2-micro', options: [{label: 'e2-micro', value: 'e2-micro'}, {label: 'e2-medium', value: 'e2-medium'}] },
      { key: 'zone', label: 'Zone', type: 'select', defaultValue: 'us-central1-a', options: [{label: 'us-central1-a', value: 'us-central1-a'}] },
      { key: 'image', label: 'Image', type: 'text', defaultValue: 'debian-cloud/debian-11' },
      { key: 'assignPublicIp', label: 'Assign Public IP', type: 'boolean', defaultValue: false },
      { key: 'tags', label: 'Network Tags', type: 'text', defaultValue: '' },
    ],
    securityRules: [
      {
        id: 'compute-public-ip',
        severity: 'medium',
        check: (config) => config.assignPublicIp ? 'Compute instance has a public IP address' : null,
        message: 'Compute instance is directly reachable from the internet',
        recommendation: 'Remove the public IP and use Cloud NAT for outbound access, or IAP for admin access',
        fixAction: (config) => ({ ...config, assignPublicIp: false }),
      },
    ],
    terraform: {
      primaryResourceType: 'google_compute_instance',
      generateHcl: (config, ctx) => {
        const resourceName = ctx.name || config.name;
        const accessConfig = config.assignPublicIp ? '\n    access_config {\n      // Ephemeral IP\n    }' : '';
        const tagsLine = config.tags ? `\n  tags = [${String(config.tags).split(',').map((t: string) => `"${t.trim()}"`).join(', ')}]` : '';
        return `resource "google_compute_instance" "${resourceName}" {\n  name         = "${config.name}"\n  machine_type = "${config.machineType}"\n  zone         = "${config.zone}"${tagsLine}\n\n  boot_disk {\n    initialize_params {\n      image = "${config.image}"\n    }\n  }\n\n  network_interface {\n    subnetwork = \${google_compute_subnetwork.\${ctx.parentId}.id}${accessConfig}\n  }\n}`;
      }
    },
    costCalculator: (config) => ({ monthlyCost: config.machineType === 'e2-micro' ? 5 : 25, breakdown: [] })
  },
  {
    type: 'gcp_mig',
    label: 'Managed Instance Group',
    service: 'Compute Engine',
    provider: 'gcp',
    category: 'compute',
    icon: 'MIG',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 50,
    isContainer: true,
    allowedChildren: ['gcp_compute_instance'],
    defaultConfig: { name: 'my-mig', targetSize: 2, zone: 'us-central1-a' },
    configSchema: [
      { key: 'name', label: 'Name', type: 'text', defaultValue: 'my-mig', required: true },
      { key: 'targetSize', label: 'Target Size', type: 'number', defaultValue: 2 },
      { key: 'zone', label: 'Zone', type: 'select', defaultValue: 'us-central1-a', options: [{label: 'us-central1-a', value: 'us-central1-a'}] }
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_compute_instance_group_manager',
      generateHcl: (config, _ctx) => {
        return `resource "google_compute_instance_group_manager" "${config.name}" {\n  name = "${config.name}"\n  zone = "${config.zone}"\n  target_size = ${config.targetSize}\n}`;
      }
    },
    costCalculator: (config) => ({ monthlyCost: Number(config.targetSize || 2) * 25, breakdown: [] })
  },
  {
    type: 'gcp_load_balancer',
    label: 'Cloud Load Balancing',
    service: 'Load Balancing',
    provider: 'gcp',
    category: 'networking',
    icon: 'LB',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 18,
    isContainer: false,
    defaultConfig: { name: 'my-lb' },
    configSchema: [
      { key: 'name', label: 'Name', type: 'text', defaultValue: 'my-lb', required: true }
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_compute_global_forwarding_rule',
      generateHcl: (config, _ctx) => {
        return `resource "google_compute_global_forwarding_rule" "${config.name}" {\n  name = "${config.name}"\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 18, breakdown: [] })
  },
  {
    type: 'gcp_storage_bucket',
    label: 'Cloud Storage',
    service: 'Storage',
    provider: 'gcp',
    category: 'storage',
    icon: 'GCS',
    color: '#F4B400',
    bgColor: '#FEF7E0',
    borderColor: '#F29900',
    monthlyBaseCost: 0,
    isContainer: false,
    defaultConfig: { name: 'my-bucket', location: 'US', storageClass: 'STANDARD', forceDestroy: false, publicAccessPrevention: 'enforced', uniformBucketLevelAccess: true, versioning: false },
    configSchema: [
      { key: 'name', label: 'Bucket Name', type: 'text', defaultValue: 'my-bucket', required: true },
      { key: 'location', label: 'Location', type: 'text', defaultValue: 'US' },
      { key: 'storageClass', label: 'Storage Class', type: 'select', defaultValue: 'STANDARD', options: [{label:'Standard',value:'STANDARD'},{label:'Nearline',value:'NEARLINE'}] },
      { key: 'forceDestroy', label: 'Force Destroy', type: 'boolean', defaultValue: false },
      { key: 'publicAccessPrevention', label: 'Public Access Prevention', type: 'select', defaultValue: 'enforced', options: [{label:'Enforced',value:'enforced'},{label:'Inherited',value:'inherited'}] },
      { key: 'uniformBucketLevelAccess', label: 'Uniform Bucket-Level Access', type: 'boolean', defaultValue: true },
      { key: 'versioning', label: 'Object Versioning', type: 'boolean', defaultValue: false },
    ],
    securityRules: [
      {
        id: 'bucket-public-access-prevention',
        severity: 'critical',
        check: (config) => config.publicAccessPrevention !== 'enforced' ? 'Bucket does not enforce Public Access Prevention' : null,
        message: 'Cloud Storage bucket may allow public access via IAM/ACL grants',
        recommendation: 'Set Public Access Prevention to "enforced"',
        fixAction: (config) => ({ ...config, publicAccessPrevention: 'enforced' }),
      },
      {
        id: 'bucket-uniform-access',
        severity: 'medium',
        check: (config) => !config.uniformBucketLevelAccess ? 'Bucket uses legacy per-object ACLs' : null,
        message: 'Uniform bucket-level access is disabled',
        recommendation: 'Enable uniform bucket-level access to simplify and centralize permissions',
        fixAction: (config) => ({ ...config, uniformBucketLevelAccess: true }),
      },
    ],
    terraform: {
      primaryResourceType: 'google_storage_bucket',
      generateHcl: (config, _ctx) => {
        return `resource "google_storage_bucket" "${config.name}" {\n  name                        = "${config.name}"\n  location                    = "${config.location}"\n  storage_class               = "${config.storageClass}"\n  force_destroy               = ${config.forceDestroy}\n  public_access_prevention    = "${config.publicAccessPrevention || 'enforced'}"\n  uniform_bucket_level_access = ${config.uniformBucketLevelAccess !== false}\n\n  versioning {\n    enabled = ${!!config.versioning}\n  }\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 5, breakdown: [] })
  },
  {
    type: 'gcp_sql_instance',
    label: 'Cloud SQL',
    service: 'Database',
    provider: 'gcp',
    category: 'database',
    icon: 'SQL',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 100,
    isContainer: false,
    defaultConfig: { name: 'my-sql', databaseVersion: 'POSTGRES_14', tier: 'db-f1-micro', region: 'us-central1', publicIpEnabled: false, requireSsl: true, backupEnabled: true },
    configSchema: [
      { key: 'name', label: 'Instance Name', type: 'text', defaultValue: 'my-sql', required: true },
      { key: 'databaseVersion', label: 'DB Version', type: 'select', defaultValue: 'POSTGRES_14', options: [{label:'PostgreSQL 14',value:'POSTGRES_14'},{label:'MySQL 8.0',value:'MYSQL_8_0'}] },
      { key: 'tier', label: 'Machine Tier', type: 'text', defaultValue: 'db-f1-micro' },
      { key: 'region', label: 'Region', type: 'text', defaultValue: 'us-central1' },
      { key: 'publicIpEnabled', label: 'Public IP Enabled', type: 'boolean', defaultValue: false },
      { key: 'requireSsl', label: 'Require SSL', type: 'boolean', defaultValue: true },
      { key: 'backupEnabled', label: 'Automated Backups', type: 'boolean', defaultValue: true },
    ],
    securityRules: [
      {
        id: 'sql-public-ip',
        severity: 'critical',
        check: (config) => config.publicIpEnabled ? 'Cloud SQL instance has a public IP' : null,
        message: 'Cloud SQL instance is reachable from the internet',
        recommendation: 'Disable the public IP and use private IP / Cloud SQL Auth Proxy',
        fixAction: (config) => ({ ...config, publicIpEnabled: false }),
      },
      {
        id: 'sql-require-ssl',
        severity: 'high',
        check: (config) => !config.requireSsl ? 'Cloud SQL instance does not require SSL' : null,
        message: 'Cloud SQL instance allows unencrypted connections',
        recommendation: 'Require SSL/TLS for all client connections',
        fixAction: (config) => ({ ...config, requireSsl: true }),
      },
      {
        id: 'sql-no-backups',
        severity: 'medium',
        check: (config) => !config.backupEnabled ? 'Cloud SQL automated backups disabled' : null,
        message: 'Cloud SQL instance has no automated backups configured',
        recommendation: 'Enable automated backups for disaster recovery',
        fixAction: (config) => ({ ...config, backupEnabled: true }),
      },
    ],
    terraform: {
      primaryResourceType: 'google_sql_database_instance',
      generateHcl: (config, _ctx) => {
        return `resource "google_sql_database_instance" "${config.name}" {\n  name             = "${config.name}"\n  database_version = "${config.databaseVersion}"\n  region           = "${config.region}"\n\n  settings {\n    tier = "${config.tier}"\n\n    ip_configuration {\n      ipv4_enabled    = ${!!config.publicIpEnabled}\n      require_ssl     = ${config.requireSsl !== false}\n    }\n\n    backup_configuration {\n      enabled = ${config.backupEnabled !== false}\n    }\n  }\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 50, breakdown: [] })
  },
  {
    type: 'gcp_cloud_run',
    label: 'Cloud Run',
    service: 'Serverless Compute',
    provider: 'gcp',
    category: 'compute',
    icon: 'RUN',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 0,
    isContainer: false,
    defaultConfig: { name: 'my-service', location: 'us-central1', image: 'gcr.io/cloudrun/hello' },
    configSchema: [
      { key: 'name', label: 'Service Name', type: 'text', defaultValue: 'my-service', required: true },
      { key: 'location', label: 'Region', type: 'text', defaultValue: 'us-central1' },
      { key: 'image', label: 'Container Image', type: 'text', defaultValue: 'gcr.io/cloudrun/hello' }
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_cloud_run_service',
      generateHcl: (config, _ctx) => {
        return `resource "google_cloud_run_service" "${config.name}" {\n  name     = "${config.name}"\n  location = "${config.location}"\n\n  template {\n    spec {\n      containers {\n        image = "${config.image}"\n      }\n    }\n  }\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 0, breakdown: [] })
  },
  {
    type: 'gcp_cloud_function',
    label: 'Cloud Function',
    service: 'Serverless Functions',
    provider: 'gcp',
    category: 'compute',
    icon: 'FUNC',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 0,
    isContainer: false,
    defaultConfig: { name: 'my-function', runtime: 'nodejs18', entryPoint: 'helloWorld', region: 'us-central1' },
    configSchema: [
      { key: 'name', label: 'Function Name', type: 'text', defaultValue: 'my-function', required: true },
      { key: 'runtime', label: 'Runtime', type: 'text', defaultValue: 'nodejs18' },
      { key: 'entryPoint', label: 'Entry Point', type: 'text', defaultValue: 'helloWorld' },
      { key: 'region', label: 'Region', type: 'text', defaultValue: 'us-central1' }
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_cloudfunctions_function',
      generateHcl: (config, _ctx) => {
        return `resource "google_cloudfunctions_function" "${config.name}" {\n  name        = "${config.name}"\n  runtime     = "${config.runtime}"\n  entry_point = "${config.entryPoint}"\n  region      = "${config.region}"\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 0, breakdown: [] })
  },
  {
    type: 'gcp_api_gateway',
    label: 'API Gateway',
    service: 'API Management',
    provider: 'gcp',
    category: 'networking',
    icon: 'API',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 0,
    isContainer: false,
    defaultConfig: { name: 'my-api-gateway' },
    configSchema: [
      { key: 'name', label: 'Gateway Name', type: 'text', defaultValue: 'my-api-gateway', required: true }
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_api_gateway_gateway',
      generateHcl: (config, _ctx) => {
        return `resource "google_api_gateway_gateway" "${config.name}" {\n  gateway_id = "${config.name}"\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 10, breakdown: [] })
  },
  {
    type: 'gcp_cloud_cdn',
    label: 'Cloud CDN',
    service: 'Content Delivery',
    provider: 'gcp',
    category: 'networking',
    icon: 'CDN',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 0,
    isContainer: false,
    defaultConfig: { name: 'my-cdn' },
    configSchema: [
      { key: 'name', label: 'CDN Name', type: 'text', defaultValue: 'my-cdn', required: true }
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_compute_backend_bucket',
      generateHcl: (config, _ctx) => {
        return `resource "google_compute_backend_bucket" "${config.name}" {\n  name        = "${config.name}"\n  enable_cdn  = true\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 20, breakdown: [] })
  },
  {
    type: 'gcp_cloud_dns',
    label: 'Cloud DNS',
    service: 'DNS',
    provider: 'gcp',
    category: 'networking',
    icon: 'DNS',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 0,
    isContainer: false,
    defaultConfig: { name: 'my-dns-zone', dnsName: 'example.com.' },
    configSchema: [
      { key: 'name', label: 'Zone Name', type: 'text', defaultValue: 'my-dns-zone', required: true },
      { key: 'dnsName', label: 'DNS Name', type: 'text', defaultValue: 'example.com.' }
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_dns_managed_zone',
      generateHcl: (config, _ctx) => {
        return `resource "google_dns_managed_zone" "${config.name}" {\n  name     = "${config.name}"\n  dns_name = "${config.dnsName}"\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 0.20, breakdown: [] })
  },
  {
    type: 'gcp_cloud_nat',
    label: 'Cloud NAT',
    service: 'Network Address Translation',
    provider: 'gcp',
    category: 'networking',
    icon: 'NAT',
    color: '#4285F4',
    bgColor: '#E8F0FE',
    borderColor: '#1A73E8',
    monthlyBaseCost: 32,
    isContainer: false,
    defaultConfig: { name: 'my-nat', router: 'my-router', region: 'us-central1' },
    configSchema: [
      { key: 'name', label: 'NAT Name', type: 'text', defaultValue: 'my-nat', required: true },
      { key: 'router', label: 'Router Name', type: 'text', defaultValue: 'my-router' },
      { key: 'region', label: 'Region', type: 'text', defaultValue: 'us-central1' }
    ],
    securityRules: [],
    terraform: {
      primaryResourceType: 'google_compute_router_nat',
      generateHcl: (config, _ctx) => {
        return `resource "google_compute_router_nat" "${config.name}" {\n  name                               = "${config.name}"\n  router                             = "${config.router}"\n  region                             = "${config.region}"\n  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 32, breakdown: [] })
  },
  {
    type: 'gcp_iam',
    label: 'IAM Service Account',
    service: 'Identity and Access Management',
    provider: 'gcp',
    category: 'security',
    icon: 'IAM',
    color: '#DB4437',
    bgColor: '#FCE8E6',
    borderColor: '#D93025',
    monthlyBaseCost: 0,
    isContainer: false,
    defaultConfig: { accountId: 'my-service-account', displayName: 'My Service Account', role: 'roles/viewer' },
    configSchema: [
      { key: 'accountId', label: 'Account ID', type: 'text', defaultValue: 'my-service-account', required: true },
      { key: 'displayName', label: 'Display Name', type: 'text', defaultValue: 'My Service Account' },
      { key: 'role', label: 'IAM Role', type: 'text', defaultValue: 'roles/viewer' },
    ],
    securityRules: [
      {
        id: 'iam-overly-broad-role',
        severity: 'critical',
        check: (config) => ['roles/owner', 'roles/editor'].includes(String(config.role)) ? `Service account granted overly broad role (${config.role})` : null,
        message: 'Service account has a primitive Owner/Editor role instead of a scoped role',
        recommendation: 'Grant the minimum set of predefined or custom IAM roles needed (principle of least privilege)',
      },
    ],
    terraform: {
      primaryResourceType: 'google_service_account',
      generateHcl: (config, _ctx) => {
        return `resource "google_service_account" "${config.accountId}" {\n  account_id   = "${config.accountId}"\n  display_name = "${config.displayName}"\n}`;
      }
    },
    costCalculator: () => ({ monthlyCost: 0, breakdown: [] })
  }
];

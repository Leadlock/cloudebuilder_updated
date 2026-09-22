export type CloudProvider = 'aws' | 'azure' | 'gcp' | 'multi';
export type ProviderMode = 'AWS' | 'AZURE' | 'MULTI_CLOUD';

/**
 * 'gcp' is retained only as a CloudProvider value so legacy persisted records
 * (projects/nodes saved before GCP support was removed) still type-check and
 * load instead of crashing. No current UI, RDE, engine, or API path can
 * create a new 'gcp' node. An unrecognized/legacy ProviderMode string (e.g.
 * a persisted 'GCP') falls through the if/else chains in
 * providerModeToCloudProvider/cloudProviderToProviderMode below to the
 * 'multi'/'MULTI_CLOUD' default rather than throwing.
 */

export function providerModeToCloudProvider(mode: ProviderMode): CloudProvider {
  if (mode === 'AWS') return 'aws';
  if (mode === 'AZURE') return 'azure';
  return 'multi';
}

export function cloudProviderToProviderMode(provider: CloudProvider): ProviderMode {
  if (provider === 'aws') return 'AWS';
  if (provider === 'azure') return 'AZURE';
  return 'MULTI_CLOUD';
}

/** Best-effort single-cloud provider for a node, falling back to its resourceType prefix when `provider` is unset. */
export function inferNodeProvider(node: { provider?: CloudProvider; resourceType: string }): 'aws' | 'azure' {
  if (node.provider === 'aws' || node.provider === 'azure') return node.provider;
  if (node.resourceType.startsWith('azure_')) return 'azure';
  return 'aws';
}

/** Whether a node belongs in an architecture locked to the given single-cloud provider mode. Multi-cloud accepts everything. */
export function isNodeCompatibleWithProviderMode(node: { provider?: CloudProvider; resourceType: string }, mode: ProviderMode): boolean {
  if (mode === 'MULTI_CLOUD') return true;
  return inferNodeProvider(node) === providerModeToCloudProvider(mode);
}

export interface ScaleProfile {
  expectedUsers: number;
  requestsPerSecond?: number;
  peakRequestsPerSecond?: number;
  availabilityTarget?: number | string; // e.g. 99.9 or '99.99%'
  geographicDistribution?: string;
  dataGrowth?: string;
  trafficPattern?: string;
}

export type CanvasViewMode = 'architecture' | 'network' | 'security' | 'cost' | 'terraform' | 'deployment';
export type AppView =
  | 'dashboard'
  | 'canvas'
  | 'terraform'
  | 'security'
  | 'cost'
  | 'cost-comparison'
  | 'deploy'
  | 'wizard'
  | 'templates'
  | 'ai-generator'
  | 'advisor'
  | 'analyze'
  | 'well-architected'
  | 'disaster-recovery'
  | 'import'
  | 'history'
  | 'environments'
  | 'review'
  | 'team';

export type Environment = 'development' | 'staging' | 'production';
export type ResourceCategory =
  | 'networking'
  | 'compute'
  | 'storage'
  | 'database'
  | 'security'
  | 'loadbalancing'
  | 'messaging'
  | 'serverless'
  | 'ai'
  | 'monitoring';

export type Region =
  | 'us-east-1' | 'us-east-2' | 'us-west-1' | 'us-west-2' | 'ca-central-1' | 'ca-west-1' | 'mx-central-1'
  | 'eu-west-1' | 'eu-west-2' | 'eu-west-3' | 'eu-central-1' | 'eu-central-2' | 'eu-north-1' | 'eu-south-1' | 'eu-south-2'
  | 'ap-south-1' | 'ap-south-2' | 'ap-southeast-1' | 'ap-southeast-2' | 'ap-southeast-3' | 'ap-southeast-4'
  | 'ap-northeast-1' | 'ap-northeast-2' | 'ap-northeast-3' | 'ap-east-1' | 'sa-east-1' | 'me-south-1' | 'me-central-1' | 'il-central-1' | 'af-south-1'
  | 'eastus' | 'eastus2' | 'westus' | 'westus2' | 'westus3' | 'centralus' | 'northcentralus' | 'southcentralus' | 'canadacentral' | 'canadaeast' | 'mexicocentral'
  | 'westeurope' | 'northeurope' | 'uksouth' | 'ukwest' | 'francecentral' | 'germanywestcentral' | 'switzerlandnorth' | 'norwayeast' | 'swedencentral' | 'polandcentral' | 'italynorth' | 'spaincentral'
  | 'centralindia' | 'southindia' | 'westindia'
  | 'southeastasia' | 'eastasia' | 'japaneast' | 'japanwest' | 'koreacentral' | 'koreasouth' | 'australiaeast' | 'australiasoutheast' | 'indonesiacentral'
  | 'uaenorth' | 'southafricanorth' | 'israelcentral' | 'qatarcentral' | 'brazilsouth' | 'chilecentral'
  | (string & {});

export const REGION_LABELS: Record<string, string> = {
  // AWS
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'ca-central-1': 'Canada (Central)',
  'ca-west-1': 'Canada West (Calgary)',
  'mx-central-1': 'Mexico (Central)',
  'eu-west-1': 'EU (Ireland)',
  'eu-west-2': 'EU (London)',
  'eu-west-3': 'EU (Paris)',
  'eu-central-1': 'EU (Frankfurt)',
  'eu-central-2': 'EU (Zurich)',
  'eu-north-1': 'EU (Stockholm)',
  'eu-south-1': 'EU (Milan)',
  'eu-south-2': 'EU (Spain)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-south-2': 'Asia Pacific (Hyderabad)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-southeast-3': 'Asia Pacific (Jakarta)',
  'ap-southeast-4': 'Asia Pacific (Melbourne)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-east-1': 'Asia Pacific (Hong Kong)',
  'sa-east-1': 'South America (São Paulo)',
  'me-south-1': 'Middle East (Bahrain)',
  'me-central-1': 'Middle East (UAE)',
  'il-central-1': 'Israel (Tel Aviv)',
  'af-south-1': 'Africa (Cape Town)',
  // Azure
  'eastus': 'East US',
  'eastus2': 'East US 2',
  'westus': 'West US',
  'westus2': 'West US 2',
  'westus3': 'West US 3',
  'centralus': 'Central US',
  'northcentralus': 'North Central US',
  'southcentralus': 'South Central US',
  'canadacentral': 'Canada Central',
  'canadaeast': 'Canada East',
  'mexicocentral': 'Mexico Central',
  'westeurope': 'West Europe',
  'northeurope': 'North Europe',
  'uksouth': 'UK South',
  'ukwest': 'UK West',
  'francecentral': 'France Central',
  'germanywestcentral': 'Germany West Central',
  'switzerlandnorth': 'Switzerland North',
  'norwayeast': 'Norway East',
  'swedencentral': 'Sweden Central',
  'polandcentral': 'Poland Central',
  'italynorth': 'Italy North',
  'spaincentral': 'Spain Central',
  'centralindia': 'Central India',
  'southindia': 'South India',
  'westindia': 'West India',
  'southeastasia': 'Southeast Asia',
  'eastasia': 'East Asia',
  'japaneast': 'Japan East',
  'japanwest': 'Japan West',
  'koreacentral': 'Korea Central',
  'koreasouth': 'Korea South',
  'australiaeast': 'Australia East',
  'australiasoutheast': 'Australia Southeast',
  'indonesiacentral': 'Indonesia Central',
  'uaenorth': 'UAE North',
  'southafricanorth': 'South Africa North',
  'israelcentral': 'Israel Central',
  'qatarcentral': 'Qatar Central',
  'brazilsouth': 'Brazil South',
  'chilecentral': 'Chile Central',
};

export const AWS_REGIONS: Region[] = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1',
  'eu-west-1', 'eu-west-2', 'eu-central-1', 'eu-north-1',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'sa-east-1', 'me-south-1', 'af-south-1',
];

export const AZURE_REGIONS: Region[] = [
  'eastus', 'eastus2', 'westus', 'westus2', 'centralus', 'southcentralus', 'canadacentral',
  'westeurope', 'northeurope', 'uksouth', 'francecentral', 'germanywestcentral',
  'centralindia', 'southindia',
  'southeastasia', 'eastasia', 'japaneast', 'australiaeast',
  'uaenorth', 'southafricanorth', 'brazilsouth',
];

export interface ResourceDefinition {
  type: string;
  label: string;
  provider: CloudProvider;
  category: ResourceCategory;
  icon: string;
  color: string;
  bgColor: string;
  borderColor: string;
  defaultConfig: Record<string, unknown>;
  configSchema: ConfigField[];
  monthlyBaseCost: number;
  securityRules?: SecurityRule[];
  description?: string;
  isContainer?: boolean;
  allowedChildren?: string[];
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  service?: string;
  terraform?: ResourceTerraformHook;
  costCalculator?: (config: Record<string, unknown>) => { monthlyCost: number; breakdown: { label: string; cost: number }[] };
}

/**
 * Optional terraform-generation hook a resource definition can carry directly,
 * for resources that don't need a dedicated generator class (see
 * lib/engines/terraform/TerraformGenerator.ts for the AWS/Azure generators).
 */
export interface ResourceTerraformHook {
  primaryResourceType?: string;
  generateHcl?: (config: Record<string, unknown>, ctx: { name: string; parentId?: string }) => string;
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'boolean' | 'cidr' | 'multiselect' | 'tags' | 'keyvalue';
  defaultValue: string | number | boolean | string[] | Record<string, string>;
  options?: { label: string; value: string }[];
  placeholder?: string;
  required?: boolean;
  validation?: (value: unknown) => string | null;
  /** Numeric bound for type: 'number'. Enforced by validation, not just UI clamping. */
  min?: number;
  max?: number;
  /** One-line explanation shown as a tooltip next to the label — for non-obvious settings only. */
  description?: string;
  /**
   * Group this field renders under in the configuration UI (e.g. 'Networking',
   * 'Storage', 'Backup & Recovery'). Fields without a section fall into 'General'.
   * See CONFIG_SECTION_ORDER in components/canvas/PropertiesPanel.tsx for the
   * canonical section ordering.
   */
  section?: string;
  /**
   * True for settings that matter to a working engineer but would overwhelm a
   * first pass (e.g. parameter groups, monitoring intervals). Hidden behind
   * the panel's Basic/Advanced toggle; never used for settings that affect
   * security or core architecture — those stay visible in Basic mode.
   */
  advanced?: boolean;
  /**
   * Field only renders when this returns true for the resource's current
   * config. Re-evaluated on every config change. Use for provider-real
   * dependent-field semantics (e.g. KMS key ID only when encryption is on,
   * IOPS only for io1/io2/gp3 storage) — never to hide a field whose value
   * would silently persist and diverge from what's shown.
   */
  visibleWhen?: (config: Record<string, unknown>) => boolean;
}

export interface SecurityRule {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  check: (config: Record<string, unknown>, allNodes: CanvasNode[]) => string | null;
  message: string;
  recommendation: string;
  fixAction?: (config: Record<string, unknown>) => Record<string, unknown>;
}

export interface CanvasNode {
  id: string;
  type: string;
  resourceType: string;
  provider: CloudProvider;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  selected?: boolean;
  region?: Region;
  locked?: boolean;
  groupId?: string;
  parentId?: string;
  width?: number;
  height?: number;
  importState?: 'imported' | 'cloudcraft-managed' | 'new' | 'modified' | 'planned';
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  edgeType?: 'data' | 'network' | 'security' | 'management' | 'cross-cloud' | string;
  relationshipType?: import('@/lib/domain/relationshipModel').RelationshipType;
  direction?: 'unidirectional' | 'bidirectional';
  protocol?: string;
  port?: string | number;
  networkScope?: import('@/lib/domain/relationshipModel').NetworkScope;
  provider?: CloudProvider;
  region?: string;
  reason?: string;
  inferred?: boolean;
  validationStatus?: import('@/lib/domain/relationshipModel').ValidationStatus;
  validationMessage?: string;
}

export type {
  RelationshipType,
  NetworkScope,
  ValidationStatus,
  ArchitectureRelationship,
  ConnectionValidationResult,
  WorkloadProfile,
  CapacityEstimate,
} from '@/lib/domain/relationshipModel';

export interface CanvasGroup {
  id: string;
  label: string;
  type: 'vpc' | 'vnet' | 'subnet' | 'region' | 'provider' | 'az';
  provider?: CloudProvider;
  region?: Region;
  color: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

export interface SecurityIssue {
  id: string;
  nodeId: string;
  nodeLabel: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  recommendation: string;
  fixable?: boolean;
  ruleId?: string;
}

export interface CostItem {
  nodeId: string;
  nodeLabel: string;
  resourceType: string;
  provider: CloudProvider;
  region?: string;
  monthlyCost: number;
  hourlyCost?: number;
  currency?: string;
  providerCostUsd?: number;
  providerHourlyUsd?: number;
  exchangeRate?: number;
  exchangeRateSource?: string;
  exchangeRateRetrievedAt?: string;
  isCachedRate?: boolean;
  isStaleRate?: boolean;
  breakdown: { label: string; cost: number; originalCostUsd?: number }[];
}

export interface CostOptimization {
  id: string;
  nodeId: string;
  nodeLabel: string;
  title: string;
  description: string;
  potentialSavings: number;
  effort: 'low' | 'medium' | 'high';
  applied?: boolean;
}

export interface ArchitectureVersion {
  id: string;
  version: number;
  label: string;
  timestamp: string;
  author: string;
  summary: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  nodeCount?: number;
}

export interface EnvironmentState {
  id: Environment;
  label: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  region: Region;
}

export interface ArchitectureScore {
  overall: number;
  reliability: number;
  security: number;
  performance: number;
  cost: number;
  scalability: number;
}

export interface Recommendation {
  id: string;
  category: 'reliability' | 'security' | 'performance' | 'cost' | 'scalability';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  affectedResources: string[];
  action: string;
}

export interface Project {
  id: string;
  name: string;
  provider: CloudProvider;
  providerMode?: ProviderMode;
  scaleProfile?: ScaleProfile;
  isDraft?: boolean;
  revision?: number;
  description: string;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  resourceCount: number;
  securityScore: number;
  architectureScore: number;
  estimatedMonthlyCost: number;
  currency?: string;
  environment: Environment;
  region: Region;
  versions: ArchitectureVersion[];
  environments: Record<Environment, EnvironmentState>;
  tags: string[];
}

export interface DeploymentStep {
  id: string;
  label: string;
  description: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'awaiting_approval';
  output?: string;
  provider?: CloudProvider;
}

export interface ArchitectureTemplate {
  id: string;
  name: string;
  description: string;
  provider: CloudProvider;
  category: string;
  tags: string[];
  complexity: 'simple' | 'moderate' | 'complex';
  /**
   * Rough cost band shown before a template is opened. This is NOT a live
   * price — the real estimate comes from running the Cost Engine against the
   * generated graph (see lib/engines/cost/CostEstimator.ts). Keep this as a
   * coarse, honestly-labeled indicator only.
   */
  estimatedCost: number;
  resourceCount: number;
  features: string[];
  isAdaptive?: boolean;
  scaleRecommendation?: string;
  /**
   * True for hand-built, technically distinct reference architectures (see
   * lib/templates/referenceArchitectures.ts) as opposed to the parameterized
   * quick-start variations generated by lib/templates/catalogData.ts, which
   * share a common shallow topology. Used by the UI to label provenance
   * honestly instead of presenting every entry as an equally deep reference.
   */
  isReferenceArchitecture?: boolean;
  /** Named architecture pattern this template implements, e.g. "Serverless REST API", "Multi-Region Disaster Recovery (Warm Standby)". */
  architecturePattern?: string;
  /** Concrete scenarios this architecture is suited for. */
  useCases?: string[];
  /** Target availability posture in plain language, e.g. "Single-AZ", "Multi-AZ (99.95%)", "Multi-Region active/standby". Never a fabricated SLA number. */
  availabilityTarget?: string;
  /** Rough scale band this shape is appropriate for, e.g. "Startup / < 10K users", "Enterprise / 1M+ users". */
  supportedScale?: string;
  /** One-line summary of how traffic/data moves through the architecture. */
  dataFlowSummary?: string;
  /**
   * Authoritative guidance this pattern is based on (AWS Architecture Center,
   * Azure Architecture Center, Well-Architected Framework, etc.). Never claim
   * a template IS an official AWS/Microsoft-published architecture unless it
   * is reproduced from a specific published reference; use "Based on ..."
   * framing otherwise.
   */
  sourceReferences?: { label: string; url?: string }[];
  generate: (opts: TemplateGenerateOptions) => { nodes: CanvasNode[]; edges: CanvasEdge[] };
}

export interface TemplateGenerateOptions {
  region?: Region;
  environment?: Environment;
  highAvailability?: boolean;
  includeMonitoring?: boolean;
  includeWAF?: boolean;
}

export interface WizardOptions {
  provider: CloudProvider;
  templateId: string;
  region: Region;
  environment: Environment;
  appType: string;
  database: string;
  highAvailability: boolean;
  securityLevel: 'basic' | 'standard' | 'high';
  budget: 'minimal' | 'moderate' | 'unlimited';
  includeMonitoring: boolean;
  includeWAF: boolean;
}

export interface AIGeneratorInput {
  prompt: string;
}

export interface AIGeneratorResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  summary: string;
  suggestedResources: string[];
  estimatedCost: number;
  securityScore: number;
}

export interface DisasterRecoveryStrategy {
  id: string;
  name: string;
  description: string;
  rto: string;
  rpo: string;
  additionalCostMultiplier: number;
  complexity: 'low' | 'medium' | 'high';
}

export interface ImportSource {
  id: string;
  label: string;
  provider?: CloudProvider;
  icon: string;
  description: string;
}

export type {
  WaFinding,
  WaAssessment,
  WaPillar,
  WaSeverity,
  AnalysisSource,
  ResourceState,
  WaPillarScore,
} from '@/lib/engines/wellArchitected/types';

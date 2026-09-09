export type CloudProvider = 'aws' | 'azure' | 'multi';
export type CanvasViewMode = 'architecture' | 'network' | 'security' | 'cost' | 'terraform' | 'deployment';
export type AppView =
  | 'dashboard'
  | 'canvas'
  | 'terraform'
  | 'security'
  | 'cost'
  | 'deploy'
  | 'wizard'
  | 'templates'
  | 'ai-generator'
  | 'advisor'
  | 'disaster-recovery'
  | 'import'
  | 'history'
  | 'environments';

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
  | 'us-east-1'
  | 'us-east-2'
  | 'us-west-1'
  | 'us-west-2'
  | 'eu-west-1'
  | 'eu-central-1'
  | 'ap-southeast-1'
  | 'ap-northeast-1'
  | 'eastus'
  | 'eastus2'
  | 'westus'
  | 'westeurope'
  | 'northeurope'
  | 'southeastasia';

export const REGION_LABELS: Record<Region, string> = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'EU (Ireland)',
  'eu-central-1': 'EU (Frankfurt)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'eastus': 'East US',
  'eastus2': 'East US 2',
  'westus': 'West US',
  'westeurope': 'West Europe',
  'northeurope': 'North Europe',
  'southeastasia': 'Southeast Asia',
};

export const AWS_REGIONS: Region[] = [
  'us-east-1','us-east-2','us-west-1','us-west-2',
  'eu-west-1','eu-central-1','ap-southeast-1','ap-northeast-1',
];
export const AZURE_REGIONS: Region[] = [
  'eastus','eastus2','westus','westeurope','northeurope','southeastasia',
];

export interface ResourceDefinition {
  type: string;
  label: string;
  provider: 'aws' | 'azure';
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
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'boolean' | 'cidr';
  defaultValue: string | number | boolean;
  options?: { label: string; value: string }[];
  placeholder?: string;
  required?: boolean;
  validation?: (value: unknown) => string | null;
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
  provider: 'aws' | 'azure';
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
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  edgeType?: 'data' | 'network' | 'security' | 'management';
}

export interface CanvasGroup {
  id: string;
  label: string;
  type: 'vpc' | 'vnet' | 'subnet' | 'region' | 'provider' | 'az';
  provider?: 'aws' | 'azure';
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
  provider: 'aws' | 'azure';
  monthlyCost: number;
  breakdown: { label: string; cost: number }[];
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
  description: string;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  resourceCount: number;
  securityScore: number;
  architectureScore: number;
  estimatedMonthlyCost: number;
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
  provider?: 'aws' | 'azure';
}

export interface ArchitectureTemplate {
  id: string;
  name: string;
  description: string;
  provider: CloudProvider;
  category: string;
  tags: string[];
  complexity: 'simple' | 'moderate' | 'complex';
  estimatedCost: number;
  resourceCount: number;
  features: string[];
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
  provider?: 'aws' | 'azure';
  icon: string;
  description: string;
}

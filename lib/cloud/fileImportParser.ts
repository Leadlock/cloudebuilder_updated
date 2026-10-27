/**
 * Parser for local architecture and Terraform files uploaded or pasted by users.
 * Supports:
 * 1. CloudBuilder Canvas Export JSON (v1 & legacy)
 * 2. CloudBuilder Architecture Template JSON
 * 3. Full CloudBuilder Project JSON
 * 4. Terraform State JSON (.tfstate or `terraform show -json`)
 * 5. Terraform HCL (.tf configuration files)
 */
import type { CanvasNode, CanvasEdge, CloudProvider } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';

export interface FileImportParsedResult {
  ok: boolean;
  filename: string;
  format: 'cloudbuilder-canvas' | 'architecture-template' | 'terraform-state' | 'terraform-hcl' | 'raw-nodes' | 'unknown';
  formatLabel: string;
  provider: CloudProvider;
  projectName: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  summary: {
    totalResources: number;
    totalConnections: number;
    resourceBreakdown: Record<string, number>;
  };
  error?: string;
}

/** Apply intelligent Well-Architected auto-layout if coordinates are absent or default */
function layoutImportedArchitecture(nodes: CanvasNode[], edges: CanvasEdge[]): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (nodes.length === 0) return { nodes, edges };

  // If any nodes have non-zero custom placement (e.g. from a saved Canvas export), preserve it
  const hasUserLayout = nodes.some((n) => n.position && (n.position.x !== 0 || n.position.y !== 0));
  if (hasUserLayout) {
    return { nodes, edges };
  }

  return autoLayoutArchitecture(nodes, edges);
}

/** Map raw Terraform resource type to CloudBuilder internal resourceType */
function mapTerraformTypeToCloudBuilder(tfType: string): { type: string; provider: 'aws' | 'azure' } {
  const raw = tfType.toLowerCase().trim();
  const provider: 'aws' | 'azure' = raw.startsWith('azurerm_') || raw.startsWith('azure_') ? 'azure' : 'aws';

  const typeMap: Record<string, string> = {
    // AWS Networking
    aws_vpc: 'aws_vpc',
    aws_subnet: 'aws_subnet',
    aws_internet_gateway: 'aws_igw',
    aws_nat_gateway: 'aws_nat',
    aws_route_table: 'aws_route_table',
    aws_security_group: 'aws_sg',
    // AWS Compute
    aws_instance: 'aws_ec2',
    aws_autoscaling_group: 'aws_auto_scaling',
    aws_lambda_function: 'aws_lambda',
    aws_ecs_cluster: 'aws_ecs',
    aws_ecs_service: 'aws_ecs',
    aws_eks_cluster: 'aws_eks',
    // AWS Storage & Database
    aws_s3_bucket: 'aws_s3',
    aws_ebs_volume: 'aws_ebs',
    aws_db_instance: 'aws_rds',
    aws_dynamodb_table: 'aws_dynamodb',
    aws_elasticache_cluster: 'aws_elasticache',
    // AWS Load Balancing & CDN
    aws_lb: 'aws_alb',
    aws_alb: 'aws_alb',
    aws_cloudfront_distribution: 'aws_cloudfront',
    aws_route53_zone: 'aws_route53',
    // AWS Governance, Security & Observability
    aws_cloudwatch_metric_alarm: 'aws_cloudwatch',
    aws_cloudwatch_log_group: 'aws_cloudwatch',
    aws_kms_key: 'aws_kms',
    aws_sqs_queue: 'aws_sqs',
    aws_sns_topic: 'aws_sns',
    aws_cloudtrail: 'aws_cloudtrail',
    aws_config_configuration_recorder: 'aws_config',
    aws_config_delivery_channel: 'aws_config',
    aws_secretsmanager_secret: 'aws_secretsmanager',
    aws_iam_role: 'aws_iam',
    aws_iam_instance_profile: 'aws_iam',
    aws_guardduty_detector: 'aws_guardduty_detector',
    aws_securityhub_account: 'aws_security_hub_account',
    aws_wafv2_web_acl: 'aws_waf',
    aws_bedrock_custom_model: 'aws_bedrock_custom_model',

    // Azure Networking
    azurerm_virtual_network: 'azure_vnet',
    azurerm_subnet: 'azure_subnet',
    azurerm_network_security_group: 'azure_nsg',
    azurerm_public_ip: 'azure_public_ip',
    azurerm_lb: 'azure_lb',
    azurerm_application_gateway: 'azure_app_gateway',
    azurerm_frontdoor: 'azure_front_door',
    // Azure Compute
    azurerm_linux_virtual_machine: 'azure_vm',
    azurerm_windows_virtual_machine: 'azure_vm',
    azurerm_virtual_machine: 'azure_vm',
    azurerm_kubernetes_cluster: 'azure_aks',
    azurerm_linux_web_app: 'azure_app_service',
    azurerm_windows_web_app: 'azure_app_service',
    azurerm_function_app: 'azure_functions',
    azurerm_container_group: 'azure_container_apps',
    // Azure Storage & Database
    azurerm_storage_account: 'azure_storage',
    azurerm_mssql_server: 'azure_sql',
    azurerm_mssql_database: 'azure_sql',
    azurerm_cosmosdb_account: 'azure_cosmos_db',
    azurerm_postgresql_flexible_server: 'azure_postgres',
    azurerm_resource_group: 'azure_resource_group',
    azurerm_key_vault: 'azure_key_vault',
  };

  if (typeMap[raw]) {
    return { type: typeMap[raw], provider };
  }

  // Check if it already exists as catalog definition
  const def = getResourceDefinition(raw);
  if (def) {
    return { type: def.type, provider };
  }

  // Fallback to normalized prefix
  if (raw.startsWith('aws_')) return { type: raw, provider: 'aws' };
  if (raw.startsWith('azurerm_')) return { type: raw.replace(/^azurerm_/, 'azure_'), provider: 'azure' };

  return { type: provider === 'azure' ? 'azure_vm' : 'aws_ec2', provider };
}

/** Parse Terraform HCL text */
function parseTerraformHcl(content: string, filename: string): FileImportParsedResult {
  const resourceBlockRegex = /resource\s+"([a-zA-Z0-9_-]+)"\s+"([a-zA-Z0-9_-]+)"\s*\{([\s\S]*?)\n\}/g;
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const breakdown: Record<string, number> = {};
  const resourceIdMap = new Map<string, string>(); // tfAddress (e.g. aws_vpc.main) -> nodeId

  let match: RegExpExecArray | null;
  let count = 0;
  let detectedProvider: CloudProvider = 'aws';

  while ((match = resourceBlockRegex.exec(content)) !== null) {
    count++;
    const tfType = match[1];
    const tfName = match[2];
    const blockBody = match[3] || '';

    const { type: cbType, provider } = mapTerraformTypeToCloudBuilder(tfType);
    if (provider === 'azure') detectedProvider = 'azure';

    const nodeId = `tf-${tfName}-${count}`;
    const tfAddress = `${tfType}.${tfName}`;
    resourceIdMap.set(tfAddress, nodeId);

    // Extract basic attributes
    const config: Record<string, unknown> = {
      name: tfName,
      imported: true,
      importState: 'imported',
      importSource: 'terraform-hcl',
      originalTfType: tfType,
    };

    // Extract simple scalar attributes: key = "value" or key = 123
    const attrRegex = /^\s*([a-zA-Z0-9_-]+)\s*=\s*(.+)$/gm;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(blockBody)) !== null) {
      const key = attrMatch[1];
      let valStr = attrMatch[2].trim();
      if ((valStr.startsWith('"') && valStr.endsWith('"')) || (valStr.startsWith("'") && valStr.endsWith("'"))) {
        config[key] = valStr.slice(1, -1);
      } else if (valStr === 'true') {
        config[key] = true;
      } else if (valStr === 'false') {
        config[key] = false;
      } else if (!Number.isNaN(Number(valStr)) && valStr !== '') {
        config[key] = Number(valStr);
      } else {
        config[key] = valStr;
      }
    }

    const isContainer = cbType === 'aws_vpc' || cbType === 'aws_subnet' || cbType === 'azure_vnet' || cbType === 'azure_resource_group';
    const def = getResourceDefinition(cbType);
    const label = (config['name'] as string) || (config['label'] as string) || def?.label || tfName;

    nodes.push({
      id: nodeId,
      type: isContainer ? 'containerNode' : 'cloudNode',
      resourceType: cbType,
      provider,
      label,
      position: { x: 0, y: 0 },
      config,
      importState: 'imported',
      width: isContainer ? 420 : undefined,
      height: isContainer ? 320 : undefined,
    });

    breakdown[cbType] = (breakdown[cbType] || 0) + 1;
  }

  if (nodes.length === 0) {
    return {
      ok: false,
      filename,
      format: 'terraform-hcl',
      formatLabel: 'Terraform HCL (.tf)',
      provider: 'aws',
      projectName: filename.replace(/\.[^/.]+$/, ''),
      nodes: [],
      edges: [],
      summary: { totalResources: 0, totalConnections: 0, resourceBreakdown: {} },
      error: 'No "resource" blocks could be recognized in the provided Terraform file.',
    };
  }

  // 1. Resolve containment hierarchy (VPC -> Subnets, Subnets -> Leaf nodes)
  const vpcNodes = nodes.filter((n) => n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet');
  const subnetNodes = nodes.filter((n) => n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet');

  nodes.forEach((n) => {
    Object.entries(n.config).forEach(([key, val]) => {
      if (typeof val !== 'string') return;

      for (const [tfAddress, targetId] of resourceIdMap.entries()) {
        if (!val.includes(tfAddress) || targetId === n.id) continue;

        const targetNode = nodes.find((tn) => tn.id === targetId);
        if (!targetNode) continue;

        // Subnet in VPC
        if (
          (n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet') &&
          (targetNode.resourceType === 'aws_vpc' || targetNode.resourceType === 'azure_vnet')
        ) {
          n.groupId = targetId;
          return;
        }

        // Compute / ALB / DB / leaf in Subnet
        if (
          (key === 'subnet_id' || key === 'subnets' || key.includes('subnet')) &&
          (targetNode.resourceType === 'aws_subnet' || targetNode.resourceType === 'azure_subnet')
        ) {
          n.groupId = targetId;
          return;
        }

        // Gateways / SGs attached to VPC
        if (
          (n.resourceType === 'aws_igw' || n.resourceType === 'aws_sg' || n.resourceType === 'azure_nsg') &&
          (targetNode.resourceType === 'aws_vpc' || targetNode.resourceType === 'azure_vnet')
        ) {
          n.groupId = targetId;
          return;
        }

        // Structural reference attributes that shouldn't produce visual connection lines
        if (
          key === 'vpc_id' ||
          key === 'subnet_id' ||
          key === 'subnets' ||
          key === 'security_groups' ||
          key === 'vpc_security_group_ids'
        ) {
          return;
        }

        edges.push({
          id: `edge-${targetId}-${n.id}`,
          source: targetId,
          target: n.id,
          edgeType: 'network',
        });
      }
    });
  });

  // Assign subnets without explicit VPC to primary VPC
  if (vpcNodes.length > 0) {
    subnetNodes.forEach((s) => {
      if (!s.groupId) s.groupId = vpcNodes[0].id;
    });
  }

  // Synthesize standard network flow edges if none exist
  const albNode = nodes.find((n) => n.resourceType === 'aws_alb' || n.resourceType === 'azure_app_gateway');
  const ec2Node = nodes.find((n) => n.resourceType === 'aws_ec2' || n.resourceType === 'azure_vm' || n.resourceType === 'aws_auto_scaling');
  const rdsNode = nodes.find((n) => n.resourceType === 'aws_rds' || n.resourceType === 'azure_sql' || n.resourceType === 'aws_docdb');
  const s3Node = nodes.find((n) => n.resourceType === 'aws_s3' || n.resourceType === 'azure_storage');
  const igwNode = nodes.find((n) => n.resourceType === 'aws_igw' || n.resourceType === 'azure_public_ip');

  const hasEdge = (src: string, tgt: string) => edges.some((e) => e.source === src && e.target === tgt);

  if (igwNode && albNode && !hasEdge(igwNode.id, albNode.id)) {
    edges.push({ id: `edge-${igwNode.id}-${albNode.id}`, source: igwNode.id, target: albNode.id, edgeType: 'network', label: 'Ingress' });
  }
  if (albNode && ec2Node && !hasEdge(albNode.id, ec2Node.id)) {
    edges.push({ id: `edge-${albNode.id}-${ec2Node.id}`, source: albNode.id, target: ec2Node.id, edgeType: 'network', label: 'HTTP/HTTPS' });
  }
  if (ec2Node && rdsNode && !hasEdge(ec2Node.id, rdsNode.id)) {
    edges.push({ id: `edge-${ec2Node.id}-${rdsNode.id}`, source: ec2Node.id, target: rdsNode.id, edgeType: 'data', label: 'Database' });
  }
  if (ec2Node && s3Node && !hasEdge(ec2Node.id, s3Node.id)) {
    edges.push({ id: `edge-${ec2Node.id}-${s3Node.id}`, source: ec2Node.id, target: s3Node.id, edgeType: 'data', label: 'S3 API' });
  }

  const { nodes: laidOutNodes, edges: laidOutEdges } = layoutImportedArchitecture(nodes, edges);

  return {
    ok: true,
    filename,
    format: 'terraform-hcl',
    formatLabel: 'Terraform Configuration (HCL)',
    provider: detectedProvider,
    projectName: `Imported — ${filename.replace(/\.[^/.]+$/, '')}`,
    nodes: laidOutNodes,
    edges: laidOutEdges,
    summary: {
      totalResources: laidOutNodes.length,
      totalConnections: laidOutEdges.length,
      resourceBreakdown: breakdown,
    },
  };
}

/** Parse Terraform State JSON */
function parseTerraformStateJson(data: Record<string, unknown>, filename: string): FileImportParsedResult {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const breakdown: Record<string, number> = {};
  const idToNodeId = new Map<string, string>();

  // Support both standard terraform.tfstate (resources array) and `terraform show -json` (values.root_module.resources)
  let rawResources: Array<Record<string, unknown>> = [];
  if (Array.isArray(data['resources'])) {
    rawResources = data['resources'] as Array<Record<string, unknown>>;
  } else if (
    data['values'] &&
    typeof data['values'] === 'object' &&
    (data['values'] as Record<string, unknown>)['root_module'] &&
    Array.isArray(((data['values'] as Record<string, unknown>)['root_module'] as Record<string, unknown>)['resources'])
  ) {
    rawResources = ((data['values'] as Record<string, unknown>)['root_module'] as Record<string, unknown>)['resources'] as Array<Record<string, unknown>>;
  }

  let count = 0;
  let detectedProvider: CloudProvider = 'aws';

  rawResources.forEach((res) => {
    const mode = (res['mode'] as string) || 'managed';
    if (mode === 'data') return; // Skip data sources for primary canvas

    const tfType = (res['type'] as string) || '';
    const tfName = (res['name'] as string) || `res-${count}`;
    if (!tfType) return;

    const { type: cbType, provider } = mapTerraformTypeToCloudBuilder(tfType);
    if (provider === 'azure') detectedProvider = 'azure';

    const instances = Array.isArray(res['instances']) ? (res['instances'] as Array<Record<string, unknown>>) : [res];

    instances.forEach((inst, instIdx) => {
      count++;
      const attrs = (inst['attributes'] as Record<string, unknown>) || (inst['values'] as Record<string, unknown>) || {};
      const cloudId = (attrs['id'] as string) || (attrs['arn'] as string) || `${tfType}.${tfName}.${instIdx}`;
      const nodeId = `tfstate-${count}-${tfName}`;
      idToNodeId.set(cloudId, nodeId);
      idToNodeId.set(`${tfType}.${tfName}`, nodeId);

      const tags = (attrs['tags'] && typeof attrs['tags'] === 'object') ? (attrs['tags'] as Record<string, unknown>) : null;
      const tagName = tags && typeof tags['Name'] === 'string' ? tags['Name'] : undefined;
      const label = tagName || (typeof attrs['name'] === 'string' ? attrs['name'] : undefined) || tfName;

      const isContainer = cbType === 'aws_vpc' || cbType === 'aws_subnet' || cbType === 'azure_vnet' || cbType === 'azure_resource_group';

      nodes.push({
        id: nodeId,
        type: isContainer ? 'containerNode' : 'cloudNode',
        resourceType: cbType,
        provider,
        label,
        position: { x: 0, y: 0 },
        config: {
          ...attrs,
          imported: true,
          importState: 'imported',
          importSource: 'terraform-state',
          cloudId,
        },
        importState: 'imported',
        width: isContainer ? 420 : undefined,
        height: isContainer ? 320 : undefined,
      });

      breakdown[cbType] = (breakdown[cbType] || 0) + 1;
    });
  });

  if (nodes.length === 0) {
    return {
      ok: false,
      filename,
      format: 'terraform-state',
      formatLabel: 'Terraform State (.tfstate)',
      provider: 'aws',
      projectName: filename,
      nodes: [],
      edges: [],
      summary: { totalResources: 0, totalConnections: 0, resourceBreakdown: {} },
      error: 'No managed resources found inside this Terraform state file.',
    };
  }

  // Cross-reference IDs to build containment and edges
  const vpcNodes = nodes.filter((n) => n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet');
  const subnetNodes = nodes.filter((n) => n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet');

  nodes.forEach((n) => {
    Object.entries(n.config).forEach(([key, val]) => {
      if (typeof val === 'string') {
        const targetId = idToNodeId.get(val);
        if (targetId && targetId !== n.id) {
          const targetNode = nodes.find((tn) => tn.id === targetId);
          if (!targetNode) return;

          // Subnet in VPC
          if (
            (n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet') &&
            (targetNode.resourceType === 'aws_vpc' || targetNode.resourceType === 'azure_vnet')
          ) {
            n.groupId = targetId;
            return;
          }

          // Compute / ALB / DB / leaf in Subnet
          if (
            (key === 'subnet_id' || key === 'subnets' || key.includes('subnet')) &&
            (targetNode.resourceType === 'aws_subnet' || targetNode.resourceType === 'azure_subnet')
          ) {
            n.groupId = targetId;
            return;
          }

          // Gateways / SGs attached to VPC
          if (
            (n.resourceType === 'aws_igw' || n.resourceType === 'aws_sg' || n.resourceType === 'azure_nsg') &&
            (targetNode.resourceType === 'aws_vpc' || targetNode.resourceType === 'azure_vnet')
          ) {
            n.groupId = targetId;
            return;
          }

          if (key === 'vpc_id' || key === 'subnet_id' || key === 'subnets' || key === 'security_groups') {
            return;
          }

          edges.push({
            id: `edge-${targetId}-${n.id}`,
            source: targetId,
            target: n.id,
            edgeType: 'network',
          });
        }
      }
    });
  });

  if (vpcNodes.length > 0) {
    subnetNodes.forEach((s) => {
      if (!s.groupId) s.groupId = vpcNodes[0].id;
    });
  }

  const albNode = nodes.find((n) => n.resourceType === 'aws_alb' || n.resourceType === 'azure_app_gateway');
  const ec2Node = nodes.find((n) => n.resourceType === 'aws_ec2' || n.resourceType === 'azure_vm' || n.resourceType === 'aws_auto_scaling');
  const rdsNode = nodes.find((n) => n.resourceType === 'aws_rds' || n.resourceType === 'azure_sql' || n.resourceType === 'aws_docdb');
  const s3Node = nodes.find((n) => n.resourceType === 'aws_s3' || n.resourceType === 'azure_storage');
  const igwNode = nodes.find((n) => n.resourceType === 'aws_igw' || n.resourceType === 'azure_public_ip');

  const hasEdge = (src: string, tgt: string) => edges.some((e) => e.source === src && e.target === tgt);
  if (igwNode && albNode && !hasEdge(igwNode.id, albNode.id)) {
    edges.push({ id: `edge-${igwNode.id}-${albNode.id}`, source: igwNode.id, target: albNode.id, edgeType: 'network', label: 'Ingress' });
  }
  if (albNode && ec2Node && !hasEdge(albNode.id, ec2Node.id)) {
    edges.push({ id: `edge-${albNode.id}-${ec2Node.id}`, source: albNode.id, target: ec2Node.id, edgeType: 'network', label: 'HTTP/HTTPS' });
  }
  if (ec2Node && rdsNode && !hasEdge(ec2Node.id, rdsNode.id)) {
    edges.push({ id: `edge-${ec2Node.id}-${rdsNode.id}`, source: ec2Node.id, target: rdsNode.id, edgeType: 'data', label: 'Database' });
  }
  if (ec2Node && s3Node && !hasEdge(ec2Node.id, s3Node.id)) {
    edges.push({ id: `edge-${ec2Node.id}-${s3Node.id}`, source: ec2Node.id, target: s3Node.id, edgeType: 'data', label: 'S3 API' });
  }

  const { nodes: laidOutNodes, edges: laidOutEdges } = layoutImportedArchitecture(nodes, edges);

  return {
    ok: true,
    filename,
    format: 'terraform-state',
    formatLabel: 'Terraform State JSON',
    provider: detectedProvider,
    projectName: `Imported State — ${filename.replace(/\.[^/.]+$/, '')}`,
    nodes: laidOutNodes,
    edges: laidOutEdges,
    summary: {
      totalResources: laidOutNodes.length,
      totalConnections: laidOutEdges.length,
      resourceBreakdown: breakdown,
    },
  };
}

function mapServiceToResourceType(service: string): { resourceType: string; provider: 'aws' | 'azure' } {
  const s = service.toLowerCase().trim();
  if (s.includes('s3')) return { resourceType: 'aws_s3', provider: 'aws' };
  if (s.includes('load_balancing') || s.includes('alb') || s.includes('elb')) return { resourceType: 'aws_alb', provider: 'aws' };
  if (s.includes('internet_gateway') || s.includes('igw')) return { resourceType: 'aws_igw', provider: 'aws' };
  if (s.includes('nat_gateway') || s.includes('nat')) return { resourceType: 'aws_nat', provider: 'aws' };
  if (s.includes('elastic_block_store') || s.includes('ebs')) return { resourceType: 'aws_ebs', provider: 'aws' };
  if (s.includes('ec2') || s.includes('instance')) return { resourceType: 'aws_ec2', provider: 'aws' };
  if (s.includes('rds') || s.includes('database')) return { resourceType: 'aws_rds', provider: 'aws' };
  if (s.includes('bedrock')) return { resourceType: 'aws_bedrock', provider: 'aws' };
  if (s.includes('secrets')) return { resourceType: 'aws_secretsmanager', provider: 'aws' };
  if (s.includes('key_management') || s.includes('kms')) return { resourceType: 'aws_kms', provider: 'aws' };
  if (s.includes('iam') || s.includes('identity')) return { resourceType: 'aws_iam_role', provider: 'aws' };
  if (s.includes('guardduty') || s.includes('guard')) return { resourceType: 'aws_guardduty', provider: 'aws' };
  if (s.includes('security_hub')) return { resourceType: 'aws_security_hub', provider: 'aws' };
  if (s.includes('cloudwatch')) return { resourceType: 'aws_cloudwatch', provider: 'aws' };
  if (s.includes('sns')) return { resourceType: 'aws_sns', provider: 'aws' };
  if (s.includes('config')) return { resourceType: 'aws_config', provider: 'aws' };
  if (s.includes('cloudtrail')) return { resourceType: 'aws_cloudtrail', provider: 'aws' };
  if (s.includes('bigrock') || s.includes('cdn')) return { resourceType: 'aws_cloudfront', provider: 'aws' };
  if (s.includes('cloudflare') || s.includes('waf')) return { resourceType: 'aws_waf', provider: 'aws' };
  if (s.includes('user') || s.includes('client')) return { resourceType: 'aws_internet', provider: 'aws' };
  return { resourceType: 'aws_ec2', provider: 'aws' };
}

/** Parse CloudBuilder Canvas / Template / Project JSON */
function parseCloudBuilderJson(data: Record<string, unknown>, filename: string): FileImportParsedResult {
  let rawNodes: unknown[] = [];
  let rawEdges: unknown[] = [];
  let projectName = (data['title'] as string) || (data['name'] as string) || (data['id'] as string) || filename.replace(/\.[^/.]+$/, '');
  let detectedProvider: CloudProvider = (data['provider'] as CloudProvider) || 'aws';
  let format: FileImportParsedResult['format'] = 'cloudbuilder-canvas';
  let formatLabel = 'CloudBuilder Canvas Export (v1)';

  if (data['format'] === 'cloudbuilder.architecture-template.v1') {
    format = 'architecture-template';
    formatLabel = 'CloudBuilder Architecture Template';
  }

  // Check where nodes/edges are located
  if (Array.isArray(data['nodes'])) {
    rawNodes = data['nodes'];
    rawEdges = Array.isArray(data['edges']) ? data['edges'] : [];
  } else if (
    data['environments'] &&
    typeof data['environments'] === 'object' &&
    (data['environments'] as Record<string, unknown>)['production'] &&
    Array.isArray(((data['environments'] as Record<string, unknown>)['production'] as Record<string, unknown>)['nodes'])
  ) {
    const prod = (data['environments'] as Record<string, unknown>)['production'] as Record<string, unknown>;
    rawNodes = prod['nodes'] as unknown[];
    rawEdges = Array.isArray(prod['edges']) ? (prod['edges'] as unknown[]) : [];
    formatLabel = 'CloudBuilder Complete Project Export';
  } else if (Array.isArray(data)) {
    rawNodes = data;
    rawEdges = [];
    format = 'raw-nodes';
    formatLabel = 'Raw Resource Nodes List';
  }

  if (rawNodes.length === 0 && !Array.isArray(data['groups'])) {
    return {
      ok: false,
      filename,
      format: 'unknown',
      formatLabel: 'Unknown JSON Format',
      provider: 'aws',
      projectName,
      nodes: [],
      edges: [],
      summary: { totalResources: 0, totalConnections: 0, resourceBreakdown: {} },
      error: 'The uploaded JSON file does not contain a recognizable "nodes" array or CloudBuilder architecture definition.',
    };
  }

  const breakdown: Record<string, number> = {};
  const sanitizedNodes: CanvasNode[] = [];

  interface ParsedGroup {
    id: string;
    label: string;
    resourceType: string;
    x: number;
    y: number;
    width: number;
    height: number;
    groupId?: string;
  }
  const rawGroups: ParsedGroup[] = [];

  // 1. Process custom groups/containers if present
  if (Array.isArray(data['groups'])) {
    data['groups'].forEach((g: any) => {
      if (!g || typeof g !== 'object') return;
      const gid = String(g.id || '');
      const glabel = String(g.label || gid);
      const pos = g.position || {};
      const gx = Number(pos.x ?? 0);
      const gy = Number(pos.y ?? 0);
      const gw = Number(pos.width ?? 420);
      const gh = Number(pos.height ?? 320);

      let rType = 'containerNode';
      const lower = (glabel + ' ' + gid).toLowerCase();
      if (lower.includes('vpc')) rType = 'aws_vpc';
      else if (lower.includes('subnet')) rType = 'aws_subnet';

      rawGroups.push({
        id: gid,
        label: glabel,
        resourceType: rType,
        x: gx,
        y: gy,
        width: gw,
        height: gh,
      });
    });

    // Detect nested groups (e.g. subnets inside VPC)
    for (const g1 of rawGroups) {
      let bestParent: ParsedGroup | null = null;
      let minParentArea = Infinity;
      for (const g2 of rawGroups) {
        if (g1.id === g2.id) continue;
        if (
          g1.x >= g2.x - 10 &&
          g1.x + g1.width <= g2.x + g2.width + 10 &&
          g1.y >= g2.y - 10 &&
          g1.y + g1.height <= g2.y + g2.height + 10
        ) {
          const area = g2.width * g2.height;
          if (area < minParentArea) {
            minParentArea = area;
            bestParent = g2;
          }
        }
      }
      if (bestParent) {
        g1.groupId = bestParent.id;
      }
    }

    // Add groups into sanitizedNodes
    for (const g of rawGroups) {
      sanitizedNodes.push({
        id: g.id,
        type: 'containerNode',
        resourceType: g.resourceType,
        provider: 'aws',
        label: g.label,
        position: { x: g.x, y: g.y },
        width: g.width,
        height: g.height,
        groupId: g.groupId,
        config: { name: g.label },
        importState: 'imported',
      });
      breakdown[g.resourceType] = (breakdown[g.resourceType] || 0) + 1;
    }
  }

  // 2. Process nodes
  rawNodes.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const nodeObj = item as Record<string, unknown>;

    let resourceType = (nodeObj['resourceType'] as string) || (nodeObj['type'] as string);
    if (!resourceType && typeof nodeObj['service'] === 'string') {
      const mapped = mapServiceToResourceType(nodeObj['service']);
      resourceType = mapped.resourceType;
    }
    if (!resourceType) resourceType = 'aws_ec2';

    const id = (nodeObj['id'] as string) || `node-${index + 1}`;
    const label = (nodeObj['label'] as string) || (nodeObj['name'] as string) || resourceType;
    const provider = (nodeObj['provider'] as CloudProvider) || (resourceType.startsWith('azure_') ? 'azure' : 'aws');
    if (provider === 'azure') detectedProvider = 'azure';

    const posObj = (nodeObj['position'] && typeof nodeObj['position'] === 'object') ? (nodeObj['position'] as Record<string, unknown>) : {};
    const pos = {
      x: typeof posObj['x'] === 'number' ? posObj['x'] : 0,
      y: typeof posObj['y'] === 'number' ? posObj['y'] : 0,
    };

    let assignedGroupId = (nodeObj['groupId'] as string) || undefined;
    if (!assignedGroupId && rawGroups.length > 0) {
      let bestEnclosing: ParsedGroup | null = null;
      let minEnclosingArea = Infinity;
      for (const g of rawGroups) {
        if (
          pos.x >= g.x - 20 &&
          pos.x <= g.x + g.width + 20 &&
          pos.y >= g.y - 20 &&
          pos.y <= g.y + g.height + 20
        ) {
          const area = g.width * g.height;
          if (area < minEnclosingArea) {
            minEnclosingArea = area;
            bestEnclosing = g;
          }
        }
      }
      if (bestEnclosing) {
        assignedGroupId = bestEnclosing.id;
      }
    }

    const isContainer = resourceType === 'aws_vpc' || resourceType === 'aws_subnet' || resourceType === 'azure_vnet' || resourceType === 'azure_resource_group' || nodeObj['type'] === 'containerNode';

    sanitizedNodes.push({
      id,
      type: isContainer ? 'containerNode' : ((nodeObj['type'] as string) || 'cloudNode'),
      resourceType,
      provider,
      label,
      position: pos,
      config: (nodeObj['config'] as Record<string, unknown>) || { description: nodeObj['description'] },
      importState: 'imported',
      groupId: assignedGroupId,
      width: (nodeObj['width'] as number) || (posObj['width'] as number) || (isContainer ? 420 : undefined),
      height: (nodeObj['height'] as number) || (posObj['height'] as number) || (isContainer ? 320 : undefined),
    });

    breakdown[resourceType] = (breakdown[resourceType] || 0) + 1;
  });

  // 3. Process edges with alias mapping and null filtering
  const sanitizedEdges: CanvasEdge[] = [];
  rawEdges.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const edgeObj = item as Record<string, unknown>;
    let source = (edgeObj['source'] as string) || '';
    let target = (edgeObj['target'] as string) || '';

    // Repair label aliases
    if (source === 'rdsp_lbl') source = 'rdsp';
    if (target === 'rdsp_lbl') target = 'rdsp';
    if (!source || !target || source === target) return;

    sanitizedEdges.push({
      id: (edgeObj['id'] as string) || `edge-${source}-${target}-${index}`,
      source,
      target,
      label: (edgeObj['label'] as string) || undefined,
      edgeType: (edgeObj['edgeType'] as string) || 'data',
    });
  });

  // For JSON imports with existing coordinates, preserve user layout exactly.
  // Shift by minimum offset if any node or container has negative coordinates.
  let minX = Infinity;
  let minY = Infinity;
  sanitizedNodes.forEach((n) => {
    if (typeof n.position.x === 'number') minX = Math.min(minX, n.position.x);
    if (typeof n.position.y === 'number') minY = Math.min(minY, n.position.y);
  });

  const offsetX = minX < 40 ? 60 - minX : 0;
  const offsetY = minY < 40 ? 60 - minY : 0;

  const normalizedNodes = (offsetX !== 0 || offsetY !== 0)
    ? sanitizedNodes.map((n) => ({
        ...n,
        position: {
          x: Math.round(n.position.x + offsetX),
          y: Math.round(n.position.y + offsetY),
        },
      }))
    : sanitizedNodes;

  return {
    ok: true,
    filename,
    format,
    formatLabel: 'CloudBuilder Complete Architecture',
    provider: detectedProvider,
    projectName,
    nodes: normalizedNodes,
    edges: sanitizedEdges,
    summary: {
      totalResources: normalizedNodes.length,
      totalConnections: sanitizedEdges.length,
      resourceBreakdown: breakdown,
    },
  };
}

/**
 * Primary entry point: parse any uploaded file (text or JSON)
 */
export function parseUploadedArchitectureFile(content: string, filename: string): FileImportParsedResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      ok: false,
      filename,
      format: 'unknown',
      formatLabel: 'Empty File',
      provider: 'aws',
      projectName: filename,
      nodes: [],
      edges: [],
      summary: { totalResources: 0, totalConnections: 0, resourceBreakdown: {} },
      error: 'The uploaded file is completely empty.',
    };
  }

  // Check if it's JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // Is it a Terraform state file?
      if (parsed['terraform_version'] || parsed['version'] === 4 || (parsed['values'] && (parsed['values'] as Record<string, unknown>)['root_module'])) {
        return parseTerraformStateJson(parsed, filename);
      }
      // Otherwise treat as CloudBuilder architecture format
      return parseCloudBuilderJson(parsed, filename);
    } catch (err) {
      // If it starts with { but failed JSON.parse, return JSON syntax error
      return {
        ok: false,
        filename,
        format: 'unknown',
        formatLabel: 'Malformed JSON',
        provider: 'aws',
        projectName: filename,
        nodes: [],
        edges: [],
        summary: { totalResources: 0, totalConnections: 0, resourceBreakdown: {} },
        error: `Invalid JSON syntax: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Check if it's Terraform HCL
  if (trimmed.includes('resource ') || filename.endsWith('.tf') || filename.endsWith('.hcl')) {
    return parseTerraformHcl(trimmed, filename);
  }

  return {
    ok: false,
    filename,
    format: 'unknown',
    formatLabel: 'Unsupported Format',
    provider: 'aws',
    projectName: filename,
    nodes: [],
    edges: [],
    summary: { totalResources: 0, totalConnections: 0, resourceBreakdown: {} },
    error: 'Unrecognized file format. Please upload a CloudBuilder Canvas JSON (.json), Terraform State (.tfstate), or Terraform Configuration (.tf) file.',
  };
}

/** Sample starter JSON for quick testing */
export const SAMPLE_CANVAS_JSON = JSON.stringify(
  {
    format: 'cloudbuilder.canvas.v1',
    name: 'Sample 3-Tier Web Architecture',
    provider: 'aws',
    nodes: [
      {
        id: 'vpc-1',
        type: 'containerNode',
        resourceType: 'aws_vpc',
        provider: 'aws',
        label: 'Production VPC (10.0.0.0/16)',
        position: { x: 80, y: 60 },
        width: 540,
        height: 380,
        config: { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true },
      },
      {
        id: 'alb-1',
        type: 'cloudNode',
        resourceType: 'aws_alb',
        provider: 'aws',
        label: 'Public Application Load Balancer',
        position: { x: 120, y: 120 },
        config: { scheme: 'internet-facing' },
      },
      {
        id: 'ec2-1',
        type: 'cloudNode',
        resourceType: 'aws_ec2',
        provider: 'aws',
        label: 'App Cluster (t3.medium)',
        position: { x: 120, y: 240 },
        config: { instanceType: 't3.medium' },
      },
      {
        id: 'rds-1',
        type: 'cloudNode',
        resourceType: 'aws_rds',
        provider: 'aws',
        label: 'PostgreSQL Multi-AZ Primary',
        position: { x: 340, y: 240 },
        config: { engine: 'postgres', multiAz: true, instanceClass: 'db.r6g.large' },
      },
    ],
    edges: [
      { id: 'edge-alb-ec2', source: 'alb-1', target: 'ec2-1', edgeType: 'network', label: 'HTTP/HTTPS 443' },
      { id: 'edge-ec2-rds', source: 'ec2-1', target: 'rds-1', edgeType: 'data', label: 'TCP 5432' },
    ],
  },
  null,
  2
);

/** Sample Terraform HCL for quick testing */
export const SAMPLE_TERRAFORM_HCL = `# AWS Production 3-Tier Architecture
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "Production VPC (10.0.0.0/16)"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true

  tags = {
    Name = "Public Subnet (10.0.1.0/24)"
  }
}

resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "us-east-1b"

  tags = {
    Name = "Private Subnet (10.0.2.0/24)"
  }
}

resource "aws_lb" "alb" {
  name               = "public-application-load-balancer"
  load_balancer_type = "application"
  subnets            = [aws_subnet.public.id]

  tags = {
    Name = "Public Application Load Balancer"
  }
}

resource "aws_instance" "app_server" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.medium"
  subnet_id     = aws_subnet.private.id

  tags = {
    Name = "App Cluster (t3.medium)"
  }
}

resource "aws_db_instance" "database" {
  identifier        = "primary-postgresql-db"
  engine            = "postgres"
  instance_class    = "db.r6g.large"
  allocated_storage = 50
  multi_az          = true

  tags = {
    Name = "PostgreSQL Multi-AZ Primary"
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = "company-production-assets"

  tags = {
    Name = "Static Assets S3 Bucket"
  }
}
`;


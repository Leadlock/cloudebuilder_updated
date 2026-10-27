/**
 * Terraform Warning Analyzer & Remediation Engine
 *
 * Converts raw Terraform warning messages into actionable, structured issues
 * with detailed problem analysis, manual configuration steps, 1-click auto-fix actions,
 * and pre-populated AI generator prompt configurations.
 */

import { CanvasNode, CanvasEdge, Project } from '@/types';

export type WarningSeverity = 'critical' | 'warning' | 'info';
export type WarningCategory = 'load_balancer' | 'networking' | 'iam' | 'security' | 'database' | 'boundary' | 'general';

export interface WarningRequiredInput {
  id: string;
  label: string;
  type: 'text' | 'select' | 'checkbox';
  defaultValue: string;
  options?: { label: string; value: string }[];
  description?: string;
  placeholder?: string;
}

export interface StructuredTerraformWarning {
  id: string;
  raw: string;
  title: string;
  severity: WarningSeverity;
  category: WarningCategory;
  affectedResource?: string;
  problem: string;
  impact: string;
  suggestedFix: string;
  manualSteps: string[];
  aiPrompt: string;
  aiInputs?: WarningRequiredInput[];
  canAutoFixManually: boolean;
  autoFixButtonLabel?: string;
  autoFixActionType?: 'add_second_public_subnet' | 'add_nat_gateway' | 'enable_public_ip' | 'dismiss_boundary' | 'fix_unsupported_resource';
}

/**
 * Parses raw warning strings produced by TerraformGenerator into structured, actionable items.
 */
export function analyzeTerraformWarnings(
  warnings: string[],
  nodes: CanvasNode[] = [],
  edges: CanvasEdge[] = []
): StructuredTerraformWarning[] {
  const structured: StructuredTerraformWarning[] = [];

  for (let i = 0; i < warnings.length; i++) {
    const raw = warnings[i];
    if (!raw) continue;

    // 1. Skip visual boundary containers and canvas grouping boxes (handled automatically)
    if (
      raw.includes('aws_cloud_boundary') ||
      raw.includes('azure_cloud_boundary') ||
      raw.includes('cloud_boundary') ||
      raw.includes('containerNode') ||
      raw.includes('cloudProviderNode') ||
      (raw.includes('invalid_resource_type') &&
        (raw.includes('Edge') ||
         raw.includes('Global') ||
         raw.includes('Logging') ||
         raw.includes('Region') ||
         raw.includes('Storage') ||
         raw.includes('Governance') ||
         raw.includes('Observability') ||
         raw.includes('Security')))
    ) {
      continue;
    }

    // 2. Load Balancer Internet-Facing Multi-AZ Subnet Warning
    if (raw.includes('is internet-facing but only one public subnet exists') || raw.includes('needs subnets in at least two different Availability Zones')) {
      const albMatch = raw.match(/Load balancer "(.*?)"/i) || raw.match(/load balancer "(.*?)"/i);
      const albName = albMatch ? albMatch[1] : 'Application Load Balancer';

      // Find VPC and existing subnets to calculate smart defaults
      const subnets = nodes.filter((n) => n.resourceType === 'aws_subnet');
      const usedCidrs = subnets.map((s) => (s.config?.cidrBlock as string) || '').filter(Boolean);
      const defaultCidr = findNextSubnetCidr(usedCidrs, '10.0.2.0/24');

      structured.push({
        id: `warn-alb-multiaz-${i}`,
        raw,
        title: 'Internet-Facing Load Balancer Requires 2+ Public Subnets in Different AZs',
        severity: 'warning',
        category: 'load_balancer',
        affectedResource: albName,
        problem: `AWS Application Load Balancers must be provisioned across at least two Availability Zones for high availability. Only one public subnet was detected, so a private subnet was used as fallback, which will cause external internet traffic routing failures.`,
        impact: 'AWS will reject traffic routed through private subnets or drop external requests reaching the secondary Availability Zone.',
        suggestedFix: 'Provision a second public subnet in a distinct Availability Zone (e.g. us-east-1b) with an internet gateway route, and attach it to the load balancer.',
        manualSteps: [
          'Add a new AWS Subnet resource to your VPC on the canvas.',
          'Set its CIDR Block to a non-overlapping range (e.g. 10.0.2.0/24).',
          'Configure its Availability Zone to a different zone (e.g. us-east-1b).',
          'Set "Map Public IP on Launch" to true so it functions as a public subnet.',
          'Connect the new subnet to the Application Load Balancer.'
        ],
        aiPrompt: `Add a second public subnet in Availability Zone us-east-1b (CIDR ${defaultCidr}) to the VPC with MapPublicIpOnLaunch enabled, and attach it to "${albName}" to ensure multi-AZ load balancing compliance.`,
        aiInputs: [
          {
            id: 'subnetCidr',
            label: 'Subnet CIDR Block',
            type: 'text',
            defaultValue: defaultCidr,
            description: 'Non-overlapping IPv4 CIDR range inside your VPC.'
          },
          {
            id: 'availabilityZone',
            label: 'Availability Zone',
            type: 'select',
            defaultValue: 'us-east-1b',
            options: [
              { label: 'us-east-1b (Recommended)', value: 'us-east-1b' },
              { label: 'us-east-1c', value: 'us-east-1c' },
              { label: 'us-east-1d', value: 'us-east-1d' },
            ],
            description: 'Must differ from the primary public subnet zone (us-east-1a).'
          },
          {
            id: 'subnetName',
            label: 'Subnet Label',
            type: 'text',
            defaultValue: 'Public Web Subnet (AZ-B)',
            description: 'Display name for the new public subnet.'
          }
        ],
        canAutoFixManually: true,
        autoFixButtonLabel: 'Add 2nd Public Subnet (AZ-B)',
        autoFixActionType: 'add_second_public_subnet',
      });
      continue;
    }

    // 3. Private Subnet Outbound Internet / NAT Gateway Warning
    if (raw.includes('have no route to the internet (no NAT Gateway)') || raw.includes('cannot pull their container image')) {
      const vpcMatch = raw.match(/private subnets of "(.*?)"/i);
      const vpcName = vpcMatch ? vpcMatch[1] : 'Production VPC';

      structured.push({
        id: `warn-nat-gateway-${i}`,
        raw,
        title: 'Private Subnet Services Missing Outbound Internet Route (NAT Gateway)',
        severity: 'critical',
        category: 'networking',
        affectedResource: vpcName,
        problem: `Container services (ECS Fargate / EKS / EC2) in private subnets cannot reach external endpoints to pull container images from ECR/Docker Hub, download security patches, or stream logs to CloudWatch without an outbound egress route.`,
        impact: 'Tasks and containers will fail to start and enter a crash-loop (ImagePullBackOff / CannotPullContainerError).',
        suggestedFix: 'Place an AWS NAT Gateway in a public subnet with an Elastic IP, and route outbound internet traffic (0.0.0.0/0) from private subnets through this gateway.',
        manualSteps: [
          'Add an AWS NAT Gateway (aws_nat) component to your canvas inside the public subnet.',
          'Connect the NAT Gateway to the Internet Gateway / VPC.',
          'Ensure private route tables direct 0.0.0.0/0 to the NAT Gateway id.',
          'Alternatively, if tasks only need internal access, enable AWS VPC Interface Endpoints for ECR, S3, and CloudWatch Logs.'
        ],
        aiPrompt: `Add an AWS NAT Gateway in the public subnet of "${vpcName}" with an Elastic IP, and configure outbound routing for private subnets so ECS and worker tasks can download container images and send logs.`,
        aiInputs: [
          {
            id: 'natName',
            label: 'NAT Gateway Name',
            type: 'text',
            defaultValue: 'Production NAT Gateway',
            description: 'Identifier for the managed NAT Gateway.'
          },
          {
            id: 'allocateEip',
            label: 'Allocate Elastic IP (EIP)',
            type: 'checkbox',
            defaultValue: 'true',
            description: 'AWS requires an Elastic IP for public internet-facing NAT Gateways.'
          }
        ],
        canAutoFixManually: true,
        autoFixButtonLabel: 'Add NAT Gateway to Public Subnet',
        autoFixActionType: 'add_nat_gateway',
      });
      continue;
    }

    // 4. Default VPC Fallback Warning
    if (raw.includes('is not inside or connected to a VPC, so it will be created in your AWS account\'s default VPC')) {
      const resMatch = raw.match(/^"(.*?)"/);
      const resName = resMatch ? resMatch[1] : 'Resource';

      structured.push({
        id: `warn-default-vpc-${i}`,
        raw,
        title: `"${resName}" Placed in Account Default VPC`,
        severity: 'warning',
        category: 'networking',
        affectedResource: resName,
        problem: `The resource is not nested inside or connected to any custom VPC on the canvas, so Terraform will create it in AWS default VPC.`,
        impact: 'The resource will not be isolated within your architecture\'s private network perimeter and security groups.',
        suggestedFix: `Move "${resName}" inside a VPC or subnet container on the canvas, or draw a connection line between them.`,
        manualSteps: [
          `Drag and drop "${resName}" inside the appropriate VPC or Subnet box on the canvas.`,
          `Verify that its security group references the VPC security group.`
        ],
        aiPrompt: `Move "${resName}" inside the VPC and connect it to the corresponding application subnet.`,
        canAutoFixManually: false,
      });
      continue;
    }

    // 5. HTTPS Listener Missing ACM Certificate
    if (raw.includes('listener but no certificate') || raw.includes('ACM Certificate ARN')) {
      const albMatch = raw.match(/load balancer "(.*?)"/i);
      const albName = albMatch ? albMatch[1] : 'Application Load Balancer';

      structured.push({
        id: `warn-acm-cert-${i}`,
        raw,
        title: 'HTTPS Listener Missing ACM Certificate ARN',
        severity: 'critical',
        category: 'security',
        affectedResource: albName,
        problem: 'AWS rejects HTTPS or TLS listeners unless an SSL/TLS certificate ARN from AWS Certificate Manager (ACM) or IAM is specified.',
        impact: 'Terraform plan/apply will fail when creating the aws_lb_listener resource with error "CertificateNotFound".',
        suggestedFix: 'Enter an ACM Certificate ARN in the Load Balancer properties or switch listener protocol to HTTP for testing.',
        manualSteps: [
          'Select the Load Balancer on the canvas.',
          'In the right Properties Panel, locate the "ACM Certificate ARN" field.',
          'Paste your valid certificate ARN (arn:aws:acm:...) or switch protocol to HTTP.'
        ],
        aiPrompt: `Configure an AWS ACM Certificate resource or provide a certificate ARN for the HTTPS listener on "${albName}".`,
        canAutoFixManually: false,
      });
      continue;
    }

    // 6. Generic or unsupported resource warning
    const typeMatch = raw.match(/Unsupported (?:AWS|Azure) resource type: (.*?) \(resource: (.*?)\)/i);
    if (typeMatch) {
      const type = typeMatch[1];
      const name = typeMatch[2];
      const isContainerOrGroup =
        type === 'invalid_resource_type' ||
        type === 'containerNode' ||
        name.toLowerCase().includes('edge') ||
        name.toLowerCase().includes('logging') ||
        name.toLowerCase().includes('region') ||
        name.toLowerCase().includes('storage') ||
        name.toLowerCase().includes('governance') ||
        name.toLowerCase().includes('observability');

      let suggestedReplacement = 'aws_cloudwatch_log_group';
      if (type.includes('secret') || name.toLowerCase().includes('secret')) suggestedReplacement = 'aws_secretsmanager';
      else if (type.includes('guard') || name.toLowerCase().includes('guard')) suggestedReplacement = 'aws_guardduty_detector';
      else if (type.includes('security') || name.toLowerCase().includes('security')) suggestedReplacement = 'aws_security_hub_account';
      else if (type.includes('bedrock') || name.toLowerCase().includes('bedrock')) suggestedReplacement = 'aws_bedrock_custom_model';
      else if (type.includes('config') || name.toLowerCase().includes('config')) suggestedReplacement = 'aws_cloudwatch_log_group';

      structured.push({
        id: `warn-unsupported-${i}`,
        raw,
        title: `Unsupported Resource Type: ${type}`,
        severity: 'warning',
        category: 'general',
        affectedResource: name,
        problem: isContainerOrGroup
          ? `"${name}" is a canvas container or boundary group that was evaluated as an infrastructure resource.`
          : `The resource "${name}" has type "${type}" which needs to be remediated to a supported Terraform resource.`,
        impact: isContainerOrGroup
          ? 'Generates clutter warnings; container boundaries should be visual-only.'
          : 'This resource will be skipped during Terraform provisioning.',
        suggestedFix: isContainerOrGroup
          ? `Convert "${name}" into a visual container boundary so it is excluded from Terraform resource blocks.`
          : `Remediate "${name}" to a supported native resource (${suggestedReplacement}) or remove it.`,
        manualSteps: isContainerOrGroup
          ? [
              `Mark "${name}" as a visual container in node properties.`,
              'Or exclude it from backend resource provisioning.'
            ]
          : [
              `Select "${name}" on canvas and update its service type to a supported AWS resource (e.g. ${suggestedReplacement}).`,
              'Verify required properties in the right inspector.'
            ],
        aiPrompt: isContainerOrGroup
          ? `Convert visual container box "${name}" into a canvas-only boundary container and exclude it from Terraform resource generation.`
          : `Remediate unsupported resource "${name}" (${type}) to supported AWS Terraform resource "${suggestedReplacement}" with production configurations.`,
        aiInputs: [
          {
            id: 'targetAction',
            label: 'Remediation Action',
            type: 'select',
            defaultValue: isContainerOrGroup ? 'mark_container' : 'map_supported',
            options: isContainerOrGroup
              ? [
                  { label: 'Convert to Visual Container (Exclude from Terraform)', value: 'mark_container' },
                  { label: 'Remove Node from Canvas', value: 'remove_node' },
                ]
              : [
                  { label: `Remediate to Supported Resource (${suggestedReplacement})`, value: 'map_supported' },
                  { label: 'Remove Node from Canvas', value: 'remove_node' },
                ],
            description: 'Choose how the AI should remediate this resource.'
          },
          ...(!isContainerOrGroup ? [{
            id: 'replacementType',
            label: 'Target Resource Type',
            type: 'text' as const,
            defaultValue: suggestedReplacement,
            description: 'The supported AWS Terraform resource type to map to.'
          }] : [])
        ],
        canAutoFixManually: true,
        autoFixButtonLabel: isContainerOrGroup ? 'Convert to Visual Container' : `Remediate to ${suggestedReplacement}`,
        autoFixActionType: 'fix_unsupported_resource',
      });
      continue;
    }

    // Default fallback
    structured.push({
      id: `warn-generic-${i}`,
      raw,
      title: 'Architecture Deployment Advisory',
      severity: 'warning',
      category: 'general',
      problem: raw,
      impact: 'May cause infrastructure provisioning anomalies or non-standard deployments.',
      suggestedFix: 'Review the architecture configuration to ensure alignment with cloud provider requirements.',
      manualSteps: ['Inspect connected resources and configurations on the canvas.'],
      aiPrompt: `Fix the following Terraform architecture advisory: ${raw}`,
      canAutoFixManually: false,
    });
  }

  return structured;
}

/**
 * Calculates the next non-overlapping /24 subnet CIDR given existing CIDRs.
 */
function findNextSubnetCidr(existingCidrs: string[], fallback = '10.0.2.0/24'): string {
  if (existingCidrs.length === 0) return fallback;
  const usedThirdOctets = new Set<number>();

  for (const c of existingCidrs) {
    const match = c.match(/^10\.0\.(\d+)\./);
    if (match) {
      usedThirdOctets.add(parseInt(match[1]!, 10));
    }
  }

  for (let i = 1; i < 254; i++) {
    if (!usedThirdOctets.has(i)) {
      return `10.0.${i}.0/24`;
    }
  }

  return fallback;
}

/**
 * Automatically applies a manual fix directly to the project's nodes and edges on the canvas.
 */
export function applyManualFixToProject(
  warning: StructuredTerraformWarning,
  project: Project,
  customInputs?: Record<string, string>
): { updatedProject: Project; message: string } {
  const nodes = [...project.nodes];
  const edges = [...project.edges];

  // Action 1: Add a second public subnet in Availability Zone B
  if (warning.autoFixActionType === 'add_second_public_subnet') {
    // 1. Locate VPC
    const vpcNode = nodes.find((n) => n.resourceType === 'aws_vpc');
    const existingSubnets = nodes.filter((n) => n.resourceType === 'aws_subnet');
    const albNode = nodes.find((n) => n.resourceType === 'aws_alb');

    const cidr = customInputs?.subnetCidr || findNextSubnetCidr(existingSubnets.map((s) => (s.config?.cidrBlock as string) || ''));
    const az = customInputs?.availabilityZone || 'us-east-1b';
    const label = customInputs?.subnetName || `Public Web Subnet (${az.slice(-2).toUpperCase()})`;

    const newSubnetId = `subnet-public-az2-${Date.now()}`;
    const refPos = vpcNode ? { x: vpcNode.position.x + 40, y: vpcNode.position.y + 180 } : { x: 300, y: 300 };

    const newSubnetNode: CanvasNode = {
      id: newSubnetId,
      type: 'containerNode',
      resourceType: 'aws_subnet',
      provider: 'aws',
      label,
      position: { x: refPos.x + 360, y: refPos.y },
      width: 320,
      height: 200,
      groupId: vpcNode?.id,
      config: {
        cidrBlock: cidr,
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        vpcId: vpcNode?.id,
      },
    };

    nodes.push(newSubnetNode);

    // If ALB exists, connect the new public subnet to it
    if (albNode) {
      edges.push({
        id: `edge-alb-subnet2-${Date.now()}`,
        source: albNode.id,
        target: newSubnetId,
        relationshipType: 'LOAD_BALANCES',
        edgeType: 'network',
        label: `Multi-AZ (${az})`,
      });
    }

    return {
      updatedProject: {
        ...project,
        nodes,
        edges,
        updatedAt: new Date().toISOString(),
      },
      message: `✓ Successfully added second public subnet "${label}" in ${az} with CIDR ${cidr} and linked to Load Balancer!`,
    };
  }

  // Action 2: Add NAT Gateway to Public Subnet
  if (warning.autoFixActionType === 'add_nat_gateway') {
    const publicSubnet = nodes.find(
      (n) => n.resourceType === 'aws_subnet' &&
      ((n.config?.mapPublicIpOnLaunch === true) || n.label.toLowerCase().includes('pub'))
    );
    const vpcNode = nodes.find((n) => n.resourceType === 'aws_vpc');

    const natId = `nat-gw-${Date.now()}`;
    const natLabel = customInputs?.natName || 'Production NAT Gateway';
    const pos = publicSubnet
      ? { x: publicSubnet.position.x + 40, y: publicSubnet.position.y + 60 }
      : { x: 400, y: 250 };

    const natNode: CanvasNode = {
      id: natId,
      type: 'cloudNode',
      resourceType: 'aws_nat',
      provider: 'aws',
      label: natLabel,
      position: pos,
      groupId: publicSubnet?.id || vpcNode?.id,
      config: {
        connectivityType: 'public',
        allocateElasticIp: true,
        subnetId: publicSubnet?.id,
      },
    };

    nodes.push(natNode);

    // Connect NAT Gateway to public subnet
    if (publicSubnet) {
      edges.push({
        id: `edge-nat-subnet-${Date.now()}`,
        source: natId,
        target: publicSubnet.id,
        relationshipType: 'CONTAINS',
        edgeType: 'network',
        label: 'In Public Subnet',
      });
    }

    return {
      updatedProject: {
        ...project,
        nodes,
        edges,
        updatedAt: new Date().toISOString(),
      },
      message: `✓ Successfully added "${natLabel}" to public subnet with Elastic IP egress routing configured!`,
    };
  }

  // Action 3: Remediate unsupported or canvas container resource
  if (warning.autoFixActionType === 'fix_unsupported_resource' || warning.id.startsWith('warn-unsupported')) {
    const targetName = (warning.affectedResource || '').toLowerCase().trim();
    const nodeIndex = nodes.findIndex(
      (n) =>
        n.label.toLowerCase().trim() === targetName ||
        n.id.toLowerCase().trim() === targetName ||
        n.label.toLowerCase().includes(targetName)
    );

    if (nodeIndex !== -1) {
      const node = { ...nodes[nodeIndex] };
      const action = customInputs?.targetAction || 'map_supported';

      if (action === 'remove_node') {
        const removedId = node.id;
        const newNodes = nodes.filter((_, idx) => idx !== nodeIndex);
        const newEdges = edges.filter((e) => e.source !== removedId && e.target !== removedId);
        return {
          updatedProject: {
            ...project,
            nodes: newNodes,
            edges: newEdges,
            updatedAt: new Date().toISOString(),
          },
          message: `✓ Removed unsupported node "${node.label}" from canvas architecture.`,
        };
      }

      // Check if it's a visual boundary / container
      const isContainer =
        node.type === 'containerNode' ||
        node.resourceType === 'containerNode' ||
        node.resourceType === 'invalid_resource_type' ||
        node.id.endsWith('grp') ||
        node.id === 'dr' ||
        node.label.includes('Global') ||
        node.label.includes('Region') ||
        node.label.includes('Services') ||
        node.label.includes('Storage') ||
        node.label.includes('Governance') ||
        node.label.includes('Observability');

      if (isContainer || action === 'mark_container') {
        node.type = 'containerNode';
        node.resourceType = 'containerNode';
        (node as any).isContainer = true;
        nodes[nodeIndex] = node;
        return {
          updatedProject: {
            ...project,
            nodes,
            edges,
            updatedAt: new Date().toISOString(),
          },
          message: `✓ Converted "${node.label}" into a visual container boundary (excluded from Terraform provisioning).`,
        };
      }

      // Remediate to supported resource
      const targetType = customInputs?.replacementType ||
        (node.label.toLowerCase().includes('secret') ? 'aws_secretsmanager' :
         node.label.toLowerCase().includes('guard') ? 'aws_guardduty_detector' :
         node.label.toLowerCase().includes('security') ? 'aws_security_hub_account' :
         node.label.toLowerCase().includes('bedrock') ? 'aws_bedrock_custom_model' :
         'aws_cloudwatch_log_group');

      node.resourceType = targetType;
      if (targetType === 'aws_secretsmanager') {
        node.config = { ...node.config, name: node.label.toLowerCase().replace(/[^a-z0-9_-]/g, '-') };
      } else if (targetType === 'aws_guardduty_detector') {
        node.config = { ...node.config, enable: true };
      } else if (targetType === 'aws_security_hub_account') {
        node.config = { ...node.config, enableDefaultStandards: true };
      } else if (targetType === 'aws_bedrock_custom_model') {
        node.config = { ...node.config, name: 'my-bedrock-model' };
      } else if (targetType === 'aws_cloudwatch_log_group') {
        node.config = { ...node.config, name: `/aws/${node.label.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}` };
      }

      nodes[nodeIndex] = node;
      return {
        updatedProject: {
          ...project,
          nodes,
          edges,
          updatedAt: new Date().toISOString(),
        },
        message: `✓ Remediated "${node.label}" to supported Terraform type "${targetType}".`,
      };
    }
  }

  return {
    updatedProject: project,
    message: 'Manual instructions provided. Please adjust components as recommended.',
  };
}

/**
 * Remediates all actionable warnings in batch.
 */
export function fixAllWarnings(
  warnings: StructuredTerraformWarning[],
  project: Project
): { updatedProject: Project; fixedCount: number } {
  let curr = project;
  let fixedCount = 0;
  for (const w of warnings) {
    const { updatedProject } = applyManualFixToProject(w, curr);
    if (updatedProject !== curr) {
      curr = updatedProject;
      fixedCount++;
    }
  }
  return { updatedProject: curr, fixedCount };
}

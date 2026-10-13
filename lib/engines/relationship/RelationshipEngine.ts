/**
 * Relationship Rule Engine — Centralized Architecture Relationship Service
 *
 * Enforces technical validity of cloud connections across AWS, Azure, and Multi-Cloud.
 * Categorizes and validates edges according to real cloud networking and security principles.
 * Never creates arbitrary edges based on visual proximity.
 */

import { CanvasNode, CanvasEdge, RelationshipType, ConnectionValidationResult, NetworkScope } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { PRIVATE_LINK_TARGETS } from '@/lib/engines/assessment/privateAccess';

/**
 * SINGLE SOURCE OF TRUTH for whether a direct edge between two resources of
 * different cloud providers is architecturally supportable (i.e. representable
 * as a real VPN tunnel / interconnect / public HTTPS gateway, not raw private
 * network transport, which does not exist between AWS and Azure).
 *
 * This function is the only place cross-cloud connection legitimacy is decided.
 * Both the canvas connection-creation gate (RelationshipEngine.validateConnection,
 * below) and the post-hoc canonical architecture validator
 * (lib/domain/canonicalArchitecture.ts) call this exact function so they can
 * never disagree about whether the same edge is valid.
 */
const isEc2Like = (t: string) => t === 'aws_ec2' || t === 'aws_container_service';
const isAzureVmLike = (t: string) => t === 'azure_vm' || t === 'azure_container_service';

export function isCrossCloudConnectionSupported(sourceType: string, targetType: string): boolean {
  const sType = sourceType;
  const tType = targetType;

  const isComputeToCompute =
    (sType.includes('ec2') || sType.includes('vm') || sType.includes('lambda') || sType.includes('functions')) &&
    (tType.includes('ec2') || tType.includes('vm') || tType.includes('sql') || tType.includes('storage') || tType.includes('s3'));

  const isGatewayOrEdgeService =
    sType.includes('gateway') ||
    tType.includes('gateway') ||
    sType.includes('front_door') ||
    sType.includes('cloudfront') ||
    tType.includes('front_door') ||
    tType.includes('cloudfront');

  return isComputeToCompute || isGatewayOrEdgeService;
}

export interface RelationshipRule {
  id: string;
  sourceType: string | string[];
  targetType: string | string[];
  relationshipType: RelationshipType;
  allowed: boolean;
  defaultProtocol?: string;
  defaultPort?: string | number;
  networkScope?: NetworkScope;
  reason: string;
  invalidReason?: string;
  suggestedAlternatives?: string[];
}

export class RelationshipEngine {
  private static instance: RelationshipEngine;

  public static getInstance(): RelationshipEngine {
    if (!RelationshipEngine.instance) {
      RelationshipEngine.instance = new RelationshipEngine();
    }
    return RelationshipEngine.instance;
  }

  /**
   * Validates hierarchical containment between a child resource and a parent container.
   */
  public validateContainment(
    childType: string,
    parentType: string,
    childProvider?: string,
    parentProvider?: string
  ): { isAllowed: boolean; error?: { code: string; message: string; technicalReason?: string } } {
    const cProvider = childProvider || (childType.startsWith('azure_') ? 'azure' : 'aws');
    const pProvider = parentProvider || (parentType.startsWith('azure_') ? 'azure' : 'aws');

    // Cross-provider containment
    if (cProvider !== pProvider && cProvider !== 'multi' && pProvider !== 'multi') {
      return {
        isAllowed: false,
        error: {
          code: 'CROSS_PROVIDER_CONTAINMENT',
          message: `Cannot place ${cProvider.toUpperCase()} resource inside ${pProvider.toUpperCase()} container.`,
          technicalReason: 'Cloud fabrics are strictly isolated across different cloud providers.',
        },
      };
    }

    // Nested compute
    if (
      (isEc2Like(childType) || isAzureVmLike(childType)) &&
      (isEc2Like(parentType) || isAzureVmLike(parentType))
    ) {
      return {
        isAllowed: false,
        error: {
          code: 'NESTED_VIRTUAL_MACHINE',
          message: 'Virtual machine cannot be nested inside another virtual machine.',
          technicalReason: 'Virtual machines must be placed inside a Subnet.',
        },
      };
    }

    // Subnet inside subnet
    if (childType.includes('subnet') && parentType.includes('subnet')) {
      return {
        isAllowed: false,
        error: {
          code: 'NESTED_SUBNET',
          message: 'A subnet cannot be nested inside another subnet.',
          technicalReason: 'Subnets must reside directly within a VPC or Virtual Network.',
        },
      };
    }

    // Inverted network hierarchy (VPC inside subnet)
    if (
      (childType === 'aws_vpc' || childType === 'azure_vnet') &&
      parentType.includes('subnet')
    ) {
      return {
        isAllowed: false,
        error: {
          code: 'INVERTED_NETWORK_HIERARCHY',
          message: 'Network container cannot be placed inside a subnet.',
          technicalReason: 'VPC/VNet encapsulations must be at the root or inside a Cloud Boundary.',
        },
      };
    }

    // Compute directly in VPC/VNet/ResourceGroup
    if (
      (isEc2Like(childType) || isAzureVmLike(childType) || childType === 'aws_auto_scaling' || childType === 'azure_vmss') &&
      (parentType === 'aws_vpc' || parentType === 'azure_vnet' || parentType === 'azure_resource_group')
    ) {
      return {
        isAllowed: false,
        error: {
          code: 'COMPUTE_DIRECT_IN_VPC',
          message: 'Compute instances must be contained inside a Subnet, not placed directly in VPC/VNet.',
          technicalReason: 'Virtual machines require a subnet for network interface (ENI/NIC) and IP allocation.',
        },
      };
    }

    // Database directly in VPC/VNet/ResourceGroup
    if (
      (childType === 'aws_rds' || childType === 'azure_sql' || childType === 'aws_elasticache' || childType === 'azure_redis' || childType === 'azure_postgres' || childType === 'azure_mysql') &&
      (parentType === 'aws_vpc' || parentType === 'azure_vnet' || parentType === 'azure_resource_group')
    ) {
      return {
        isAllowed: false,
        error: {
          code: 'DATABASE_DIRECT_IN_VPC',
          message: 'Databases must reside in a dedicated Database Subnet.',
          technicalReason: 'Managed database services require explicit private subnet assignment for security isolation.',
        },
      };
    }

    return { isAllowed: true };
  }

  /**
   * Evaluates whether two nodes can form a valid architectural relationship.
   * If invalid, returns the architectural justification and actionable alternatives.
   */
  public validateConnection(
    sourceNode: CanvasNode,
    targetNode: CanvasNode,
    allNodes: CanvasNode[] = [],
    _allEdges: CanvasEdge[] = []
  ): ConnectionValidationResult {
    // A Container App calls and is called like an App Service as far as these connection rules go.
    const asAppService = (t: string) => (t === 'azure_container_apps' ? 'azure_app_service' : t);
    const sType = asAppService(sourceNode.resourceType);
    const tType = asAppService(targetNode.resourceType);
    const sProvider = sourceNode.provider ?? (sType.startsWith('azure_') ? 'azure' : 'aws');
    const tProvider = targetNode.provider ?? (tType.startsWith('azure_') ? 'azure' : 'aws');

    const sDef = getResourceDefinition(sType);
    const tDef = getResourceDefinition(tType);

    // Rule 0: Disallow connecting to oneself
    if (sourceNode.id === targetNode.id) {
      return {
        isValid: false,
        relationshipType: 'LOGICAL_DEPENDENCY',
        networkScope: 'internal',
        error: {
          code: 'SELF_CONNECTION',
          message: 'Cannot connect a resource to itself.',
          technicalReason: 'A cloud resource cannot establish an external network loop with itself.',
          suggestedAlternatives: ['Connect to a separate downstream workload or target service.'],
        },
      };
    }

    // Rule 1: Containers should NOT have drawn network edges to their own contained children
    // (Containment is represented visually and via groupId, not as network traffic)
    if (sDef?.isContainer || tDef?.isContainer) {
      // Check if target is child of source or vice versa
      if (targetNode.groupId === sourceNode.id || sourceNode.groupId === targetNode.id) {
        return {
          isValid: false,
          relationshipType: 'CONTAINS',
          networkScope: 'internal',
          error: {
            code: 'CONTAINER_EDGE_REDUNDANT',
            message: 'Container relationships should not be drawn as network traffic edges.',
            technicalReason: `"${sourceNode.label}" physically encapsulates "${targetNode.label}". Placement inside the container already establishes their hierarchy.`,
            suggestedAlternatives: [
              'Keep the resource nested inside the container without drawing an edge.',
              'Connect workloads inside the subnet to specific endpoints instead.',
            ],
          },
        };
      }
    }

    // Rule 2: Cross-Cloud boundary connectivity validation
    if (sProvider !== tProvider) {
      // Validate whether cross-cloud communication is technically feasible
      if (isCrossCloudConnectionSupported(sType, tType)) {
        return {
          isValid: true,
          relationshipType: 'CONNECTS_TO',
          networkScope: 'cross-cloud',
          protocol: 'HTTPS / VPN',
          port: 443,
          label: 'Cross-Cloud Tunnel',
        };
      }

      return {
        isValid: false,
        relationshipType: 'LOGICAL_DEPENDENCY',
        networkScope: 'cross-cloud',
        error: {
          code: 'INVALID_CROSS_CLOUD_CONNECTION',
          message: `Direct cross-cloud connection from ${sProvider.toUpperCase()} (${sDef?.label || sType}) to ${tProvider.toUpperCase()} (${tDef?.label || tType}) is unsupported.`,
          technicalReason: 'Cloud providers do not share private network fabric. Traffic requires an explicit VPN tunnel, Interconnect, or public API gateway.',
          suggestedAlternatives: [
            'Route via public API/HTTPS endpoints with mutual TLS authentication.',
            'Connect compute workloads through a Site-to-Site VPN or interconnect gateway.',
          ],
        },
      };
    }

    // ── AWS Explicit Rules ──────────────────────────────────────────────────
    if (sProvider === 'aws') {
      // Invalid: Direct Internet to RDS / Databases
      if ((sType === 'aws_internet' || sType === 'aws_igw') && (tType === 'aws_rds' || tType === 'aws_dynamodb' || tType === 'aws_elasticache')) {
        return {
          isValid: false,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'public',
          error: {
            code: 'PUBLIC_DATABASE_EXPOSURE',
            message: 'Direct public internet routing to database instances is prohibited.',
            technicalReason: 'AWS Well-Architected Security Pillar requires databases to be placed in isolated private database subnets with no direct public route.',
            suggestedAlternatives: [
              'Route incoming traffic through Application Load Balancer -> EC2/ECS/EKS application tier -> RDS.',
              'Place RDS in a private database subnet with security group rules restricting ingress to the application tier.',
            ],
          },
        };
      }

      // Invalid: Reverse connection from Database to Internet
      if ((sType === 'aws_rds' || sType === 'aws_elasticache' || sType === 'aws_dynamodb') && (tType === 'aws_internet' || tType === 'aws_igw')) {
        return {
          isValid: false,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'public',
          error: {
            code: 'DATABASE_EGRESS_TO_INTERNET',
            message: 'Databases should not initiate outbound internet connections.',
            technicalReason: 'Stateful database tiers must not have default routes to the Internet Gateway to prevent data exfiltration and external compromise.',
            suggestedAlternatives: ['Keep database traffic restricted to VPC private subnets.'],
          },
        };
      }

      // Valid: S3 -> Lambda / SQS (S3 Event Notifications). The one legitimate exception to the "storage never initiates"
      // rule below, like the Blob trigger on the Azure side and the SQS -> Lambda event source. Must be checked before the
      // blanket rejection.
      if (sType === 'aws_s3' && (tType === 'aws_lambda' || tType === 'aws_sqs')) {
        return {
          isValid: true,
          relationshipType: 'TRIGGERS',
          networkScope: 'internal',
          protocol: 'S3 Event Notification',
          label: 'Trigger / Event',
        };
      }

      // Invalid: Storage/Database initiating connection to Compute
      if ((sType === 'aws_rds' || sType === 'aws_s3' || sType === 'aws_dynamodb' || sType === 'aws_elasticache') && (isEc2Like(tType) || tType === 'aws_lambda' || tType === 'aws_ecs' || tType === 'aws_eks' || tType === 'aws_auto_scaling')) {
        return {
          isValid: false,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'private',
          error: {
            code: 'REVERSE_COMPUTE_CONNECTION',
            message: 'Databases and storage buckets do not initiate connections to compute resources.',
            technicalReason: 'Storage and databases are passive endpoints. Compute resources must initiate the connection to them.',
            suggestedAlternatives: ['Reverse the connection direction: Compute -> Storage/Database.'],
          },
        };
      }

      // Invalid: ALB to RDS directly
      if (sType === 'aws_alb' && (tType === 'aws_rds' || tType === 'aws_elasticache')) {
        return {
          isValid: false,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'private',
          error: {
            code: 'ALB_TO_DATABASE_INVALID',
            message: 'Application Load Balancers cannot forward requests directly to databases.',
            technicalReason: 'ALBs operate at Layer 7 (HTTP/HTTPS) and route only to compute targets (EC2, ECS, EKS, Lambda, IP targets), not relational databases.',
            suggestedAlternatives: [
              'Connect ALB to EC2 / Auto Scaling Group / ECS container tier.',
              'Connect the application tier to RDS on database port 5432/3306.',
            ],
          },
        };
      }

      // Invalid: Internet directly to private EC2 without ALB or IGW
      if (sType === 'aws_internet' && (isEc2Like(tType) || tType === 'aws_auto_scaling' || tType === 'aws_ecs')) {
        const targetSubnet = allNodes.find((n) => n.id === targetNode.groupId);
        const isPublicSubnet = targetSubnet?.config?.mapPublicIpOnLaunch === true || (targetSubnet?.label || '').toLowerCase().includes('public');
        if (!isPublicSubnet) {
          return {
            isValid: false,
            relationshipType: 'NETWORK_FLOW',
            networkScope: 'public',
            error: {
              code: 'INTERNET_TO_PRIVATE_COMPUTE',
              message: 'Cannot route public internet traffic directly into private application subnets.',
              technicalReason: 'Private subnet instances lack public IP routing and cannot receive unsolicited inbound internet packets without an internet-facing Load Balancer or Bastion host.',
              suggestedAlternatives: [
                'Deploy an internet-facing Application Load Balancer in a public subnet to forward traffic to private EC2 instances.',
                'Use AWS Systems Manager (SSM) Session Manager for administrative access instead of direct internet SSH.',
              ],
            },
          };
        }
      }

      // Valid: Route 53 -> CloudFront or ALB
      if (sType === 'aws_route53' && (tType === 'aws_cloudfront' || tType === 'aws_alb')) {
        return {
          isValid: true,
          relationshipType: 'RESOLVES_TO',
          networkScope: 'public',
          protocol: 'DNS',
          port: 53,
          label: 'DNS Alias',
        };
      }

      // Valid: Internet -> Route 53
      if (sType === 'aws_internet' && tType === 'aws_route53') {
        return {
          isValid: true,
          relationshipType: 'RESOLVES_TO',
          networkScope: 'public',
          protocol: 'DNS / UDP',
          port: 53,
          label: 'DNS Query / 53',
        };
      }

      // Valid: Internet -> CloudFront
      if (sType === 'aws_internet' && tType === 'aws_cloudfront') {
        return {
          isValid: true,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'public',
          protocol: 'HTTPS',
          port: 443,
          label: 'HTTPS / 443',
        };
      }

      // Valid: Internet -> ALB (Internet-facing)
      if (sType === 'aws_internet' && tType === 'aws_alb') {
        return {
          isValid: true,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'public',
          protocol: 'HTTPS / TLS',
          port: 443,
          label: 'HTTPS / 443',
        };
      }

      // Valid: CloudFront -> ALB (Origin)
      if (sType === 'aws_cloudfront' && tType === 'aws_alb') {
        return {
          isValid: true,
          relationshipType: 'ROUTES_TO',
          networkScope: 'public',
          protocol: 'Origin HTTPS',
          port: 443,
          label: 'Origin HTTPS / 443',
        };
      }

      // Valid: CloudFront -> S3 (Static assets origin)
      if (sType === 'aws_cloudfront' && tType === 'aws_s3') {
        return {
          isValid: true,
          relationshipType: 'SERVES',
          networkScope: 'public',
          protocol: 'S3 REST API (OAC)',
          port: 443,
          label: 'S3 Origin / OAC',
        };
      }

      // Valid: WAF -> CloudFront or ALB
      if (sType === 'aws_waf' && (tType === 'aws_cloudfront' || tType === 'aws_alb')) {
        return {
          isValid: true,
          relationshipType: 'ASSOCIATED_WITH',
          networkScope: 'internal',
          label: 'WAF ACL Inspection',
        };
      }
      if ((sType === 'aws_cloudfront' || sType === 'aws_alb') && tType === 'aws_waf') {
        return {
          isValid: true,
          relationshipType: 'ASSOCIATED_WITH',
          networkScope: 'internal',
          label: 'Protected by WAF',
        };
      }

      // Valid: ALB -> EC2 / Auto Scaling / ECS
      if (sType === 'aws_alb' && (isEc2Like(tType) || tType === 'aws_auto_scaling' || tType === 'aws_ecs' || tType === 'aws_eks')) {
        return {
          isValid: true,
          relationshipType: 'LOAD_BALANCES',
          networkScope: 'private',
          protocol: 'HTTP',
          port: 80,
          label: 'Forward HTTP / 80',
        };
      }

      // Valid: EC2 / ECS -> RDS
      if ((isEc2Like(sType) || sType === 'aws_auto_scaling' || sType === 'aws_ecs' || sType === 'aws_eks' || sType === 'aws_lambda') && tType === 'aws_rds') {
        const engine = (targetNode.config?.engine as string) || 'postgres';
        const port = engine.includes('postgres') ? 5432 : 3306;
        return {
          isValid: true,
          relationshipType: 'CONNECTS_TO',
          networkScope: 'private',
          protocol: engine.includes('postgres') ? 'PostgreSQL' : 'MySQL',
          port,
          label: `${engine.includes('postgres') ? 'PostgreSQL' : 'MySQL'} / ${port}`,
        };
      }

      // Valid: EC2 / ECS -> ElastiCache
      if ((isEc2Like(sType) || sType === 'aws_auto_scaling' || sType === 'aws_ecs' || sType === 'aws_lambda') && tType === 'aws_elasticache') {
        return {
          isValid: true,
          relationshipType: 'CONNECTS_TO',
          networkScope: 'private',
          protocol: 'Redis TCP',
          port: 6379,
          label: 'Redis / 6379',
        };
      }

      // Valid: EC2 / Lambda -> S3
      if ((isEc2Like(sType) || sType === 'aws_auto_scaling' || sType === 'aws_ecs' || sType === 'aws_lambda') && tType === 'aws_s3') {
        return {
          isValid: true,
          relationshipType: 'STORES_IN',
          networkScope: 'private',
          protocol: 'HTTPS / IAM',
          port: 443,
          label: 'S3 API / IAM',
        };
      }

      // Valid: EC2 / ECS / EKS / Lambda -> DynamoDB (the DynamoDB API over HTTPS, authorised by IAM)
      if ((isEc2Like(sType) || sType === 'aws_auto_scaling' || sType === 'aws_ecs' || sType === 'aws_eks' || sType === 'aws_lambda') && tType === 'aws_dynamodb') {
        return {
          isValid: true,
          relationshipType: 'CONNECTS_TO',
          networkScope: 'private',
          protocol: 'HTTPS / IAM',
          port: 443,
          label: 'DynamoDB API / IAM',
        };
      }

      // Valid: EC2 / Lambda -> SQS
      if ((isEc2Like(sType) || sType === 'aws_ecs' || sType === 'aws_lambda') && tType === 'aws_sqs') {
        return {
          isValid: true,
          relationshipType: 'CONNECTS_TO',
          networkScope: 'private',
          protocol: 'SQS API',
          port: 443,
          label: 'Enqueue Message',
        };
      }

      // Valid: SQS -> Lambda (Event Source)
      if (sType === 'aws_sqs' && tType === 'aws_lambda') {
        return {
          isValid: true,
          relationshipType: 'TRIGGERS',
          networkScope: 'internal',
          protocol: 'EventSourceMapping',
          label: 'Trigger / Event',
        };
      }

      // Valid: Security Group association
      if (tType === 'aws_sg' || sType === 'aws_sg') {
        return {
          isValid: true,
          relationshipType: 'ASSOCIATED_WITH',
          networkScope: 'internal',
          label: 'Firewall Rule Attachment',
        };
      }

      // Valid: IAM Role association
      if (tType === 'aws_iam' || sType === 'aws_iam') {
        return {
          isValid: true,
          relationshipType: 'AUTHENTICATES_WITH',
          networkScope: 'internal',
          label: 'IAM Role Policy',
        };
      }

      // Valid: CloudWatch monitoring (alarms and metrics on a resource, drawn in either direction)
      if (tType === 'aws_cloudwatch' || sType === 'aws_cloudwatch') {
        return {
          isValid: true,
          relationshipType: 'ASSOCIATED_WITH',
          networkScope: 'internal',
          label: 'Alarm / Metric Monitoring',
        };
      }

      // Valid: NAT Gateway egress routing
      if ((isEc2Like(sType) || sType === 'aws_auto_scaling' || sType === 'aws_ecs') && tType === 'aws_nat') {
        return {
          isValid: true,
          relationshipType: 'ROUTES_TO',
          networkScope: 'private',
          protocol: 'TCP / UDP Egress',
          label: 'Outbound NAT Egress',
        };
      }
      if (sType === 'aws_nat' && tType === 'aws_igw') {
        return {
          isValid: true,
          relationshipType: 'ROUTES_TO',
          networkScope: 'public',
          protocol: 'Egress Translation',
          label: 'Internet Egress',
        };
      }
    }

    // ── Azure Explicit Rules ────────────────────────────────────────────────
    if (sProvider === 'azure') {
      // Invalid: Internet directly to Azure SQL
      if ((sType === 'azure_public_ip' || sType === 'aws_internet') && (tType === 'azure_sql' || tType === 'azure_postgres' || tType === 'azure_mysql')) {
        return {
          isValid: false,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'public',
          error: {
            code: 'PUBLIC_SQL_EXPOSURE',
            message: 'Direct public internet routing to Azure SQL Database is prohibited.',
            technicalReason: 'Enterprise production architectures require Azure SQL to use Private Endpoints inside private data subnets without public network access.',
            suggestedAlternatives: [
              'Route incoming traffic through Application Gateway / Load Balancer -> App Service / VMSS -> Azure SQL.',
              'Use Azure Private Link / Private Endpoint for SQL access.',
            ],
          },
        };
      }

      // Invalid: Reverse connection from Database to Internet
      if ((sType === 'azure_sql' || sType === 'azure_storage' || sType === 'azure_redis' || sType === 'azure_postgres' || sType === 'azure_mysql') && (tType === 'azure_public_ip' || tType === 'aws_internet')) {
        return {
          isValid: false,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'public',
          error: {
            code: 'DATABASE_EGRESS_TO_INTERNET',
            message: 'Databases and storage should not initiate outbound internet connections.',
            technicalReason: 'Stateful database tiers must not have default routes to the Internet to prevent data exfiltration.',
            suggestedAlternatives: ['Keep database traffic restricted to private virtual networks.'],
          },
        };
      }

      // Valid: Storage -> Functions (Blob trigger / Event Grid event source) —
      // the one legitimate exception to the "storage never initiates" rule
      // below, mirroring the SQS -> Lambda event-source carve-out elsewhere
      // in this engine. Must be checked before the blanket rejection.
      if (sType === 'azure_storage' && tType === 'azure_functions') {
        return {
          isValid: true,
          relationshipType: 'TRIGGERS',
          networkScope: 'internal',
          protocol: 'Blob Trigger',
          label: 'Trigger / Event',
        };
      }

      // Valid: Service Bus -> Functions (queue trigger), the other event-source exception to the passive-endpoint rule below.
      if (sType === 'azure_service_bus' && tType === 'azure_functions') {
        return { isValid: true, relationshipType: 'TRIGGERS', networkScope: 'internal', protocol: 'Service Bus Trigger', label: 'Queue Trigger' };
      }

      // Valid: Event Hubs / Event Grid -> Functions (event triggers)
      if ((sType === 'azure_event_hubs' || sType === 'azure_event_grid') && tType === 'azure_functions') {
        return { isValid: true, relationshipType: 'TRIGGERS', networkScope: 'internal', protocol: sType === 'azure_event_hubs' ? 'Event Hub Trigger' : 'Event Grid Trigger', label: 'Event Trigger' };
      }

      // Invalid: Storage/Database initiating connection to Compute
      if ((sType === 'azure_event_hubs' || sType === 'azure_event_grid' || sType === 'azure_sql' || sType === 'azure_storage' || sType === 'azure_redis' || sType === 'azure_postgres' || sType === 'azure_mysql' || sType === 'azure_service_bus' || sType === 'azure_acr') && (isAzureVmLike(tType) || tType === 'azure_vmss' || tType === 'azure_functions' || tType === 'azure_app_service' || tType === 'azure_aks')) {
        return {
          isValid: false,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'private',
          error: {
            code: 'REVERSE_COMPUTE_CONNECTION',
            message: 'Databases and storage do not initiate connections to compute resources.',
            technicalReason: 'Storage and databases are passive endpoints. Compute resources must initiate the connection to them.',
            suggestedAlternatives: ['Reverse the connection direction: Compute -> Storage/Database.'],
          },
        };
      }

      // Valid: Internet -> Front Door
      if ((sType === 'aws_internet' || sType === 'azure_public_ip') && tType === 'azure_front_door') {
        return {
          isValid: true,
          relationshipType: 'NETWORK_FLOW',
          networkScope: 'public',
          protocol: 'HTTPS',
          port: 443,
          label: 'HTTPS / 443',
        };
      }

      // Valid: Front Door -> Application Gateway
      if (sType === 'azure_front_door' && tType === 'azure_app_gateway') {
        return {
          isValid: true,
          relationshipType: 'ROUTES_TO',
          networkScope: 'public',
          protocol: 'HTTPS Origin',
          port: 443,
          label: 'Backend Pool HTTPS',
        };
      }

      // Valid: Front Door -> Storage Account (Blob static)
      if (sType === 'azure_front_door' && tType === 'azure_storage') {
        return {
          isValid: true,
          relationshipType: 'SERVES',
          networkScope: 'public',
          protocol: 'Blob HTTPS',
          port: 443,
          label: 'Static Blob Origin',
        };
      }

      // Valid: WAF -> Front Door / App Gateway
      if (sType === 'azure_waf' && (tType === 'azure_front_door' || tType === 'azure_app_gateway')) {
        return {
          isValid: true,
          relationshipType: 'ASSOCIATED_WITH',
          networkScope: 'internal',
          label: 'WAF Policy Attached',
        };
      }

      // Valid: App Gateway / LB -> VM / VMSS / AKS
      if ((sType === 'azure_app_gateway' || sType === 'azure_lb') && (isAzureVmLike(tType) || tType === 'azure_vmss' || tType === 'azure_aks')) {
        return {
          isValid: true,
          relationshipType: 'LOAD_BALANCES',
          networkScope: 'private',
          protocol: 'HTTP',
          port: 80,
          label: 'Backend Pool / 80',
        };
      }

      // Valid: VM / VMSS -> Azure SQL
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service' || sType === 'azure_aks') && tType === 'azure_sql') {
        return {
          isValid: true,
          relationshipType: 'CONNECTS_TO',
          networkScope: 'private',
          protocol: 'TDS / TCP',
          port: 1433,
          label: 'TDS / 1433',
        };
      }

      // Valid: VM / VMSS -> Azure Redis
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service' || sType === 'azure_aks') && tType === 'azure_redis') {
        return {
          isValid: true,
          relationshipType: 'CONNECTS_TO',
          networkScope: 'private',
          protocol: 'Redis TLS',
          port: 6380,
          label: 'Redis TLS / 6380',
        };
      }

      // Valid: VM / VMSS -> Storage Account
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service') && tType === 'azure_storage') {
        return {
          isValid: true,
          relationshipType: 'STORES_IN',
          networkScope: 'private',
          protocol: 'Blob HTTPS',
          port: 443,
          label: 'Blob Storage / 443',
        };
      }

      // Valid: VM / VMSS / Functions / App Service / AKS -> Cosmos DB (the Cosmos DB API over HTTPS)
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service' || sType === 'azure_aks') && tType === 'azure_cosmos_db') {
        return {
          isValid: true,
          relationshipType: 'CONNECTS_TO',
          networkScope: 'private',
          protocol: 'HTTPS',
          port: 443,
          label: 'Cosmos DB / 443',
        };
      }

      // Valid: Private Endpoint <-> the service it reaches. The line says "this endpoint is the private way in"; the application connects
      // to the service itself, as it always does (its name then resolves to the endpoint through the private DNS zone).
      if ((sType === 'azure_private_endpoint' && tType in PRIVATE_LINK_TARGETS) || (tType === 'azure_private_endpoint' && sType in PRIVATE_LINK_TARGETS)) {
        return { isValid: true, relationshipType: 'ASSOCIATED_WITH', networkScope: 'private', protocol: 'Private Link', port: 443, label: 'Private Link' };
      }
      if (sType === 'azure_private_endpoint' || tType === 'azure_private_endpoint') {
        return {
          isValid: false,
          relationshipType: 'ASSOCIATED_WITH',
          networkScope: 'private',
          error: {
            code: 'PRIVATE_ENDPOINT_TARGET',
            message: 'A Private Endpoint connects to one of: Storage, Azure SQL, Key Vault, Redis, Cosmos DB, Container Registry or Service Bus.',
            technicalReason: 'Private Link can expose these services (and a few others) on a private address. PostgreSQL and MySQL flexible servers are placed in a subnet instead, and compute is not reached through an endpoint.',
            suggestedAlternatives: ['Connect the endpoint to the service it should reach.', 'Connect the application to the service, not to the endpoint.'],
          },
        };
      }

      // Valid: compute -> PostgreSQL / MySQL flexible server
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service' || sType === 'azure_aks') && (tType === 'azure_postgres' || tType === 'azure_mysql')) {
        const pg = tType === 'azure_postgres';
        return { isValid: true, relationshipType: 'DATABASE_CONNECTION', networkScope: 'private', protocol: pg ? 'PostgreSQL / TCP' : 'MySQL / TCP', port: pg ? 5432 : 3306, label: pg ? 'PostgreSQL / 5432' : 'MySQL / 3306' };
      }

      // Valid: compute -> Service Bus (AMQP over TLS)
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service' || sType === 'azure_aks') && tType === 'azure_service_bus') {
        return { isValid: true, relationshipType: 'CONNECTS_TO', networkScope: 'private', protocol: 'AMQP over TLS', port: 5671, label: 'Service Bus / 5671' };
      }

      // Valid: compute -> Event Hubs (AMQP over TLS) and Event Grid (publishing over HTTPS)
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service' || sType === 'azure_aks') && tType === 'azure_event_hubs') {
        return { isValid: true, relationshipType: 'CONNECTS_TO', networkScope: 'private', protocol: 'AMQP over TLS', port: 5671, label: 'Event Hubs / 5671' };
      }
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service' || sType === 'azure_aks') && tType === 'azure_event_grid') {
        return { isValid: true, relationshipType: 'WRITES_TO', networkScope: 'private', protocol: 'HTTPS', port: 443, label: 'Publish events / 443' };
      }

      // Valid: Front Door / Application Gateway -> API Management, and API Management -> the services it fronts
      if ((sType === 'azure_front_door' || sType === 'azure_app_gateway') && tType === 'azure_api_management') {
        return { isValid: true, relationshipType: 'ROUTES_TO', networkScope: 'public', protocol: 'HTTPS', port: 443, label: 'API traffic / 443' };
      }
      if (sType === 'azure_api_management' && (isAzureVmLike(tType) || tType === 'azure_vmss' || tType === 'azure_functions' || tType === 'azure_app_service' || tType === 'azure_aks')) {
        return { isValid: true, relationshipType: 'ROUTES_TO', networkScope: 'private', protocol: 'HTTPS', port: 443, label: 'Backend API / 443' };
      }

      // Valid: a route table sends its subnets' traffic through a firewall
      if (sType === 'azure_route_table' && tType === 'azure_firewall') {
        return { isValid: true, relationshipType: 'ROUTES_TO', networkScope: 'private', label: 'Default route via firewall' };
      }

      // Valid: compute pulls images from the Container Registry
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service' || sType === 'azure_aks') && tType === 'azure_acr') {
        return { isValid: true, relationshipType: 'READS_FROM', networkScope: 'private', protocol: 'HTTPS', port: 443, label: 'Image pull / 443' };
      }

      // Valid: anything that produces telemetry -> Azure Monitor
      if (tType === 'azure_monitor' && sType !== 'azure_monitor') {
        return { isValid: true, relationshipType: 'WRITES_TO', networkScope: 'private', protocol: 'HTTPS', port: 443, label: 'Telemetry / 443' };
      }

      // Valid: NSG association
      if (tType === 'azure_nsg' || sType === 'azure_nsg') {
        return {
          isValid: true,
          relationshipType: 'ASSOCIATED_WITH',
          networkScope: 'internal',
          label: 'NSG Rule Attached',
        };
      }

      // Valid: Key Vault access
      if ((isAzureVmLike(sType) || sType === 'azure_vmss' || sType === 'azure_functions' || sType === 'azure_app_service') && tType === 'azure_key_vault') {
        return {
          isValid: true,
          relationshipType: 'AUTHENTICATES_WITH',
          networkScope: 'private',
          protocol: 'Managed Identity',
          port: 443,
          label: 'Managed Identity / KeyVault',
        };
      }
    }

    // Default fallback: no explicit rule matched this resource-type pair.
    // The connection is still allowed (over-blocking unmodeled but legitimate
    // pairs would be worse), but per the "no fabricated cloud facts" rule we
    // do NOT assert a specific protocol/port we have no basis for — this is
    // surfaced to the user as unverified rather than presented as a known fact.
    return {
      isValid: true,
      relationshipType: 'NETWORK_FLOW',
      networkScope: 'private',
      label: 'Unclassified Connection (protocol/port not verified)',
    };
  }
}

export const relationshipEngine = RelationshipEngine.getInstance();

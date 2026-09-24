/**
 * Deterministic mixed AWS + Azure architecture graph of N resources (containment and
 * connections, every third resource insecure) for performance benchmarks and tests.
 */
import { getResourceDefinition } from '@/lib/resources';
import type { CanvasEdge, CanvasNode } from '@/types';

const AWS = ['aws_ec2', 'aws_rds', 'aws_s3', 'aws_alb', 'aws_sg', 'aws_ebs', 'aws_lambda', 'aws_dynamodb', 'aws_sqs', 'aws_elasticache', 'aws_eks', 'aws_cloudfront'];
const AZ = ['azure_vm', 'azure_sql', 'azure_storage', 'azure_nsg', 'azure_app_service', 'azure_key_vault', 'azure_redis', 'azure_aks', 'azure_cosmos_db', 'azure_functions'];

export function graph(n: number): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = []; const edges: CanvasEdge[] = [];
  const mk = (id: string, t: string, parentId?: string, over: Record<string, unknown> = {}): CanvasNode => ({
    id, type: 'cloudNode', resourceType: t, provider: t.startsWith('azure') ? 'azure' : 'aws', label: id,
    position: { x: nodes.length * 10, y: 0 }, parentId, config: { ...(getResourceDefinition(t)?.defaultConfig ?? {}), ...over },
  } as CanvasNode);
  nodes.push(mk('vpc', 'aws_vpc'), mk('sub-a', 'aws_subnet', 'vpc'), mk('sub-b', 'aws_subnet', 'vpc'), mk('rg', 'azure_resource_group'), mk('vnet', 'azure_vnet', 'rg'), mk('snet', 'azure_subnet', 'vnet'));
  let i = 0;
  while (nodes.length < n) {
    const aws = i % 2 === 0;
    const pool = aws ? AWS : AZ;
    const t = pool[i % pool.length];
    // every third resource is insecure so findings and fixes exist
    const insecure = i % 3 === 0 ? { publiclyAccessible: true, encrypted: false, detailedMonitoring: false, httpsOnly: false, versioning: false } : {};
    const node = mk(`r${i}`, t, aws ? (i % 4 === 0 ? 'sub-a' : 'sub-b') : 'snet', insecure);
    nodes.push(node);
    if (nodes.length > 8) edges.push({ id: `e${i}`, source: nodes[nodes.length - 2].id, target: node.id });
    i++;
  }
  return { nodes, edges };
}

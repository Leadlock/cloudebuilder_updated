/**
 * Generates an Azure AI Foundry compatible Fine-Tuning dataset (JSONL)
 * containing diverse, gold-standard cloud architectures.
 *
 * Usage: npx tsx scripts/generate-finetuning-dataset.ts
 */
import * as fs from 'fs';
import * as path from 'path';

interface TrainingExample {
  prompt: string;
  provider: 'aws' | 'azure';
  graph: {
    resources: Array<{
      id: string;
      resourceType: string;
      label?: string;
      config?: Record<string, unknown>;
      parentId?: string | null;
    }>;
    connections: Array<{
      sourceId: string;
      targetId: string;
      label?: string;
    }>;
  };
}

const EXAMPLES: TrainingExample[] = [
  // 1. E-Commerce / Multi-Tier HA SaaS (AWS)
  {
    prompt: 'Multi-tier e-commerce platform with CDN, auto-scaling and managed database',
    provider: 'aws',
    graph: {
      resources: [
        { id: 'vpc-1', resourceType: 'aws_vpc', label: 'Production VPC', config: { cidrBlock: '10.0.0.0/16' }, parentId: null },
        { id: 'sub-pub-1', resourceType: 'aws_subnet', label: 'Public Subnet 1A', config: { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', isPublic: true }, parentId: 'vpc-1' },
        { id: 'sub-pub-2', resourceType: 'aws_subnet', label: 'Public Subnet 1B', config: { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b', isPublic: true }, parentId: 'vpc-1' },
        { id: 'sub-priv-1', resourceType: 'aws_subnet', label: 'App Subnet 1A', config: { cidrBlock: '10.0.3.0/24', availabilityZone: 'us-east-1a', isPublic: false }, parentId: 'vpc-1' },
        { id: 'sub-priv-2', resourceType: 'aws_subnet', label: 'App Subnet 1B', config: { cidrBlock: '10.0.4.0/24', availabilityZone: 'us-east-1b', isPublic: false }, parentId: 'vpc-1' },
        { id: 'sub-data-1', resourceType: 'aws_subnet', label: 'Data Subnet 1A', config: { cidrBlock: '10.0.5.0/24', availabilityZone: 'us-east-1a', isPublic: false }, parentId: 'vpc-1' },
        { id: 'sub-data-2', resourceType: 'aws_subnet', label: 'Data Subnet 1B', config: { cidrBlock: '10.0.6.0/24', availabilityZone: 'us-east-1b', isPublic: false }, parentId: 'vpc-1' },
        { id: 'cdn-1', resourceType: 'aws_cloudfront', label: 'CloudFront CDN', config: {}, parentId: null },
        { id: 'alb-1', resourceType: 'aws_alb', label: 'Application Load Balancer', config: { internetFacing: true }, parentId: 'sub-pub-1' },
        { id: 'asg-1', resourceType: 'aws_auto_scaling', label: 'App Auto Scaling (AZ-A)', config: { minSize: 2, maxSize: 8 }, parentId: 'sub-priv-1' },
        { id: 'asg-2', resourceType: 'aws_auto_scaling', label: 'App Auto Scaling (AZ-B)', config: { minSize: 2, maxSize: 8 }, parentId: 'sub-priv-2' },
        { id: 'rds-1', resourceType: 'aws_rds', label: 'PostgreSQL Database', config: { multiAZ: true, storageEncrypted: true }, parentId: 'sub-data-1' },
        { id: 'cache-1', resourceType: 'aws_elasticache', label: 'Redis Cluster', config: { numCacheNodes: 2 }, parentId: 'sub-data-2' }
      ],
      connections: [
        { sourceId: 'cdn-1', targetId: 'alb-1', label: 'HTTPS' },
        { sourceId: 'alb-1', targetId: 'asg-1', label: 'HTTP Traffic (AZ-A)' },
        { sourceId: 'alb-1', targetId: 'asg-2', label: 'HTTP Traffic (AZ-B)' },
        { sourceId: 'asg-1', targetId: 'cache-1', label: 'Cache Reads/Writes' },
        { sourceId: 'asg-2', targetId: 'cache-1', label: 'Cache Reads/Writes' },
        { sourceId: 'asg-1', targetId: 'rds-1', label: 'Database Queries' },
        { sourceId: 'asg-2', targetId: 'rds-1', label: 'Database Queries' }
      ]
    }
  },
  // 2. Serverless Event-Driven Architecture (AWS)
  {
    prompt: 'Serverless event-driven architecture with API Gateway, Lambda, SQS and DynamoDB',
    provider: 'aws',
    graph: {
      resources: [
        { id: 'apigw-1', resourceType: 'aws_apigateway', label: 'HTTP API Gateway', config: {}, parentId: null },
        { id: 'lambda-1', resourceType: 'aws_lambda', label: 'Order Processing Function', config: { runtime: 'nodejs20.x' }, parentId: null },
        { id: 'sqs-1', resourceType: 'aws_sqs', label: 'Order Event Queue', config: { fifoQueue: false }, parentId: null },
        { id: 'lambda-worker', resourceType: 'aws_lambda', label: 'Queue Worker', config: { runtime: 'nodejs20.x' }, parentId: null },
        { id: 'dynamo-1', resourceType: 'aws_dynamodb', label: 'Orders Table', config: { billingMode: 'PAY_PER_REQUEST' }, parentId: null },
        { id: 's3-bucket', resourceType: 'aws_s3', label: 'Invoice Storage', config: { publicAccessBlock: true }, parentId: null }
      ],
      connections: [
        { sourceId: 'apigw-1', targetId: 'lambda-1', label: 'Invoke' },
        { sourceId: 'lambda-1', targetId: 'sqs-1', label: 'Publish Event' },
        { sourceId: 'sqs-1', targetId: 'lambda-worker', label: 'Batch Trigger' },
        { sourceId: 'lambda-worker', targetId: 'dynamo-1', label: 'Write Order' },
        { sourceId: 'lambda-worker', targetId: 's3-bucket', label: 'Store PDF' }
      ]
    }
  },
  // 3. Azure Microservices with AKS and Cosmos DB
  {
    prompt: 'Microservices architecture with AKS cluster, Azure Application Gateway and Cosmos DB',
    provider: 'azure',
    graph: {
      resources: [
        { id: 'rg-1', resourceType: 'azure_resource_group', label: 'Production RG', config: { location: 'eastus' }, parentId: null },
        { id: 'vnet-1', resourceType: 'azure_vnet', label: 'Spoke VNet', config: { addressSpace: '10.0.0.0/16' }, parentId: 'rg-1' },
        { id: 'sub-appgw', resourceType: 'azure_subnet', label: 'Gateway Subnet', config: { cidrBlock: '10.0.1.0/24' }, parentId: 'vnet-1' },
        { id: 'sub-aks', resourceType: 'azure_subnet', label: 'AKS Subnet', config: { cidrBlock: '10.0.2.0/24' }, parentId: 'vnet-1' },
        { id: 'appgw-1', resourceType: 'azure_app_gateway', label: 'WAF App Gateway', config: {}, parentId: 'sub-appgw' },
        { id: 'aks-1', resourceType: 'azure_aks', label: 'Core AKS Cluster', config: { nodeCount: 3 }, parentId: 'sub-aks' },
        { id: 'cosmos-1', resourceType: 'azure_cosmosdb', label: 'Global Cosmos DB', config: { enableAutomaticFailover: true }, parentId: 'rg-1' },
        { id: 'redis-1', resourceType: 'azure_redis', label: 'Azure Cache for Redis', config: { sku: 'Standard' }, parentId: 'rg-1' }
      ],
      connections: [
        { sourceId: 'appgw-1', targetId: 'aks-1', label: 'Ingress Routing' },
        { sourceId: 'aks-1', targetId: 'redis-1', label: 'Session Cache' },
        { sourceId: 'aks-1', targetId: 'cosmos-1', label: 'Document Store' }
      ]
    }
  }
];

function generateDataset() {
  const outputPath = path.join(process.cwd(), 'azure-ai-finetune-dataset.jsonl');
  const writeStream = fs.createWriteStream(outputPath, { flags: 'w' });

  let count = 0;
  for (const ex of EXAMPLES) {
    const systemPrompt = `You are an expert ${ex.provider.toUpperCase()} cloud architect. Given a user prompt, generate a JSON representation of a cloud architecture matching CloudCraft RDE schema.`;

    const entry = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: ex.prompt },
        { role: 'assistant', content: JSON.stringify(ex.graph) }
      ]
    };

    writeStream.write(JSON.stringify(entry) + '\n');
    count++;
  }

  writeStream.end();
  console.log(`Generated ${count} fine-tuning examples to ${outputPath}`);
}

generateDataset();

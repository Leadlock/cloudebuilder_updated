import { analyzeTerraformWarnings, applyManualFixToProject, fixAllWarnings } from '@/lib/terraform/terraformWarningAnalyzer';
import { Project } from '@/types';

describe('Terraform Warning Analyzer & Remediation Engine', () => {
  const mockProject: Project = {
    id: 'test-proj',
    name: 'PRISM Production Architecture',
    provider: 'aws',
    description: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resourceCount: 3,
    securityScore: 85,
    architectureScore: 90,
    estimatedMonthlyCost: 200,
    environment: 'production',
    region: 'us-east-1',
    versions: [],
    environments: {} as any,
    tags: [],
    nodes: [
      {
        id: 'vpc-1',
        type: 'containerNode',
        resourceType: 'aws_vpc',
        provider: 'aws',
        label: 'Production VPC (10.0.0.0/16)',
        position: { x: 100, y: 100 },
        config: { cidrBlock: '10.0.0.0/16' },
      },
      {
        id: 'subnet-1',
        type: 'containerNode',
        resourceType: 'aws_subnet',
        provider: 'aws',
        label: 'Public Subnet (10.0.1.0/24)',
        position: { x: 140, y: 250 },
        groupId: 'vpc-1',
        config: { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true },
      },
      {
        id: 'alb-1',
        type: 'cloudNode',
        resourceType: 'aws_alb',
        provider: 'aws',
        label: 'Application Load Balancer (path routing)',
        position: { x: 400, y: 180 },
        groupId: 'vpc-1',
        config: { scheme: 'internet-facing' },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'alb-1',
        target: 'subnet-1',
        relationshipType: 'LOAD_BALANCES',
      },
    ],
  };

  test('filters out canvas boundary containers like aws_cloud_boundary from warnings', () => {
    const rawWarnings = [
      'Unsupported AWS resource type: aws_cloud_boundary (resource: Amazon Web Services (us-east-1))',
      'Load balancer "Application Load Balancer (path routing)" is internet-facing but only one public subnet exists, so it was also placed in the private subnet "Private Data Subnet" to cover a second Availability Zone. Add a second PUBLIC subnet in another Availability Zone and connect it to the load balancer.',
    ];

    const analyzed = analyzeTerraformWarnings(rawWarnings, mockProject.nodes, mockProject.edges);
    expect(analyzed).toHaveLength(1);
    expect(analyzed[0]!.title).toContain('Internet-Facing Load Balancer Requires 2+ Public Subnets');
    expect(analyzed[0]!.category).toBe('load_balancer');
    expect(analyzed[0]!.canAutoFixManually).toBe(true);
  });

  test('parses private subnet missing NAT Gateway warning and creates structured steps and AI prompt', () => {
    const rawWarnings = [
      'The services in the private subnets of "Production VPC (10.0.0.0/16)" have no route to the internet (no NAT Gateway), so they cannot pull their container image or send logs and their tasks will not start. Add a NAT Gateway in a public subnet to the diagram (it costs about $32 a month), or turn on "Assign Public IP" for the services.',
    ];

    const analyzed = analyzeTerraformWarnings(rawWarnings, mockProject.nodes, mockProject.edges);
    expect(analyzed).toHaveLength(1);
    expect(analyzed[0]!.severity).toBe('critical');
    expect(analyzed[0]!.category).toBe('networking');
    expect(analyzed[0]!.aiInputs).toBeDefined();
    expect(analyzed[0]!.aiInputs?.some((i) => i.id === 'allocateEip')).toBe(true);
    expect(analyzed[0]!.canAutoFixManually).toBe(true);
  });

  test('applyManualFixToProject adds a second public subnet in Availability Zone B and links to ALB', () => {
    const raw = 'Load balancer "Application Load Balancer (path routing)" is internet-facing but only one public subnet exists...';
    const [warning] = analyzeTerraformWarnings([raw], mockProject.nodes, mockProject.edges);
    expect(warning).toBeDefined();

    const result = applyManualFixToProject(warning!, mockProject, {
      subnetCidr: '10.0.2.0/24',
      availabilityZone: 'us-east-1b',
      subnetName: 'Public Web Subnet (AZ-B)',
    });

    const newSubnet = result.updatedProject.nodes.find((n) => n.config?.availabilityZone === 'us-east-1b');
    expect(newSubnet).toBeDefined();
    expect(newSubnet?.config?.cidrBlock).toBe('10.0.2.0/24');
    expect(newSubnet?.config?.mapPublicIpOnLaunch).toBe(true);

    const albLink = result.updatedProject.edges.find((e) => e.source === 'alb-1' && e.target === newSubnet?.id);
    expect(albLink).toBeDefined();
    expect(result.message).toContain('Public Web Subnet (AZ-B)');
  });

  test('applyManualFixToProject adds a NAT Gateway into the public subnet', () => {
    const raw = 'The services in the private subnets of "Production VPC (10.0.0.0/16)" have no route to the internet (no NAT Gateway)...';
    const [warning] = analyzeTerraformWarnings([raw], mockProject.nodes, mockProject.edges);
    expect(warning).toBeDefined();

    const result = applyManualFixToProject(warning!, mockProject, {
      natName: 'Production NAT Gateway',
    });

    const natNode = result.updatedProject.nodes.find((n) => n.resourceType === 'aws_nat');
    expect(natNode).toBeDefined();
    expect(natNode?.label).toBe('Production NAT Gateway');
    expect(natNode?.groupId).toBe('subnet-1');
  });

  test('remediates unsupported resource or converts visual container box to containerNode', () => {
    const projectWithContainer: Project = {
      ...mockProject,
      nodes: [
        ...mockProject.nodes,
        {
          id: 'edgegrp',
          type: 'containerNode',
          resourceType: 'invalid_resource_type',
          provider: 'aws',
          label: 'Edge (Global)',
          position: { x: 500, y: 100 },
          config: {},
        },
        {
          id: 'secrets-1',
          type: 'cloudNode',
          resourceType: 'aws_secrets_manager',
          provider: 'aws',
          label: 'AWS Secrets Manager',
          position: { x: 600, y: 200 },
          config: {},
        },
      ],
    };

    const raw = [
      'Unsupported AWS resource type: invalid_resource_type (resource: Edge (Global))',
      'Unsupported AWS resource type: aws_secrets_manager (resource: AWS Secrets Manager)',
    ];

    const warnings = analyzeTerraformWarnings(raw, projectWithContainer.nodes, projectWithContainer.edges);
    expect(warnings.length).toBeGreaterThanOrEqual(1);

    const secretsWarning = warnings.find((w) => w.affectedResource === 'AWS Secrets Manager');
    expect(secretsWarning).toBeDefined();
    expect(secretsWarning?.canAutoFixManually).toBe(true);

    const fixResult = applyManualFixToProject(secretsWarning!, projectWithContainer);
    const fixedSecrets = fixResult.updatedProject.nodes.find((n) => n.id === 'secrets-1');
    expect(fixedSecrets?.resourceType).toBe('aws_secretsmanager');

    // Test fixAllWarnings batch execution
    const batchResult = fixAllWarnings(warnings, projectWithContainer);
    expect(batchResult.fixedCount).toBeGreaterThanOrEqual(1);
  });
});

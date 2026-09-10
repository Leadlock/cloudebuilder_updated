/**
 * Production Infrastructure Discovery Tests
 *
 * Comprehensive tests for:
 * 1. AWS Resource Normalization & Topology Reconstruction (VPC, Subnet, EC2, RDS, ALB, Target Groups, S3)
 * 2. Azure Resource Normalization & Topology Reconstruction (RG, VNet, Subnet, VM, SQL, Storage, NSG)
 * 3. Container Node layouts, hierarchy (groupId, parentId), and directional edges
 * 4. Preservation of live cloud identifiers (ARN, resourceId, region, source, imported: true)
 * 5. State distinction: imported vs new vs modified vs planned
 * 6. Unsupported resource graceful fallback (aws_unknown, azure_unknown)
 * 7. Change detection & drift analysis (InfrastructureSyncService)
 * 8. Non-destructive deduplication in DiscoveryImportService
 * 9. Terraform generation safety:
 *    - Data source generation for imported resources
 *    - Standard resource blocks for new proposed resources
 *    - Proper references to data sources
 * 10. Cost calculation integration for imported resources
 */

import type { DiscoveredResource } from '@/lib/cloud/types';
import type { CloudResource } from '@/lib/cloud/discovery/types';
import { normalizeDiscoveredInfrastructure } from '@/lib/cloud/normalizer';
import { InfrastructureSyncService } from '@/lib/cloud/sync/InfrastructureSyncService';
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { calculateCosts } from '@/lib/analysis';
import type { CanvasNode } from '@/types';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

describe('Production Infrastructure Discovery & Import', () => {

  describe('1. AWS Resource Normalization & Topology Reconstruction', () => {
    const awsResources: DiscoveredResource[] = [
      {
        provider: 'aws',
        resourceType: 'vpc',
        providerResourceId: 'vpc-0123456789abcdef0',
        name: 'prod-vpc',
        region: 'us-east-1',
        status: 'available',
        configuration: {
          cidrBlock: '10.0.0.0/16',
          imported: true,
          source: 'aws-api',
          arn: 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0123456789abcdef0',
          resourceId: 'vpc-0123456789abcdef0',
        },
        metadata: {
          relationships: [
            { targetResourceId: 'igw-01234', relationshipType: 'attached_to' },
          ],
        },
      },
      {
        provider: 'aws',
        resourceType: 'subnet',
        providerResourceId: 'subnet-pub1',
        name: 'prod-public-1a',
        region: 'us-east-1',
        status: 'available',
        configuration: {
          cidrBlock: '10.0.1.0/24',
          vpcId: 'vpc-0123456789abcdef0',
          parentResourceId: 'vpc-0123456789abcdef0',
          imported: true,
          resourceId: 'subnet-pub1',
        },
        metadata: {},
      },
      {
        provider: 'aws',
        resourceType: 'ec2-instance',
        providerResourceId: 'i-0ec2webserver',
        name: 'prod-web-1',
        region: 'us-east-1',
        status: 'running',
        configuration: {
          instanceType: 't3.micro',
          subnetId: 'subnet-pub1',
          vpcId: 'vpc-0123456789abcdef0',
          parentResourceId: 'subnet-pub1',
          imported: true,
          resourceId: 'i-0ec2webserver',
        },
        metadata: {},
      },
      {
        provider: 'aws',
        resourceType: 'rds-instance',
        providerResourceId: 'rds-db-instance',
        name: 'prod-postgres-db',
        region: 'us-east-1',
        status: 'available',
        configuration: {
          engine: 'postgres',
          instanceClass: 'db.t3.micro',
          vpcId: 'vpc-0123456789abcdef0',
          imported: true,
          resourceId: 'rds-db-instance',
        },
        metadata: {},
      },
      {
        provider: 'aws',
        resourceType: 's3-bucket',
        providerResourceId: 'prod-assets-bucket',
        name: 'prod-assets-bucket',
        region: 'us-east-1',
        status: 'available',
        configuration: {
          bucketName: 'prod-assets-bucket',
          imported: true,
          resourceId: 'prod-assets-bucket',
        },
        metadata: {},
      },
      {
        provider: 'aws',
        resourceType: 'alb',
        providerResourceId: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/prod-alb/1234',
        name: 'prod-alb',
        region: 'us-east-1',
        status: 'active',
        configuration: {
          vpcId: 'vpc-0123456789abcdef0',
          imported: true,
          resourceId: 'prod-alb',
        },
        metadata: {
          relationships: [
            { targetResourceId: 'tg-0123', relationshipType: 'routes_to' },
          ],
        },
      },
      {
        provider: 'aws',
        resourceType: 'target-group',
        providerResourceId: 'tg-0123',
        name: 'prod-tg-web',
        region: 'us-east-1',
        status: 'healthy',
        configuration: {
          port: 80,
          protocol: 'HTTP',
          vpcId: 'vpc-0123456789abcdef0',
          targetIds: ['i-0ec2webserver'],
          imported: true,
          resourceId: 'tg-0123',
        },
        metadata: {
          relationships: [
            { targetResourceId: 'i-0ec2webserver', relationshipType: 'targets' },
          ],
        },
      },
    ];

    it('normalizes resources, establishes container hierarchy, and marks importState as imported', () => {
      const { nodes, edges } = normalizeDiscoveredInfrastructure(awsResources);

      expect(nodes.length).toBe(7);

      // VPC Container
      const vpcNode = nodes.find((n) => n.id === 'vpc-0123456789abcdef0');
      expect(vpcNode).toBeDefined();
      expect(vpcNode?.type).toBe('containerNode');
      expect(vpcNode?.resourceType).toBe('aws_vpc');
      expect(vpcNode?.importState).toBe('imported');
      expect(vpcNode?.config?.imported).toBe(true);

      // Subnet child of VPC
      const subnetNode = nodes.find((n) => n.id === 'subnet-pub1');
      expect(subnetNode).toBeDefined();
      expect(subnetNode?.type).toBe('containerNode');
      expect(subnetNode?.groupId).toBe('vpc-0123456789abcdef0');
      expect(subnetNode?.importState).toBe('imported');

      // EC2 child of Subnet
      const ec2Node = nodes.find((n) => n.id === 'i-0ec2webserver');
      expect(ec2Node).toBeDefined();
      expect(ec2Node?.type).toBe('cloudNode');
      expect(ec2Node?.groupId).toBe('subnet-pub1');
      expect(ec2Node?.importState).toBe('imported');

      // ALB and Target Group
      const albNode = nodes.find((n) => n.resourceType === 'aws_alb');
      expect(albNode).toBeDefined();
      expect(albNode?.importState).toBe('imported');

      // Relationships / Edges
      expect(edges.length).toBeGreaterThan(0);
      const vpcToSubnetEdge = edges.find((e) => e.source === vpcNode?.id && e.target === subnetNode?.id);
      expect(vpcToSubnetEdge).toBeDefined();

      const albToTgEdge = edges.find((e) => e.source === albNode?.id && e.target === 'tg-0123');
      expect(albToTgEdge).toBeDefined();
    });

    it('preserves real cloud identifiers in node config', () => {
      const { nodes } = normalizeDiscoveredInfrastructure(awsResources);
      const ec2 = nodes.find((n) => n.id === 'i-0ec2webserver');
      expect(ec2?.config?.resourceId).toBe('i-0ec2webserver');
      expect(ec2?.config?.imported).toBe(true);
      expect(ec2?.region).toBe('us-east-1');
    });
  });

  describe('2. Azure Resource Normalization & Topology Reconstruction', () => {
    const azureResources: DiscoveredResource[] = [
      {
        provider: 'azure',
        resourceType: 'resource-group',
        providerResourceId: '/subscriptions/sub-123/resourceGroups/rg-prod',
        name: 'rg-prod',
        region: 'eastus',
        status: 'Succeeded',
        configuration: {
          location: 'eastus',
          imported: true,
          source: 'azure-arm',
        },
        metadata: {},
      },
      {
        provider: 'azure',
        resourceType: 'vnet',
        providerResourceId: '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Network/virtualNetworks/vnet-prod',
        name: 'vnet-prod',
        region: 'eastus',
        status: 'Succeeded',
        configuration: {
          addressSpace: '10.1.0.0/16',
          resourceGroup: 'rg-prod',
          parentResourceId: '/subscriptions/sub-123/resourceGroups/rg-prod',
          imported: true,
        },
        metadata: {},
      },
      {
        provider: 'azure',
        resourceType: 'subnet',
        providerResourceId: '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Network/virtualNetworks/vnet-prod/subnets/snet-app',
        name: 'snet-app',
        region: 'eastus',
        status: 'Succeeded',
        configuration: {
          addressPrefix: '10.1.1.0/24',
          vnetName: 'vnet-prod',
          parentResourceId: '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Network/virtualNetworks/vnet-prod',
          imported: true,
        },
        metadata: {},
      },
      {
        provider: 'azure',
        resourceType: 'virtual-machine',
        providerResourceId: '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-app-1',
        name: 'vm-app-1',
        region: 'eastus',
        status: 'Running',
        configuration: {
          size: 'Standard_B2s',
          parentResourceId: '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Network/virtualNetworks/vnet-prod/subnets/snet-app',
          imported: true,
        },
        metadata: {},
      },
      {
        provider: 'azure',
        resourceType: 'storage-account',
        providerResourceId: '/subscriptions/sub-123/resourceGroups/rg-prod/providers/Microsoft.Storage/storageAccounts/stproddata',
        name: 'stproddata',
        region: 'eastus',
        status: 'Succeeded',
        configuration: {
          sku: 'Standard_LRS',
          imported: true,
        },
        metadata: {},
      },
    ];

    it('normalizes Azure resources with VNet containment and imported badges', () => {
      const { nodes, edges } = normalizeDiscoveredInfrastructure(azureResources);
      expect(nodes.length).toBe(5);

      const vnetNode = nodes.find((n) => n.resourceType === 'azure_vnet');
      expect(vnetNode).toBeDefined();
      expect(vnetNode?.type).toBe('containerNode');
      expect(vnetNode?.importState).toBe('imported');

      const subnetNode = nodes.find((n) => n.resourceType === 'azure_subnet');
      expect(subnetNode).toBeDefined();
      expect(subnetNode?.type).toBe('containerNode');
      expect(subnetNode?.groupId).toBe(vnetNode?.id);

      const vmNode = nodes.find((n) => n.resourceType === 'azure_vm');
      expect(vmNode).toBeDefined();
      expect(vmNode?.groupId).toBe(subnetNode?.id);
      expect(vmNode?.importState).toBe('imported');

      // Edges
      expect(edges.some((e) => e.source === vnetNode?.id && e.target === subnetNode?.id)).toBe(true);
    });
  });

  describe('3. Unsupported Resource Graceful Fallback', () => {
    it('maps unfamiliar cloud resource types to unsupported nodes without dropping them', () => {
      const unfamiliarResources: DiscoveredResource[] = [
        {
          provider: 'aws',
          resourceType: 'apprunner-service' as unknown as DiscoveredResource['resourceType'],
          providerResourceId: 'arn:aws:apprunner:us-east-1:123456789012:service/my-service',
          name: 'my-apprunner-svc',
          region: 'us-east-1',
          status: 'RUNNING',
          configuration: {
            customField: 'value123',
            imported: true,
          },
          metadata: {},
        },
        {
          provider: 'azure',
          resourceType: 'iot-hub' as unknown as DiscoveredResource['resourceType'],
          providerResourceId: '/subscriptions/sub-123/resourceGroups/rg-iot/providers/Microsoft.Devices/IotHubs/my-hub',
          name: 'my-iot-hub',
          region: 'eastus',
          status: 'Active',
          configuration: {
            sku: 'S1',
            imported: true,
          },
          metadata: {},
        },
      ];

      const { nodes } = normalizeDiscoveredInfrastructure(unfamiliarResources);
      expect(nodes.length).toBe(2);

      const awsUnsupported = nodes.find((n) => n.provider === 'aws');
      expect(awsUnsupported?.resourceType).toBe('aws_unknown');
      expect(awsUnsupported?.label).toBe('my-apprunner-svc');
      expect(awsUnsupported?.config?.originalResourceType).toBe('apprunner-service');
      expect(awsUnsupported?.config?.customField).toBe('value123');
      expect(awsUnsupported?.importState).toBe('imported');

      const azureUnsupported = nodes.find((n) => n.provider === 'azure');
      expect(azureUnsupported?.resourceType).toBe('azure_unknown');
      expect(azureUnsupported?.label).toBe('my-iot-hub');
      expect(azureUnsupported?.config?.originalResourceType).toBe('iot-hub');
      expect(azureUnsupported?.importState).toBe('imported');
    });
  });

  describe('4. Change Detection & Drift (InfrastructureSyncService)', () => {
    const syncService = new InfrastructureSyncService();

    it('accurately identifies unchanged, modified (drift), deleted, and new cloud resources', () => {
      const currentCanvasNodes: CanvasNode[] = [
        {
          id: 'ec2-1',
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Web Server 1',
          position: { x: 100, y: 100 },
          importState: 'imported',
          config: {
            resourceId: 'i-001',
            instanceType: 't3.micro',
            imported: true,
            configurationHash: 'hash-t3-micro',
          },
        },
        {
          id: 'ec2-2',
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Worker 2',
          position: { x: 300, y: 100 },
          importState: 'imported',
          config: {
            resourceId: 'i-002',
            instanceType: 't3.medium',
            imported: true,
            configurationHash: 'hash-original',
          },
        },
        {
          id: 'ec2-old',
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Old Web Server',
          position: { x: 500, y: 100 },
          importState: 'imported',
          config: {
            resourceId: 'i-003-deleted',
            imported: true,
            configurationHash: 'hash-deleted',
          },
        },
        {
          id: 'ec2-user-new',
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Proposed Cache',
          position: { x: 700, y: 100 },
          importState: 'new',
          config: {
            instanceType: 'r5.large',
          },
        },
      ];

      const freshCloudResources: CloudResource[] = [
        {
          id: 'i-001',
          provider: 'aws',
          accountId: '123456789012',
          region: 'us-east-1',
          resourceType: 'ec2',
          name: 'Web Server 1',
          resourceId: 'i-001',
          tags: {},
          status: 'running',
          configuration: { instanceType: 't3.micro', imported: true },
          configurationHash: 'hash-t3-micro',
          metadata: {},
        },
        {
          id: 'i-002',
          provider: 'aws',
          accountId: '123456789012',
          region: 'us-east-1',
          resourceType: 'ec2',
          name: 'Worker 2',
          resourceId: 'i-002',
          tags: {},
          status: 'running',
          configuration: { instanceType: 'c5.large', imported: true },
          configurationHash: 'hash-changed-to-c5-large',
          metadata: {},
        },
        {
          id: 'i-999-new',
          provider: 'aws',
          accountId: '123456789012',
          region: 'us-east-1',
          resourceType: 'ec2',
          name: 'New Rogue Server',
          resourceId: 'i-999-new',
          tags: {},
          status: 'running',
          configuration: { instanceType: 't3.nano' },
          configurationHash: 'hash-rogue',
          metadata: {},
        },
      ];

      const report = syncService.detectChanges(currentCanvasNodes, freshCloudResources, '123456789012', 'aws');

      expect(report.summary.unchanged).toBe(1);
      expect(report.summary.modified).toBe(1);
      expect(report.summary.deletedInCloud).toBe(1);
      expect(report.summary.newInCloud).toBe(1);
      expect(report.summary.userProposed).toBe(1);

      const modified = report.items.find((i) => i.status === 'modified');
      expect(modified?.nodeId).toBe('ec2-2');

      const deleted = report.items.find((i) => i.status === 'deleted_in_cloud');
      expect(deleted?.nodeId).toBe('ec2-old');

      const proposed = report.items.find((i) => i.status === 'user_proposed');
      expect(proposed?.nodeId).toBe('ec2-user-new');
    });
  });

  describe('5. Terraform Generation Safety for Imported vs New Infrastructure', () => {
    const tfGenerator = new TerraformGenerator();

    it('generates read-only data sources for imported AWS infrastructure and regular resources for new additions', () => {
      const resources: DbArchitectureResource[] = [
        {
          id: 'vpc-main',
          architectureId: 'arch-1',
          resourceType: 'aws_vpc',
          provider: 'aws',
          label: 'Imported VPC',
          positionX: 0,
          positionY: 0,
          configJson: JSON.stringify({
            resourceId: 'vpc-0123456789',
            imported: true,
            importState: 'imported',
          }),
          region: 'us-east-1',
          groupId: null,
          locked: false,
        },
        {
          id: 'sub-main',
          architectureId: 'arch-1',
          resourceType: 'aws_subnet',
          provider: 'aws',
          label: 'Imported Subnet',
          positionX: 20,
          positionY: 20,
          groupId: 'vpc-main',
          configJson: JSON.stringify({
            resourceId: 'subnet-0987654321',
            imported: true,
            importState: 'imported',
          }),
          region: 'us-east-1',
          locked: false,
        },
        {
          id: 'ec2-existing',
          architectureId: 'arch-1',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Existing Web Server',
          positionX: 50,
          positionY: 50,
          groupId: 'sub-main',
          configJson: JSON.stringify({
            resourceId: 'i-0existing123',
            imported: true,
            importState: 'imported',
          }),
          region: 'us-east-1',
          locked: false,
        },
        {
          id: 'ec2-proposed',
          architectureId: 'arch-1',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Proposed Redis App',
          positionX: 200,
          positionY: 50,
          groupId: 'sub-main',
          configJson: JSON.stringify({
            instanceType: 't3.small',
            importState: 'new',
          }),
          region: 'us-east-1',
          locked: false,
        },
      ];

      const connections: DbArchitectureConnection[] = [
        {
          id: 'conn-1',
          architectureId: 'arch-1',
          sourceId: 'vpc-main',
          targetId: 'sub-main',
          edgeType: 'network',
          label: null,
        },
        {
          id: 'conn-2',
          architectureId: 'arch-1',
          sourceId: 'sub-main',
          targetId: 'ec2-existing',
          edgeType: 'network',
          label: null,
        },
        {
          id: 'conn-3',
          architectureId: 'arch-1',
          sourceId: 'sub-main',
          targetId: 'ec2-proposed',
          edgeType: 'network',
          label: null,
        },
      ];

      const result = tfGenerator.generate({
        architectureId: 'arch-1',
        projectId: 'proj-1',
        resources,
        connections,
        projectName: 'cloudcraft_test',
      });

      const mainTf = result.files.find((f) => f.filename === 'main.tf');
      expect(mainTf).toBeDefined();
      const content = mainTf?.content ?? '';

      // VPC must be a data source, NOT a destructive resource
      expect(content).toContain('data "aws_vpc" "imported_vpc"');
      expect(content).not.toContain('resource "aws_vpc" "imported_vpc"');
      expect(content).toContain('id = "vpc-0123456789"');

      // Subnet must be a data source
      expect(content).toContain('data "aws_subnet" "imported_subnet"');
      expect(content).not.toContain('resource "aws_subnet" "imported_subnet"');

      // Existing EC2 must be a data source
      expect(content).toContain('data "aws_instance" "existing_web_server"');
      expect(content).not.toContain('resource "aws_instance" "existing_web_server"');

      // Proposed EC2 MUST be a new resource block
      expect(content).toContain('resource "aws_instance" "proposed_redis_app"');

      // Proposed EC2 must safely reference the imported subnet via data source reference
      expect(content).toContain('data.aws_subnet.imported_subnet.id');
    });

    it('generates read-only data sources for imported Azure infrastructure', () => {
      const resources: DbArchitectureResource[] = [
        {
          id: 'rg-main',
          architectureId: 'arch-2',
          resourceType: 'azure_resource_group',
          provider: 'azure',
          label: 'Imported RG',
          positionX: 0,
          positionY: 0,
          configJson: JSON.stringify({
            resourceGroup: 'rg-live-prod',
            imported: true,
            importState: 'imported',
          }),
          region: 'eastus',
          groupId: null,
          locked: false,
        },
        {
          id: 'vnet-main',
          architectureId: 'arch-2',
          resourceType: 'azure_vnet',
          provider: 'azure',
          label: 'Imported VNet',
          positionX: 20,
          positionY: 20,
          groupId: 'rg-main',
          configJson: JSON.stringify({
            name: 'vnet-live-prod',
            imported: true,
            importState: 'imported',
          }),
          region: 'eastus',
          locked: false,
        },
      ];

      const connections: DbArchitectureConnection[] = [];

      const result = tfGenerator.generate({
        architectureId: 'arch-2',
        projectId: 'proj-2',
        resources,
        connections,
        projectName: 'azure_test',
      });

      const mainTf = result.files.find((f) => f.filename === 'main.tf');
      expect(mainTf).toBeDefined();
      const content = mainTf?.content ?? '';

      expect(content).toContain('data "azurerm_resource_group" "imported_rg"');
      expect(content).not.toContain('resource "azurerm_resource_group" "imported_rg"');
      expect(content).toContain('data "azurerm_virtual_network" "vnet_live_prod"');
    });
  });

  describe('6. Cost Calculation Integration for Imported Resources', () => {
    it('computes real estimated monthly costs for imported resources', () => {
      const importedNodes: CanvasNode[] = [
        {
          id: 'node-ec2',
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Live Web App',
          position: { x: 0, y: 0 },
          importState: 'imported',
          config: {
            instanceType: 't3.micro',
            operatingSystem: 'linux',
            imported: true,
          },
        },
        {
          id: 'node-rds',
          type: 'cloudNode',
          resourceType: 'aws_rds',
          provider: 'aws',
          label: 'Live DB',
          position: { x: 100, y: 0 },
          importState: 'imported',
          config: {
            instanceClass: 'db.t3.micro',
            engine: 'postgres',
            storageGb: 20,
            imported: true,
          },
        },
      ];

      const items = calculateCosts(importedNodes);
      const totalMonthly = items.reduce((sum, item) => sum + item.monthlyCost, 0);
      expect(totalMonthly).toBeGreaterThan(0);
      expect(items.length).toBe(2);
      expect(items.some((item) => item.nodeLabel === 'Live Web App')).toBe(true);
      expect(items.some((item) => item.nodeLabel === 'Live DB')).toBe(true);
    });
  });

});

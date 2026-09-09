import { CanvasNode, CanvasEdge, CloudProvider } from '@/types';

export interface ImportedResource {
  id: string;
  name: string;
  type: string;
  provider: 'aws' | 'azure';
  region: string;
  status: 'running' | 'stopped' | 'available';
  tags: Record<string, string>;
}

export interface ImportResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  importedCount: number;
  skippedCount: number;
  errors: string[];
}

// ─── Interface ────────────────────────────────────────────────────────────────
export interface IImportService {
  discover(provider: CloudProvider, region: string): Promise<ImportedResource[]>;
  importResources(resources: ImportedResource[]): Promise<ImportResult>;
}

// ─── Mock Implementation ──────────────────────────────────────────────────────
const MOCK_AWS: ImportedResource[] = [
  { id: 'i-abc123', name: 'web-server-1',  type: 'aws_ec2',    provider: 'aws', region: 'us-east-1', status: 'running',   tags: { Environment: 'production', Team: 'platform' } },
  { id: 'i-def456', name: 'api-server-1',  type: 'aws_ec2',    provider: 'aws', region: 'us-east-1', status: 'running',   tags: { Environment: 'production' } },
  { id: 'rds-001',  name: 'main-database', type: 'aws_rds',    provider: 'aws', region: 'us-east-1', status: 'available', tags: { Environment: 'production' } },
  { id: 's3-001',   name: 'assets-bucket', type: 'aws_s3',     provider: 'aws', region: 'us-east-1', status: 'available', tags: {} },
  { id: 'vpc-001',  name: 'main-vpc',      type: 'aws_vpc',    provider: 'aws', region: 'us-east-1', status: 'available', tags: {} },
];

const MOCK_AZURE: ImportedResource[] = [
  { id: 'vm-001', name: 'web-vm-1',       type: 'azure_vm',      provider: 'azure', region: 'eastus', status: 'running',   tags: {} },
  { id: 'vm-002', name: 'app-vm-1',       type: 'azure_vm',      provider: 'azure', region: 'eastus', status: 'running',   tags: {} },
  { id: 'sql-001',name: 'prod-database',  type: 'azure_sql',     provider: 'azure', region: 'eastus', status: 'available', tags: {} },
  { id: 'st-001', name: 'data-storage',   type: 'azure_storage', provider: 'azure', region: 'eastus', status: 'available', tags: {} },
];

class MockImportService implements IImportService {
  async discover(provider: CloudProvider, _region: string): Promise<ImportedResource[]> {
    await new Promise((r) => setTimeout(r, 1200));
    return provider === 'azure' ? MOCK_AZURE : MOCK_AWS;
  }

  async importResources(resources: ImportedResource[]): Promise<ImportResult> {
    await new Promise((r) => setTimeout(r, 800));
    const nodes: CanvasNode[] = resources.map((r, i) => ({
      id: `imported-${r.id}`,
      type: 'cloudNode',
      resourceType: r.type,
      provider: r.provider,
      label: r.name,
      position: { x: 100 + (i % 4) * 180, y: 100 + Math.floor(i / 4) * 140 },
      config: { name: r.name, region: r.region, ...r.tags },
    }));
    return { nodes, edges: [], importedCount: nodes.length, skippedCount: 0, errors: [] };
  }
}

export const importService: IImportService = new MockImportService();

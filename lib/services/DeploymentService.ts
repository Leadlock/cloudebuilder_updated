import { CanvasNode } from '@/types';

export type DeployStatus = 'pending' | 'running' | 'success' | 'failed';

export interface DeployStep {
  id: string;
  label: string;
  description: string;
  status: DeployStatus;
  output?: string;
  provider?: 'aws' | 'azure';
}

export interface DeployResult {
  success: boolean;
  steps: DeployStep[];
  duration: number;
}

// ─── Interface ────────────────────────────────────────────────────────────────
export interface IDeploymentService {
  runPipeline(
    nodes: CanvasNode[],
    provider: 'aws' | 'azure',
    onStepUpdate: (step: DeployStep) => void,
  ): Promise<DeployResult>;
}

// ─── Mock Implementation ──────────────────────────────────────────────────────
const AWS_PIPELINE: Omit<DeployStep, 'status'>[] = [
  { id: 'validate', label: 'Validate Architecture', description: 'Check resource configurations', provider: 'aws' },
  { id: 'security', label: 'Security Scan',          description: 'Identify security issues',        provider: 'aws' },
  { id: 'plan',     label: 'Terraform Plan',          description: 'Generate execution plan',         provider: 'aws' },
  { id: 'deploy',   label: 'Deploy',                  description: 'Apply changes to environment',    provider: 'aws' },
];

const AZURE_PIPELINE: Omit<DeployStep, 'status'>[] = [
  { id: 'az-validate', label: 'Validate (Azure)', description: 'Validate Azure configurations', provider: 'azure' },
  { id: 'az-plan',     label: 'ARM/Bicep Plan',   description: 'Generate ARM template',          provider: 'azure' },
  { id: 'az-deploy',   label: 'Deploy (Azure)',   description: 'Apply Azure deployments',        provider: 'azure' },
];

class MockDeploymentService implements IDeploymentService {
  async runPipeline(
    _nodes: CanvasNode[],
    provider: 'aws' | 'azure',
    onStepUpdate: (step: DeployStep) => void,
  ): Promise<DeployResult> {
    const pipeline = provider === 'azure' ? AZURE_PIPELINE : AWS_PIPELINE;
    const steps: DeployStep[] = pipeline.map((s) => ({ ...s, status: 'pending' }));
    const start = Date.now();

    for (let i = 0; i < steps.length; i++) {
      steps[i] = { ...steps[i], status: 'running' };
      onStepUpdate({ ...steps[i] });
      await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
      steps[i] = { ...steps[i], status: 'success', output: `✓ ${steps[i].label} completed successfully` };
      onStepUpdate({ ...steps[i] });
    }

    return { success: true, steps, duration: Date.now() - start };
  }
}

export const deploymentService: IDeploymentService = new MockDeploymentService();

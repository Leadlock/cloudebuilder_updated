/**
 * The infrastructure step of a release, with the existing Terraform machinery: the plan is made and stored for approval exactly like any other
 * plan (state backend, no destroy, safety checks), and the apply is the same worker code. What a release adds is reading Terraform's outputs
 * afterwards, so the later steps know which registry, vault and VM were created.
 */
import { generateKeyPairSync } from 'crypto';
import { planBundle, runApply } from '@/lib/terraform/execution/TerraformExecutionService';
import { runTerraform } from '@/lib/terraform/execution/cli';
import type { PlanRecord, TerraformStateBackendConfig } from '@/lib/terraform/execution/types';
import { buildAzureVmBundle, type ProjectBundle } from './bundle';
import type { InfraRunner } from './orchestrator';
import type { ReleaseOutputs } from './types';
import type { StackProject } from '@/lib/engines/containers/stackProject';

/**
 * A public key in the OpenSSH format. Azure insists on one for a Linux VM; the matching private key is never kept (it is discarded here), so
 * nobody can sign in over SSH. A new one is made for every plan; the VM ignores later changes to it.
 */
export function throwawayPublicKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return `ssh-ed25519 ${Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]).toString('base64')}`;
}

export interface PlanReleaseInput {
  projectId: string; orgId: string; environment: string; cloudAccountId: string;
  stateBackend: TerraformStateBackendConfig;
  user: { id: string; name: string; email: string; role: string };
  project: StackProject;
}

/** Generates the project's files on the server and plans their Terraform. */
export async function planRelease(input: PlanReleaseInput, planner: typeof planBundle = planBundle): Promise<{ bundle: ProjectBundle; plan: PlanRecord }> {
  const bundle = buildAzureVmBundle(input.project);
  const plan = await planner({
    projectId: input.projectId, orgId: input.orgId, environment: input.environment, cloudAccountId: input.cloudAccountId, stateBackend: input.stateBackend, user: input.user,
    files: bundle.terraform.filter((f) => f.filename.endsWith('.tf') || f.filename === 'cloud-init.sh' || f.filename === 'compose.deploy.yml'),
    notes: bundle.warnings, provider: 'azure',
    extraEnv: { TF_VAR_admin_ssh_public_key: throwawayPublicKey() },
  });
  return { bundle, plan };
}

type TfOutput = Record<string, { value?: unknown }>;

/** What a release needs from Terraform's outputs. */
export function outputsFrom(json: string): ReleaseOutputs {
  let parsed: TfOutput;
  try { parsed = JSON.parse(json) as TfOutput; } catch { throw new Error('Terraform did not report what it created.'); }
  const text = (k: string, required: boolean) => {
    const v = parsed[k]?.value;
    if (typeof v === 'string' && v !== '') return v;
    if (required) throw new Error(`Terraform did not report ${k}.`);
    return '';
  };
  return { resourceGroup: text('resource_group', true), vmName: text('vm_name', true), acrName: text('acr_name', false), vaultName: text('vault_name', true), url: text('app_url', true) };
}

export interface InfraDeps {
  runApply: typeof runApply;
  runTerraform: typeof runTerraform;
}

export function createTerraformInfraRunner(deps: InfraDeps = { runApply, runTerraform }): InfraRunner {
  return {
    async apply(release, onOutput) {
      if (!release.planId) throw new Error('This release has no plan to apply.');
      let outputs: ReleaseOutputs | null = null;
      await deps.runApply(release.planId, release.orgId, (chunk) => {
        for (const line of chunk.split('\n')) if (line.trim()) onOutput(line.trim().slice(0, 300));
      }, async ({ workDir, env }) => {
        const { stdout } = await deps.runTerraform(['output', '-json', '-no-color'], { cwd: workDir, env });
        outputs = outputsFrom(stdout);
      });
      if (!outputs) throw new Error('Terraform finished but did not report what it created.');
      return outputs;
    },
  };
}

/**
 * The infrastructure step of a release, with the existing Terraform machinery: the plan is made and stored for approval exactly like any other
 * plan (state backend, no destroy, safety checks), and the apply is the same worker code. What a release adds is reading Terraform's outputs
 * afterwards, so the later steps know which registry, vault and VM were created.
 */
import { generateKeyPairSync } from 'crypto';
import { planBundle, runApply } from '@/lib/terraform/execution/TerraformExecutionService';
import { runTerraform } from '@/lib/terraform/execution/cli';
import type { PlanRecord, TerraformStateBackendConfig } from '@/lib/terraform/execution/types';
import { buildBundle, type ProjectBundle, type SourceInput } from './bundle';
import type { InfraRunner } from './orchestrator';
import type { ReleaseOutputs, ReleaseTarget } from './types';
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

export const providerOf = (target: ReleaseTarget): 'aws' | 'azure' => (target === 'azure-vm' ? 'azure' : 'aws');

/** The files Terraform needs from a bundle: its .tf files, and the two a configuration reads (the start-up script, the compose file). Never the generated deploy scripts or notes. */
export function terraformFiles(bundle: ProjectBundle): Array<{ filename: string; content: string }> {
  const read = bundle.target === 'ec2' ? ['user_data.sh', 'compose.deploy.yml'] : bundle.target === 'ecs' ? [] : ['cloud-init.sh', 'compose.deploy.yml'];
  return bundle.terraform.filter((f) => f.filename.endsWith('.tf') || read.includes(f.filename));
}

export interface PlanReleaseInput {
  projectId: string; orgId: string; environment: string; cloudAccountId: string;
  stateBackend: TerraformStateBackendConfig;
  user: { id: string; name: string; email: string; role: string };
  project: StackProject;
  /** Code the person uploaded for services built from it. */
  sources?: Record<string, SourceInput>;
}

/** Generates the project's files on the server and plans their Terraform. */
export async function planRelease(input: PlanReleaseInput, planner: typeof planBundle = planBundle): Promise<{ bundle: ProjectBundle; plan: PlanRecord }> {
  const bundle = buildBundle(input.project, input.sources);
  const plan = await planner({
    projectId: input.projectId, orgId: input.orgId, environment: input.environment, cloudAccountId: input.cloudAccountId, stateBackend: input.stateBackend, user: input.user,
    files: terraformFiles(bundle), notes: bundle.warnings, provider: providerOf(bundle.target),
    ...(bundle.target === 'azure-vm' ? { extraEnv: { TF_VAR_admin_ssh_public_key: throwawayPublicKey() } } : {}),
  });
  return { bundle, plan };
}

type TfOutput = Record<string, { value?: unknown }>;

/** What a release needs from Terraform's outputs. */
export function outputsFrom(json: string, target: ReleaseTarget = 'azure-vm'): ReleaseOutputs {
  let parsed: TfOutput;
  try { parsed = JSON.parse(json) as TfOutput; } catch { throw new Error('Terraform did not report what it created.'); }
  const text = (k: string, required: boolean) => {
    const v = parsed[k]?.value;
    if (typeof v === 'string' && v !== '') return v;
    if (required) throw new Error(`Terraform did not report ${k}.`);
    return '';
  };
  if (target === 'ecs') {
    const built = parsed['codebuild_project'] !== undefined;
    const services = parsed['services']?.value;
    if (!Array.isArray(services) || services.length === 0 || !services.every((x) => typeof x === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(x))) throw new Error('Terraform did not report services.');
    const count = parsed['desired_count']?.value;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) throw new Error('Terraform did not report desired_count.');
    return {
      kind: 'ecs', region: text('region', true), cluster: text('cluster', true), services: services as string[], desiredCount: count, registry: text('registry', true), ssmPrefix: text('ssm_prefix', true), url: text('app_url', true),
      sourceBucket: text('source_bucket', built), codebuildProject: text('codebuild_project', built),
    };
  }
  if (target === 'ec2') {
    const built = parsed['codebuild_project'] !== undefined;
    return {
      kind: 'ec2', region: text('region', true), instanceId: text('instance_id', true), releaseBucket: text('release_bucket', true), registry: text('registry', true), ssmPrefix: text('ssm_prefix', true), url: text('app_url', true),
      sourceBucket: text('source_bucket', built), codebuildProject: text('codebuild_project', built),
    };
  }
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
        outputs = outputsFrom(stdout, release.target);
      });
      if (!outputs) throw new Error('Terraform finished but did not report what it created.');
      return outputs;
    },
  };
}

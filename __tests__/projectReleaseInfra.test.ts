/**
 * The infrastructure of a release: the throw-away SSH key Azure insists on, what is handed to the Terraform planner, and how Terraform's outputs
 * become what the later steps use.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({ planBundle: jest.fn(), runApply: jest.fn() }));
jest.mock('@/lib/terraform/execution/cli', () => ({ runTerraform: jest.fn() }));

import { defaultProject, LAYERS, type StackProject } from '@/lib/engines/containers/stackProject';
import type { AzureOutputs } from '@/lib/deploy/project/types';
import type { PlanBundleInput } from '@/lib/terraform/execution/TerraformExecutionService';
import { createTerraformInfraRunner, outputsFrom, planRelease, throwawayPublicKey } from '@/lib/deploy/project/infra';
import { buildAzureVmBundle } from '@/lib/deploy/project/bundle';
import { newRelease } from '@/lib/deploy/project/orchestrator';

function project(): StackProject {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = true;
  p.deploy.target = 'azure-vm';
  return p;
}

describe('the throw-away SSH key', () => {
  test('is a public key the real ssh-keygen accepts, as ed25519, and differs every time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'key-'));
    try {
      const key = throwawayPublicKey();
      expect(key).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/);
      writeFileSync(join(dir, 'k.pub'), `${key}\n`);
      const r = spawnSync('ssh-keygen', ['-l', '-f', join(dir, 'k.pub')], { encoding: 'utf8' });
      expect({ status: r.status, out: r.stdout.trim().split(' ').slice(0, 1).concat(r.stdout.trim().split(' ').slice(-1)) }).toEqual({ status: 0, out: ['256', '(ED25519)'] });
      expect(throwawayPublicKey()).not.toBe(key);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('planning a release', () => {
  const input = { projectId: 'p1', orgId: 'o1', environment: 'production', cloudAccountId: 'a1', user: { id: 'u', name: 'U', email: 'u@x.io', role: 'admin' }, stateBackend: { provider: 'azure' as const, resourceGroupName: 'rg', storageAccountName: 'sa', containerName: 'c', key: 'k' }, project: project() };

  test('hands the planner the files the server generated, an Azure target and the key, and never the generated scripts', async () => {
    const holder: { input?: PlanBundleInput } = {};
    const out = await planRelease(input, async (i) => { holder.input = i; return { planId: 'pl', planHash: 'h' } as never; });
    const seen = holder.input!;
    expect(out.bundle.bundleHash).toBe(buildAzureVmBundle(input.project).bundleHash);
    expect(seen.provider).toBe('azure');
    expect(seen.files.map((f) => f.filename).sort()).toEqual(['cloud-init.sh', 'compose.deploy.yml', 'main.tf', 'outputs.tf', 'variables.tf']);
    expect(seen.extraEnv!['TF_VAR_admin_ssh_public_key']).toMatch(/^ssh-ed25519 /);
    expect(seen.stateBackend).toEqual(input.stateBackend);
    expect(seen.files.some((f) => f.filename === 'deploy.sh' || f.filename === 'destroy.sh' || f.filename.endsWith('.md'))).toBe(false);
  });

  test('a project that cannot be deployed is refused before anything is planned', async () => {
    const p = project(); p.name = 'bad_name';
    let called = false;
    await expect(planRelease({ ...input, project: p }, async () => { called = true; return {} as never; })).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe('what Terraform created', () => {
  const ALL = JSON.stringify({
    resource_group: { value: 'rg-shop' }, vm_name: { value: 'vm-shop' }, acr_name: { value: 'acrshop' }, vault_name: { value: 'kvshop' }, app_url: { value: 'http://203.0.113.9:8080/' }, public_ip: { value: '203.0.113.9' }, logs: { value: 'az vm run-command …' },
  });

  test('is read from its outputs', () => {
    expect(outputsFrom(ALL)).toEqual({ resourceGroup: 'rg-shop', vmName: 'vm-shop', acrName: 'acrshop', vaultName: 'kvshop', url: 'http://203.0.113.9:8080/' });
  });
  test('a project with nothing built has no registry, which is fine', () => {
    const o = JSON.parse(ALL); delete o.acr_name;
    expect((outputsFrom(JSON.stringify(o)) as AzureOutputs).acrName).toBe('');
  });
  test.each(['resource_group', 'vm_name', 'vault_name', 'app_url'])('without %s the step fails with that name', (k) => {
    const o = JSON.parse(ALL); delete o[k];
    expect(() => outputsFrom(JSON.stringify(o))).toThrow(`Terraform did not report ${k}.`);
  });
  test('output that is not JSON is a failure, not an empty result', () => {
    expect(() => outputsFrom('not json')).toThrow(/did not report what it created/);
  });

  test('the runner applies the stored plan of the release, reads the outputs while the folder still exists, and passes progress lines on', async () => {
    const p = project();
    const bundle = buildAzureVmBundle(p);
    const release = newRelease({ id: 'r1', orgId: 'o1', projectId: 'p1', environment: 'production', cloudAccountId: 'acct-1', project: p, bundle, createdBy: 'u', previousReleaseId: null, planId: 'plan-9', planHash: 'h', now: 1 });
    const lines: string[] = []; const seen: string[] = [];
    const runner = createTerraformInfraRunner({
      runApply: async (planId, orgId, onOutput, after) => { seen.push(`${planId} ${orgId}`); onOutput?.('azurerm_resource_group.app: Creating...\n\nazurerm_resource_group.app: Creation complete\n'); await after!({ workDir: '/work', env: { A: 'b' } }); return { message: 'ok', outputTail: '' }; },
      runTerraform: async (args, o) => { seen.push(`${args.join(' ')} @${o.cwd}`); return { stdout: ALL, stderr: '' }; },
    });
    const out = await runner.apply(release, (l) => lines.push(l));
    expect((out as AzureOutputs).vaultName).toBe('kvshop');
    expect(seen).toEqual(['plan-9 o1', 'output -json -no-color @/work']);
    expect(lines).toEqual(['azurerm_resource_group.app: Creating...', 'azurerm_resource_group.app: Creation complete']);
  });

  test('a release without a plan, or an apply that reports nothing, fails', async () => {
    const p = project();
    const release = newRelease({ id: 'r1', orgId: 'o1', projectId: 'p1', environment: 'production', cloudAccountId: 'acct-1', project: p, bundle: buildAzureVmBundle(p), createdBy: 'u', previousReleaseId: null, now: 1 });
    await expect(createTerraformInfraRunner().apply(release, () => undefined)).rejects.toThrow(/no plan to apply/);
    const quiet = createTerraformInfraRunner({ runApply: async () => ({ message: '', outputTail: '' }), runTerraform: async () => ({ stdout: '', stderr: '' }) });
    await expect(quiet.apply({ ...release, planId: 'x' }, () => undefined)).rejects.toThrow(/did not report what it created/);
  });
});

/**
 * Dedicated CLI script to safely destroy infrastructure provisioned by CloudBuilder.
 *
 * Usage:
 *   npx tsx scripts/destroy-infrastructure.ts
 *   or: npm run terraform:destroy
 */
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { resolveExecutionCredentials } from '../lib/cloud/credentials/resolveExecutionCredentials';
import { cloudAccountRepository } from '../lib/repositories/cloudAccountRepository';
import { renderBackendConfig } from '../lib/terraform/execution/backendConfig';
import { terraformGenerator } from '../lib/engines/terraform/TerraformGenerator';
import { orgRepository } from '../lib/repositories/orgRepository';
import { projectRepository, environmentRepository } from '../lib/repositories/projectRepository';
import { architectureRepository } from '../lib/repositories/architectureRepository';
import { mockProjects } from '../lib/mockData';
import { ensureTerraform } from '../lib/terraform/execution/binary';
import fs from 'fs';
import path from 'path';

function runCommandStream(binary: string, args: string[], cwd: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const binDir = path.dirname(binary);
    const currentPath = process.env['PATH'] ?? '';
    const fullPath = binDir !== '.' ? `${binDir}${path.delimiter}${currentPath}` : currentPath;

    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, PATH: fullPath, ...env },
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

async function main() {
  console.log('====================================================');
  console.log('  CloudBuilder Infrastructure Teardown / Destroy Tool ');
  console.log('====================================================\n');

  // 1. Get Dev Context & Accounts
  let orgId = 'dev-org-id';
  try {
    const ctx = await orgRepository.ensureDevContext();
    orgId = ctx.orgId;
  } catch {}

  const accounts = await cloudAccountRepository.list(orgId);
  const awsAccount = accounts.find((a) => a.provider === 'aws') || accounts[0];

  if (!awsAccount) {
    console.error('❌ Error: No connected AWS cloud account found.');
    process.exit(1);
  }

  const credentialsJson = await cloudAccountRepository.getCredentials(awsAccount.id, orgId);
  if (!credentialsJson) {
    console.error('❌ Error: Credentials for cloud account not found.');
    process.exit(1);
  }

  const credentials = JSON.parse(credentialsJson);
  console.log(`🔐 Resolving credentials for: ${awsAccount.name} (${awsAccount.id}) ...`);
  const envVars = await resolveExecutionCredentials(credentials);

  // 2. Resolve architecture resources
  const mock = mockProjects[0];
  const mockEnv = mock.environments.production;
  const dbResources = mockEnv.nodes.map((n) => ({
    id: n.id,
    resourceType: n.resourceType,
    provider: n.provider,
    label: n.label,
    positionX: n.position.x,
    positionY: n.position.y,
    configJson: JSON.stringify(n.config || {}),
    region: n.region || mock.region || 'us-east-1',
    groupId: n.groupId || null,
    locked: n.locked || false,
    architectureId: `arch-${mock.id}`,
  }));
  const dbConnections = mockEnv.edges.map((e) => ({
    id: e.id,
    sourceId: e.source,
    targetId: e.target,
    label: e.label || null,
    edgeType: e.edgeType || 'network',
    architectureId: `arch-${mock.id}`,
  }));

  const tfResult = terraformGenerator.generate({
    architectureId: `arch-${mock.id}`,
    projectId: mock.id,
    resources: dbResources,
    connections: dbConnections,
    projectName: mock.name.replace(/\s+/g, '-').toLowerCase(),
  });

  // 3. Prepare workspace with remote backend
  const workDir = await mkdtemp(join(tmpdir(), 'cloudbuilder-destroy-'));
  const tfBinary = await ensureTerraform({ log: (l) => console.log(l) });

  try {
    for (const f of tfResult.files) {
      await writeFile(join(workDir, f.filename), f.content, 'utf-8');
    }

    const backendHcl = renderBackendConfig({
      provider: 'aws',
      bucket: 'cloudraft-test',
      key: 'cloudbuilder/terraform.tfstate',
      region: 'eu-north-1',
    });
    await writeFile(join(workDir, 'backend.tf'), backendHcl, 'utf-8');

    console.log(`\n📁 Prepared Terraform workspace in: ${workDir}`);
    console.log('🔄 Initializing Terraform with remote S3 state backend...');

    const initCode = await runCommandStream(tfBinary, ['init', '-no-color'], workDir, envVars);
    if (initCode !== 0) {
      console.error(`❌ terraform init failed with exit code ${initCode}`);
      process.exit(initCode);
    }

    console.log('\n💥 Running `terraform destroy -auto-approve` against live AWS...\n');
    const destroyCode = await runCommandStream(tfBinary, ['destroy', '-auto-approve', '-no-color'], workDir, envVars);

    if (destroyCode === 0) {
      console.log('\n✅ All infrastructure resources have been successfully destroyed from AWS!');
    } else {
      console.error(`\n❌ terraform destroy exited with code ${destroyCode}`);
    }
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('Fatal error during destroy:', err);
  process.exit(1);
});

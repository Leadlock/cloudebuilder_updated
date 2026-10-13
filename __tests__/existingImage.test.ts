/**
 * Running an image that already exists (nginx:1.27, ghcr.io/you/app:1.0): nothing is built, no registry is created, and every deployment target
 * runs the image as it is. Terraform for each is validated by scripts/validate-containers.ts in CI.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import { checkContainer } from '@/lib/engines/containers/checks';
import { defaultConfig, generateContainerFiles, validate, withDeployTarget, type ContainerConfig, type DeployTarget } from '@/lib/engines/containers/dockerTemplates';
import { imageIsFloating, validateExistingImage } from '@/lib/engines/containers/existingImage';
import { estimateAksCost } from '@/lib/engines/containers/aksDeploy';
import { estimateAcaCost } from '@/lib/engines/containers/containerAppsDeploy';
import { estimateAzVmCost } from '@/lib/engines/containers/azureVmDeploy';
import { containerConfigFromAcaNode, containerConfigFromAzureNode, containerConfigFromNode, nodeConfigFromContainerFor, acaNodeConfigFromContainer } from '@/lib/engines/containers/nodeConfig';
import { parseStoredConfig } from '@/lib/engines/containers/stored';

const IMG = 'ghcr.io/acme/orders-api:1.4.2';
const base = (over: Partial<ContainerConfig> = {}): ContainerConfig => ({
  ...defaultConfig('node'), appName: 'orders-api', port: 8080, healthPath: '/health', image: IMG,
  env: [{ key: 'LOG_LEVEL', value: 'info' }, { key: 'API_TOKEN', value: '', secret: true }], ...over,
});
const on = (t: DeployTarget, over?: (c: ContainerConfig) => void): ContainerConfig => { const c = withDeployTarget(base(), t); over?.(c); return c; };
function gen(c: ContainerConfig) {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { ...r, by: Object.fromEntries(r.files.map((f) => [f.path, f.content])) as Record<string, string> };
}
const errs = (c: ContainerConfig) => validate(c).join(' | ');
const balanced = (t: string) => (t.match(/\{/g) ?? []).length === (t.match(/\}/g) ?? []).length;
function shOk(script: string): boolean {
  const d = mkdtempSync(join(tmpdir(), 'sh-'));
  try { const f = join(d, 's.sh'); writeFileSync(f, script); return spawnSync('bash', ['-n', f]).status === 0; } finally { rmSync(d, { recursive: true, force: true }); }
}
const ALL = ['ec2', 'ecs', 'azure-vm', 'container-apps', 'aks', 'kubernetes'] as const;

describe('which images are accepted', () => {
  it.each(['nginx', 'nginx:1.27', 'ghcr.io/acme/app:1.0', 'quay.io/org/tool@sha256:' + 'a'.repeat(64), 'localhost:5000/team/app:v2', 'public.ecr.aws/nginx/nginx:1.27', 'mcr.microsoft.com/dotnet/aspnet:9.0'])('%s', (i) => {
    expect(validateExistingImage(i)).toEqual([]);
  });
  it.each(['Nginx:1.27', 'my image', 'nginx:1.27; rm -rf /', 'nginx:1.27 && x', '$(whoami)', 'a'.repeat(300), 'img:tag"', "img:'tag"])('refuses %s', (i) => {
    expect(validateExistingImage(i)).toHaveLength(1);
  });
  it('explains why a private AWS or Azure registry is refused, and what to do instead', () => {
    for (const i of ['123456789012.dkr.ecr.us-east-1.amazonaws.com/app:1', 'myreg.azurecr.io/app:1', '123456789012.dkr.ecr-fips.us-gov-west-1.amazonaws.com/a:1']) {
      expect(validateExistingImage(i)[0]).toMatch(/private AWS \(ECR\) or Azure \(ACR\) registry[\s\S]*build from source/);
    }
  });
  it('knows an image with no version', () => {
    for (const i of ['nginx', 'nginx:latest', 'ghcr.io/a/b', 'localhost:5000/app']) expect(imageIsFloating(i)).toBe(true);
    for (const i of ['nginx:1.27', 'a/b:v1', 'x@sha256:' + 'b'.repeat(64)]) expect(imageIsFloating(i)).toBe(false);
  });
  it('is checked in the form: empty means build from source, a bad one stops the files', () => {
    expect(errs(base({ image: '' }))).toBe('');
    expect(errs(base({ image: 'Bad Image' }))).toMatch(/Image: use the name Docker uses/);
    expect(generateContainerFiles(base({ image: 'myreg.azurecr.io/x:1' })).ok).toBe(false);
  });
  it('a configuration saved before this existed still loads, building from source', () => {
    const old = JSON.parse(JSON.stringify(defaultConfig('node'))) as Record<string, unknown>;
    delete old['image'];
    expect(parseStoredConfig(JSON.stringify(old))!.image).toBe('');
  });
});

describe('the files without a build', () => {
  it('no Dockerfile, ignore file, nginx config or sample app; compose runs the image; the README says so', () => {
    const { by } = gen({ ...defaultConfig('static'), appName: 'orders-api', image: IMG, includeSample: true });
    for (const f of ['Dockerfile', '.dockerignore', 'nginx.conf', 'package.json', 'public/index.html']) expect(by[f]).toBeUndefined();
    const svc = parse(by['docker-compose.yml']!).services['orders-api'];
    expect(svc.image).toBe(IMG);
    expect(svc.build).toBeUndefined();
    expect(by['docker-compose.yml']).toMatch(/^# Run with: docker compose up$/m);
    expect(by['README.md']).toContain(`Image: \`${IMG}\``);
    expect(by['README.md']).not.toContain('Before you build');
    expect(by['README.md']).toContain(`docker run --rm -p 8080:8080 --env-file .env ${IMG}`);
    expect(by['README.md']).not.toContain('docker build');
  });
  it('building from source still gives all of them', () => {
    const { by } = gen(base({ image: '' }));
    for (const f of ['Dockerfile', '.dockerignore']) expect(by[f]).toBeDefined();
    expect(parse(by['docker-compose.yml']!).services['orders-api'].build).toBe('.');
  });
  it('the proxy waits for the app to start, not to be healthy: a ready-made image may have no health check', () => {
    const y = parse(gen(base({ proxy: true, proxyDomain: 'app.example.com' })).by['docker-compose.yml']!);
    expect(y.services.proxy.depends_on['orders-api'].condition).toBe('service_started');
    expect(parse(gen(base({ image: '', proxy: true, proxyDomain: 'app.example.com' })).by['docker-compose.yml']!).services.proxy.depends_on['orders-api'].condition).toBe('service_healthy');
  });
  it('an unpinned image is reported, and so is the fact that nothing scans a ready-made image', () => {
    const f = (c: ContainerConfig) => checkContainer(c, gen(c).files).map((x) => x.id);
    expect(f(base({ image: 'nginx' }))).toEqual(expect.arrayContaining(['CT-027', 'CT-028']));
    expect(f(base())).toContain('CT-028');
    expect(f(base())).not.toContain('CT-027');
    // none of the Dockerfile findings can appear: there is no Dockerfile
    expect(f(base()).filter((i) => ['CT-001', 'CT-002', 'CT-003', 'CT-004', 'CT-005'].includes(i))).toEqual([]);
    expect(gen(base({ image: 'nginx:latest' })).warnings.join(' ')).toMatch(/no version tag/);
  });
});

describe.each(ALL)('%s runs the image as it is', (t) => {
  const files = (over?: (c: ContainerConfig) => void) => gen(on(t, over)).by;
  const scripts = (f: Record<string, string>) => Object.entries(f).filter(([p]) => /\.sh$/.test(p) && !/(user_data|cloud-init)\.sh$/.test(p));

  it('writes valid scripts that never need Docker and never build or push anything', () => {
    const f = files();
    for (const [p, text] of scripts(f)) {
      expect([p, shOk(text)]).toEqual([p, true]);
      expect(text).not.toMatch(/docker (build|push|buildx|login)|az acr (build|login)|aws ecr|need docker/);
    }
    expect(f['deploy.sh']).toContain('set -euo pipefail');
  });
  it('has no build pipeline: no workflow, and no OIDC role for one', () => {
    const f = files((c) => { c.ec2.githubRepo = 'acme/orders'; c.ecs.githubRepo = 'acme/orders'; c.azvm.githubRepo = 'acme/orders'; c.aca.githubRepo = 'acme/orders'; c.k8s.githubActions = true; c.k8s.image = 'ghcr.io/acme/x:1'; });
    expect(Object.keys(f).filter((p) => p.startsWith('.github/'))).toEqual([]);
    expect(Object.keys(f).filter((p) => /github_oidc/.test(p))).toEqual([]);
    expect(JSON.stringify(f)).not.toMatch(/github_role_arn|aws_iam_role\.github|AZURE_CLIENT_ID/);
  });
  it('never carries a secret value', () => {
    const f = files((c) => { c.env = [{ key: 'API_TOKEN', value: 'hunter2', secret: true }]; });
    expect(JSON.stringify(f)).not.toContain('hunter2');
  });
  it('the infrastructure code is well-formed and mentions no registry of its own', () => {
    const f = files();
    for (const [p, text] of Object.entries(f)) if (p.endsWith('.tf')) expect([p, balanced(text)]).toEqual([p, true]);
    const tf = Object.entries(f).filter(([p]) => p.endsWith('.tf')).map(([, x]) => x).join('\n');
    expect(tf).not.toMatch(/aws_ecr_repository|azurerm_container_registry|acr_pull|acr_name|ecr_repository_url|image_tag|ecr:|"pull"/);
  });
  it('says what it runs', () => {
    const f = files();
    expect(JSON.stringify(f)).toContain(IMG);
  });
});

describe('each target in detail', () => {
  it('EC2: the server pulls the image itself, with no registry login and no ECR permission', () => {
    const f = gen(on('ec2')).by;
    expect(f['ec2/user_data.sh']).toContain(`IMAGE='${IMG}'`);
    expect(f['ec2/user_data.sh']).not.toMatch(/ECR|ecr |\.ecr\.|sts get-caller-identity/);
    expect(f['ec2/user_data.sh']).toContain('docker pull "$IMAGE"');
    expect(f['ec2/main.tf']).not.toMatch(/ecr:/);
    expect(f['ec2/main.tf']).toContain('"ReadThisAppsSecrets"');
    expect(f['ec2/main.tf']).toContain('${var.app_name}-secrets');
    expect(f['deploy.sh']).toMatch(/==> 1\/3 {2}Server \(Terraform\)/);
    expect(f['deploy.sh']).toMatch(/==> 3\/3 {2}Start the app/);
    expect(shOk(f['ec2/user_data.sh']!)).toBe(true);
  });
  it('EC2 from source is unchanged', () => {
    const f = gen(withDeployTarget(base({ image: '' }), 'ec2')).by;
    expect(f['ec2/main.tf']).toContain('aws_ecr_repository');
    expect(f['deploy.sh']).toContain('docker build --platform linux/amd64');
    expect(f['deploy.sh']).toMatch(/==> 4\/4 {2}Start the app/);
  });
  it('ECS: the task runs the image literally, with no tag variable', () => {
    const f = gen(on('ecs')).by;
    expect(f['ecs/main.tf']).toContain(`image     = "${IMG}"`);
    expect(f['ecs/variables.tf']).not.toContain('image_tag');
    expect(f['deploy.sh']).toMatch(/==> 1\/2 {2}Secrets/);
    expect(f['deploy.sh']).toMatch(/==> 2\/2 {2}Cluster, load balancer and service/);
    expect(f['deploy.sh']).not.toContain('-target=aws_ecr_repository');
    expect(f['deploy.sh']).not.toContain('IMAGE_TAG');
  });
  it('ECS from source is unchanged', () => {
    const f = gen(withDeployTarget(base({ image: '' }), 'ecs')).by;
    expect(f['ecs/main.tf']).toContain('${aws_ecr_repository.app.repository_url}:${var.image_tag}');
    expect(f['deploy.sh']).toContain('-target=aws_ecr_repository.app');
  });
  it('Azure VM: the VM pulls the image itself, and its tags carry only what it needs', () => {
    const f = gen(on('azure-vm')).by;
    expect(f['azvm/cloud-init.sh']).toContain(`IMAGE='${IMG}'`);
    expect(f['azvm/cloud-init.sh']).not.toMatch(/oauth2\/exchange|docker login|vmtag acr|vmtag image_tag/);
    expect(f['azvm/main.tf']).toMatch(/vault\s+= azurerm_key_vault\.app\.name/);
    expect(f['azvm/main.tf']).not.toMatch(/acr\s+=|image_tag\s+=/);
    expect(f['azvm/main.tf']).toContain('depends_on = [azurerm_role_assignment.vault_read]');
    expect(f['deploy.sh']).not.toContain('az vm update');
    expect(f['deploy.sh']).toMatch(/==> 3\/3 {2}Virtual machine/);
    expect(shOk(f['azvm/cloud-init.sh']!)).toBe(true);
  });
  it('Container Apps: the app runs the image, with no registry block, and keeps its identity only for the vault', () => {
    const f = gen(on('container-apps')).by;
    expect(f['aca/main.tf']).toContain(`image  = "${IMG}"`);
    expect(f['aca/main.tf']).not.toMatch(/registry \{/);
    expect(f['aca/main.tf']).toContain('azurerm_user_assigned_identity');
    expect(f['aca/main.tf']).toContain('depends_on = [azurerm_role_assignment.vault_read]');
    expect(f['deploy.sh']).toMatch(/==> 3\/3 {2}Environment and app/);
    expect(f['deploy.sh']).not.toContain('-target=azurerm_container_registry');
    const noSecrets = gen(on('container-apps', (c) => { c.env = []; })).by;
    expect(noSecrets['aca/main.tf']).toContain('depends_on = []');
    expect(balanced(noSecrets['aca/main.tf']!)).toBe(true);
  });
  it('AKS: the manifests run the image; nothing about a registry; the placeholders are still filled in', () => {
    const f = gen(on('aks')).by;
    expect(parse(f['k8s/deployment.yaml']!).spec.template.spec.containers[0].image).toBe(IMG);
    expect(f['aks/main.tf']).not.toMatch(/container_registry|AcrPull/);
    expect(f['aks/outputs.tf']).not.toContain('acr_name');
    expect(f['deploy.sh']).toContain('kubectl kustomize k8s | sed -e "s#__VAULT_NAME__#$VAULT#g"');
    expect(f['deploy.sh']).not.toMatch(/image: \$APP|\$ACR/);
    expect(parse(f['helm/orders-api/values.yaml']!).image).toEqual({ repository: 'ghcr.io/acme/orders-api', tag: '1.4.2' });
    expect(f['aks/README.md']).toContain('--set image.repository=ghcr.io/acme/orders-api --set image.tag=1.4.2');
    const plain = gen(on('aks', (c) => { c.env = []; })).by;
    expect(plain['deploy.sh']).toContain('kubectl apply -k k8s');
    expect(shOk(plain['deploy.sh']!)).toBe(true);
  });
  it('AKS from source is unchanged', () => {
    const f = gen(withDeployTarget(base({ image: '' }), 'aks')).by;
    expect(f['aks/main.tf']).toContain('AcrPull');
    expect(f['deploy.sh']).toContain('az acr build --registry');
  });
  it('Kubernetes: the cluster pulls the image the form names, and no image field is needed', () => {
    const c = on('kubernetes');
    expect(c.k8s.image).toBe('');
    expect(errs(c)).toBe('');
    const f = gen(c).by;
    expect(parse(f['k8s/deployment.yaml']!).spec.template.spec.containers[0].image).toBe(IMG);
    expect(f['deploy.sh']).toContain(`IMAGE='${IMG}'`);
    expect(f['deploy.sh']).toMatch(/==> 2\/2 {2}Apply and wait/);
    expect(f['k8s/README.md']).toContain('as it is: nothing is built');
  });
});

describe('the cost of a registry nobody needs', () => {
  it('is left out of every Azure estimate and the ECS/EC2 notes', () => {
    for (const [t, est] of [['azure-vm', estimateAzVmCost], ['container-apps', estimateAcaCost], ['aks', estimateAksCost]] as const) {
      const withImg = gen(on(t)).cost!;
      const without = gen(withDeployTarget(base({ image: '' }), t)).cost!;
      expect(withImg.lines.map((l) => l.label).join()).not.toContain('Container Registry');
      expect(without.lines.map((l) => l.label).join()).toContain('Container Registry');
      expect(without.monthlyUsd - withImg.monthlyUsd).toBeCloseTo(5, 1);
      void est;
    }
    expect(gen(on('ecs')).cost!.notes.join(' ')).not.toContain('ECR');
  });
});

describe('the canvas nodes', () => {
  it('a node with an image sends it to the form, and the form sends it back', () => {
    const c = on('ec2');
    const node = nodeConfigFromContainerFor('aws_container_service', c);
    expect(node['image']).toBe(IMG);
    expect(containerConfigFromNode(node).image).toBe(IMG);
    expect(containerConfigFromNode({ ...node, image: '' }).image).toBe(''); // clearing it in the properties panel means "build"
    expect(containerConfigFromAzureNode(nodeConfigFromContainerFor('azure_container_service', on('azure-vm'))).image).toBe(IMG);
  });
  it('Container Apps: its own image field is used when it is a public image, and the placeholder or a private registry is not an image', () => {
    expect(containerConfigFromAcaNode({ name: 'x', image: 'nginx:1.27' }).image).toBe('nginx:1.27');
    expect(containerConfigFromAcaNode({ name: 'x', image: 'REPLACE-WITH-YOUR-CONTAINER-IMAGE' }).image).toBe('');
    expect(containerConfigFromAcaNode({ name: 'x', image: 'myreg.azurecr.io/app:1' }).image).toBe('');
    expect(acaNodeConfigFromContainer(on('container-apps'), { image: 'old' })['image']).toBe(IMG);
    expect(acaNodeConfigFromContainer(base({ image: '' }), { image: 'myreg.azurecr.io/app:1' })['image']).toBe('myreg.azurecr.io/app:1');
  });
});

// ─── canvas: Terraform and review ────────────────────────────────────────────

import { getResourceDefinition } from '@/lib/resources';
import { generateCanonicalTerraform } from '@/lib/engines/assessment/autofix';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import type { CanvasNode } from '@/types';

let seq = 0;
function cnode(type: string, over: Record<string, unknown> = {}, extra: Partial<CanvasNode> = {}): CanvasNode {
  const def = getResourceDefinition(type)!;
  return { id: extra.id ?? `n-${type}-${++seq}`, type: 'cloudNode', resourceType: type, provider: def.provider, label: `${def.label} ${seq}`, position: { x: 0, y: 0 }, config: { ...def.defaultConfig, ...over }, ...extra } as CanvasNode;
}

describe('the canvas nodes with a ready-made image', () => {
  it('AWS: the instance runs the image, and Terraform creates no repository and grants no registry access', () => {
    const out = generateCanonicalTerraform([cnode('aws_container_service', { name: 'orders-api', image: IMG })], []);
    expect(out).toContain(`IMAGE='${IMG}'`);
    expect(out).not.toMatch(/aws_ecr_repository|ecr:/);
    expect(out).toContain('"ReadThisAppsSecrets"');
    expect(balanced(out)).toBe(true);
    const built = generateCanonicalTerraform([cnode('aws_container_service', { name: 'orders-api' })], []);
    expect(built).toContain('aws_ecr_repository');
  });
  it('Azure: the VM runs the image, with no registry, and tags only for the vault', () => {
    const rg = cnode('azure_resource_group', {}, { id: 'rg' });
    const vnet = cnode('azure_vnet', {}, { id: 'vnet', groupId: 'rg' });
    const sub = cnode('azure_subnet', {}, { id: 'sub', groupId: 'vnet' });
    const out = generateCanonicalTerraform([rg, vnet, sub, cnode('azure_container_service', { name: 'orders-api', image: IMG }, { groupId: 'sub' })], []);
    expect(out).toContain(`IMAGE='${IMG}'`);
    expect(out).not.toMatch(/azurerm_container_registry|acr_pull|oauth2\/exchange|image_tag/);
    expect(out).toMatch(/vault\s+= azurerm_key_vault\.\w+\.name/);
    const built = generateCanonicalTerraform([rg, vnet, sub, cnode('azure_container_service', { name: 'orders-api' }, { groupId: 'sub' })], []);
    expect(built).toContain('azurerm_container_registry');
  });
  it('a node with an image that is not allowed (a private registry) is left out with the reason', () => {
    const out = generateCanonicalTerraform([cnode('aws_container_service', { name: 'orders-api', image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:1' })], []);
    expect(out).toContain('was not generated');
    expect(out).not.toContain('resource "aws_instance"');
  });
  it('the Azure price drops the registry', () => {
    const { azurePricingProvider } = jest.requireActual('@/lib/engines/cost/azurePricing') as typeof import('@/lib/engines/cost/azurePricing');
    const price = (c: Record<string, unknown>) => azurePricingProvider.estimateResource({ id: 'r', label: 'r', resourceType: 'azure_container_service', provider: 'azure' } as never, { ...getResourceDefinition('azure_container_service')!.defaultConfig, ...c }, 'eastus')!;
    expect(price({}).monthlyUsd - price({ image: IMG }).monthlyUsd).toBeCloseTo(5, 2);
    expect(price({ image: IMG }).breakdown).toHaveLength(2);
  });
  it('review: what a build controls is not applicable; the tag rule looks at the image instead', () => {
    for (const [type, prefix] of [['aws_container_service', 'AWS'], ['azure_container_service', 'AZ']] as const) {
      const status = (n: CanvasNode, id: string) => runAssessment({ nodes: [n], edges: [] }).evaluations.find((e) => e.ruleId === id && e.resourceIds[0] === n.id)?.status;
      const pinned = cnode(type, { image: IMG, runAsNonRoot: false, scanImage: false });
      expect(status(pinned, `${prefix}-CTR-001`)).toBe('NOT_APPLICABLE');
      expect(status(pinned, `${prefix}-CTR-003`)).toBe('NOT_APPLICABLE');
      expect(status(pinned, `${prefix}-CTR-004`)).toBe('PASS');
      expect(status(cnode(type, { image: 'nginx' }), `${prefix}-CTR-004`)).toBe('FAIL');
      expect(status(cnode(type, { image: '', runAsNonRoot: false }), `${prefix}-CTR-001`)).toBe('FAIL'); // building: unchanged
    }
  });
  it('the property is on both resources, empty by default', () => {
    for (const t of ['aws_container_service', 'azure_container_service']) {
      const def = getResourceDefinition(t)!;
      expect(def.defaultConfig['image']).toBe('');
      expect(def.configSchema.find((f) => f.key === 'image')).toMatchObject({ type: 'text', section: 'Container' });
    }
  });
});

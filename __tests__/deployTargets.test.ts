/**
 * The deployment targets of Container Templates besides EC2: AWS ECS Fargate, Azure Container Apps and Kubernetes (manifests + Helm).
 * They are checked as text and parsed (YAML, shell syntax); Terraform is validated by scripts/tf-validate-containers.ts in CI.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse, parseAllDocuments } from 'yaml';
import { checkContainer } from '@/lib/engines/containers/checks';
import { defaultConfig, deployTargets, generateContainerFiles, validate, withDeployTarget, type ContainerConfig, type DeployTarget } from '@/lib/engines/containers/dockerTemplates';
import { estimateEcsCost, fargateMemoryOptions } from '@/lib/engines/containers/ecsDeploy';
import { estimateAcaCost } from '@/lib/engines/containers/containerAppsDeploy';
import { splitImage, k8sMemory } from '@/lib/engines/containers/kubernetesDeploy';
import { azureCloudInit, estimateAzVmCost, vaultSecretName } from '@/lib/engines/containers/azureVmDeploy';
import { aksAsK8s, estimateAksCost } from '@/lib/engines/containers/aksDeploy';
import { parseStoredConfig } from '@/lib/engines/containers/stored';

const base = (): ContainerConfig => ({
  ...defaultConfig('python'), appName: 'orders-api', port: 8000, healthPath: '/health',
  env: [{ key: 'LOG_LEVEL', value: 'info' }, { key: 'API_TOKEN', value: '', secret: true }],
});
const on = (t: DeployTarget, over: (c: ContainerConfig) => void = () => {}): ContainerConfig => {
  const c = withDeployTarget(base(), t);
  c.k8s = { ...c.k8s, image: 'ghcr.io/acme/orders-api:1.0' };
  over(c);
  return c;
};
function gen(c: ContainerConfig) {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { ...r, byPath: Object.fromEntries(r.files.map((f) => [f.path, f.content])) as Record<string, string> };
}
const errs = (c: ContainerConfig) => validate(c).join(' | ');
const balanced = (hcl: string) => (hcl.match(/\{/g) ?? []).length === (hcl.match(/\}/g) ?? []).length;

function shellSyntaxOk(script: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'sh-'));
  try { const f = join(dir, 's.sh'); writeFileSync(f, script); return spawnSync('bash', ['-n', f]).status === 0; } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('choosing a target', () => {
  it('switches on exactly one, keeping every target\'s own settings', () => {
    const c = base(); c.ecs = { ...c.ecs, desiredCount: 5 };
    const k = withDeployTarget(c, 'kubernetes');
    expect(deployTargets(k)).toEqual(['kubernetes']);
    expect(withDeployTarget(k, 'ecs').ecs.desiredCount).toBe(5);
    expect(deployTargets(withDeployTarget(k, 'none'))).toEqual([]);
  });
  it('refuses two at once, because each writes its own deploy.sh', () => {
    const c = on('ecs'); c.aca = { ...c.aca, enabled: true };
    expect(errs(c)).toMatch(/Choose one place to deploy to/);
    expect(generateContainerFiles(c).ok).toBe(false);
  });
  it('with none there are no deployment files at all', () => {
    const { byPath } = gen(on('none'));
    expect(Object.keys(byPath).filter((p) => /^(deploy|destroy)\.sh$|^(ec2|ecs|aca|k8s|helm)\/|\.github/.test(p))).toEqual([]);
  });
  it('a configuration saved before these targets existed still loads, with the new settings at their defaults', () => {
    const old = JSON.parse(JSON.stringify(base())) as Record<string, unknown>;
    delete old['ecs']; delete old['aca']; delete old['k8s'];
    const c = parseStoredConfig(JSON.stringify(old))!;
    expect(c.ecs.enabled).toBe(false);
    expect(c.k8s.namespace).toBe('default');
    expect(c.aca.location).toBe('westeurope');
  });
});

describe('every script is valid shell, and a secret value is never written', () => {
  test.each(['ec2', 'ecs', 'azure-vm', 'container-apps', 'aks', 'kubernetes'] as const)('%s', (t) => {
    const { files, byPath } = gen(on(t));
    for (const f of files.filter((x) => x.path.endsWith('.sh') && !/^(ec2\/user_data|azvm\/cloud-init)\.sh$/.test(x.path))) {
      expect(shellSyntaxOk(f.content)).toBe(true);
      expect(f.executable).toBe(true);
    }
    expect(byPath['deploy.sh']).toContain('set -euo pipefail');
    for (const f of files) expect(f.content).not.toMatch(/hunter2/);
  });
  it('and a secret typed into the form never reaches a file', () => {
    for (const t of ['ecs', 'azure-vm', 'container-apps', 'aks', 'kubernetes'] as const) {
      const c = on(t, (x) => { x.env = [{ key: 'API_TOKEN', value: 'hunter2', secret: true }]; });
      for (const f of gen(c).files) expect(f.content).not.toContain('hunter2');
    }
  });
});

describe('ECS Fargate', () => {
  const files = (over?: (c: ContainerConfig) => void) => gen(on('ecs', over)).byPath;
  it('writes the Terraform project, scripts, README and workflow', () => {
    expect(Object.keys(files())).toEqual(expect.arrayContaining(['deploy.sh', 'destroy.sh', 'ecs/main.tf', 'ecs/variables.tf', 'ecs/outputs.tf', 'ecs/README.md', 'ecs/.gitignore', '.github/workflows/deploy.yml']));
  });
  it('knows which memory Fargate accepts for each CPU, and refuses the rest', () => {
    expect(fargateMemoryOptions(256)).toEqual([512, 1024, 2048]);
    expect(fargateMemoryOptions(1024)[0]).toBe(2048);
    expect(fargateMemoryOptions(123)).toEqual([]);
    expect(errs(on('ecs', (c) => { c.ecs.cpu = 256; c.ecs.memoryMb = 4096; }))).toMatch(/memory must be one of 512, 1024, 2048/);
    expect(errs(on('ecs', (c) => { c.ecs.cpu = 300; }))).toMatch(/CPU must be/);
  });
  it('validates names, counts, ranges and the certificate', () => {
    expect(errs(on('ecs', (c) => { c.appName = 'orders_api'; }))).toMatch(/load balancer name/);
    expect(errs(on('ecs', (c) => { c.appName = 'a'.repeat(33); }))).toMatch(/32 characters/);
    expect(errs(on('ecs', (c) => { c.ecs.desiredCount = 0; }))).toMatch(/tasks must be/);
    expect(errs(on('ecs', (c) => { c.ecs.autoscaling = true; c.ecs.minCount = 5; c.ecs.maxCount = 2; }))).toMatch(/autoscaling/);
    expect(errs(on('ecs', (c) => { c.ecs.allowedCidr = 'everyone'; }))).toMatch(/IPv4 range/);
    expect(errs(on('ecs', (c) => { c.ecs.certificateArn = 'arn:aws:s3:::x'; }))).toMatch(/ACM certificate/);
    expect(errs(on('ecs', (c) => { c.ecs.region = 'mars'; }))).toMatch(/region/);
    expect(errs(on('ecs'))).toBe('');
  });
  it('only the load balancer reaches the tasks, and the roles are narrow', () => {
    const tf = files()['ecs/main.tf']!;
    expect(balanced(tf)).toBe(true);
    const taskSg = /resource "aws_security_group" "task" \{[\s\S]*?\n\}/.exec(tf)![0];
    expect(taskSg).toContain('security_groups = [aws_security_group.alb.id]');
    expect(/ingress \{[^}]*0\.0\.0\.0\/0/.test(taskSg)).toBe(false);
    expect(tf).toContain('deployment_circuit_breaker');
    expect(tf).toContain('scan_on_push = true');
    expect(tf).toContain('drop_invalid_header_fields = true');
    expect(tf).not.toMatch(/AdministratorAccess|"\*:\*"/);
  });
  it('secrets are referenced by SSM parameter, plain values are escaped so nothing can start an interpolation', () => {
    const tf = files((c) => { c.env = [{ key: 'GREETING', value: 'say "hi" ${HOME} %{if}' }, { key: 'DB_PASSWORD', value: '', secret: true }]; })['ecs/main.tf']!;
    expect(tf).toContain('DB_PASSWORD = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.app_name}/DB_PASSWORD"');
    expect(tf).toContain('value = "say \\"hi\\" $${HOME} %%{if}"');
  });
  it('HTTP only without a certificate; with one it redirects HTTP and serves HTTPS, and the service waits for the right listener', () => {
    const plain = files()['ecs/main.tf']!;
    expect(plain).not.toContain('aws_lb_listener" "https"');
    expect(plain).toContain('depends_on = [aws_lb_listener.http]');
    const arn = 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123';
    const secure = files((c) => { c.ecs.certificateArn = arn; });
    expect(secure['ecs/main.tf']).toContain('resource "aws_lb_listener" "https"');
    expect(secure['ecs/main.tf']).toContain('status_code = "HTTP_301"');
    expect(secure['ecs/main.tf']).toContain('depends_on = [aws_lb_listener.https]');
    expect(secure['ecs/main.tf']).toContain('from_port   = 443');
    expect(secure['ecs/variables.tf']).toContain(arn);
    expect(secure['ecs/outputs.tf']).toContain('"https://');
  });
  it('autoscaling adds the target and policy and stops Terraform fighting over the count', () => {
    const off = files()['ecs/main.tf']!;
    const on2 = files((c) => { c.ecs.autoscaling = true; })['ecs/main.tf']!;
    expect(off).not.toContain('aws_appautoscaling_target');
    expect(on2).toContain('aws_appautoscaling_target');
    expect(on2).toContain('ignore_changes = [desired_count]');
    expect(balanced(on2)).toBe(true);
  });
  it('deploy.sh creates the repository first, then secrets, then the image, then everything else', () => {
    const d = files()['deploy.sh']!;
    const at = (s: string) => d.indexOf(s);
    expect(at('-target=aws_ecr_repository.app')).toBeGreaterThan(-1);
    expect(at('put-parameter')).toBeGreaterThan(at('-target=aws_ecr_repository.app'));
    expect(at('docker push')).toBeGreaterThan(at('put-parameter'));
    expect(at('apply -var "image_tag=$TAG"')).toBeGreaterThan(at('docker push'));
    expect(d).toContain('--platform linux/amd64');
    expect(d).not.toContain('hunter2');
  });
  it('the workflow builds, scans and only then pushes, and rolls the service', () => {
    const w = files()['.github/workflows/deploy.yml']!;
    expect(parse(w).jobs['build-and-deploy']).toBeTruthy();
    expect(w.indexOf('docker build')).toBeLessThan(w.indexOf('trivy-action@'));
    expect(w.indexOf('trivy-action@')).toBeLessThan(w.indexOf('docker push'));
    expect(w).toContain('aws ecs update-service');
    expect(files((c) => { c.ecs.scanImage = false; })['.github/workflows/deploy.yml']).not.toContain('trivy');
  });
  it('a GitHub repository adds the OIDC role limited to main and to this service', () => {
    const f = files((c) => { c.ecs.githubRepo = 'acme/orders'; });
    expect(f['ecs/github_oidc.tf']).toContain('repo:${var.github_repository}:ref:refs/heads/main');
    expect(f['ecs/github_oidc.tf']).toContain('ecs:UpdateService');
    expect(f['ecs/outputs.tf']).toContain('github_role_arn');
    expect(files()['ecs/github_oidc.tf']).toBeUndefined();
  });
  it('estimates the cost: tasks, load balancer, public IPs, logs', () => {
    const cost = estimateEcsCost(on('ecs'))!;
    expect(cost.monthlyUsd).toBeCloseTo(55.39, 1);
    expect(cost.lines).toHaveLength(4);
    expect(estimateEcsCost(on('ecs', (c) => { c.ecs.desiredCount = 4; }))!.monthlyUsd).toBeGreaterThan(cost.monthlyUsd);
    expect(estimateEcsCost(on('none'))).toBeUndefined();
  });
});

describe('Azure Container Apps', () => {
  const files = (over?: (c: ContainerConfig) => void) => gen(on('container-apps', over)).byPath;
  it('writes the Terraform project, scripts, README and workflow', () => {
    expect(Object.keys(files())).toEqual(expect.arrayContaining(['deploy.sh', 'destroy.sh', 'aca/main.tf', 'aca/variables.tf', 'aca/outputs.tf', 'aca/README.md', '.github/workflows/deploy.yml']));
  });
  it('validates names, sizes, replicas and ranges', () => {
    expect(errs(on('container-apps', (c) => { c.appName = 'orders_api'; }))).toMatch(/single "-"/);
    expect(errs(on('container-apps', (c) => { c.appName = 'orders--api'; }))).toMatch(/single "-"/);
    expect(errs(on('container-apps', (c) => { c.aca.cpu = 3; }))).toMatch(/CPU must be/);
    expect(errs(on('container-apps', (c) => { c.aca.minReplicas = 5; c.aca.maxReplicas = 2; }))).toMatch(/maximum number of replicas/);
    expect(errs(on('container-apps', (c) => { c.aca.minReplicas = 0; c.aca.maxReplicas = 0; }))).toMatch(/at least 1/);
    expect(errs(on('container-apps', (c) => { c.aca.location = 'West Europe'; }))).toMatch(/location/);
    expect(errs(on('container-apps'))).toBe('');
  });
  it('no registry password: the app pulls with a managed identity that can only read images', () => {
    const tf = files()['aca/main.tf']!;
    expect(balanced(tf)).toBe(true);
    expect(tf).toContain('admin_enabled       = false');
    expect(tf).toContain('role_definition_name = "AcrPull"');
    expect(tf).toContain('identity = azurerm_user_assigned_identity.app.id');
  });
  it('secrets are Key Vault references read through the app\'s managed identity, never a value or a Terraform variable', () => {
    const f = files();
    const tf = f['aca/main.tf']!;
    expect(tf).toContain('resource "azurerm_key_vault" "app"');
    expect(tf).toContain('enable_rbac_authorization  = true');
    expect(tf).toContain('role_definition_name = "Key Vault Secrets User"');
    expect(tf).toContain('role_definition_name = "Key Vault Secrets Officer"');
    expect(tf).toMatch(/secret \{\s+name\s+= "api-token"\s+key_vault_secret_id = "\$\{azurerm_key_vault\.app\.vault_uri\}secrets\/API-TOKEN"\s+identity\s+= azurerm_user_assigned_identity\.app\.id\s+\}/);
    expect(tf).not.toMatch(/secret \{[^}]*\bvalue\s*=/);
    expect(tf).toContain('secret_name = "api-token"');
    expect(tf).toContain('azurerm_role_assignment.vault_read');
    expect(f['aca/variables.tf']).not.toMatch(/secret_|sensitive/);
    expect(f['aca/outputs.tf']).toContain('output "vault_name"');
    expect(f['deploy.sh']).not.toContain('TF_VAR_secret_');
    expect(f['destroy.sh']).not.toContain('unused');
    expect(f['aca/README.md']).toContain('Key Vault reference');
    expect(f['aca/README.md']).not.toMatch(/also in Terraform's state/);
  });
  it('without secrets there is no vault at all', () => {
    const f = files((c) => { c.env = [{ key: 'LOG_LEVEL', value: 'info' }]; });
    expect(f['aca/main.tf']).not.toContain('azurerm_key_vault');
    expect(f['aca/outputs.tf']).not.toContain('vault_name');
    expect(f['deploy.sh']).not.toContain('azurerm_role_assignment.vault_read');
    expect(balanced(f['aca/main.tf']!)).toBe(true);
  });
  it('deploy.sh creates the vault first, stores secrets from a temp file with a retry for role propagation, then builds and applies', () => {
    const d = files()['deploy.sh']!;
    expect(shellSyntaxOk(d)).toBe(true);
    expect(d).toContain('-target=azurerm_key_vault.app');
    expect(d).toContain('az keyvault secret set --vault-name "$VAULT" --name "$KVNAME" --file "$TMP"');
    expect(d).not.toMatch(/--value/);
    expect(d).toContain('for TRY in 1 2 3 4 5 6 7 8');
    expect(d.indexOf('-target=azurerm_key_vault.app')).toBeLessThan(d.indexOf('az keyvault secret set'));
    expect(d.indexOf('az keyvault secret set')).toBeLessThan(d.indexOf('az acr build --registry'));
    expect(d.indexOf('az acr build --registry')).toBeLessThan(d.lastIndexOf('terraform -chdir=aca apply'));
  });
  it('plain values are escaped so nothing can start an interpolation', () => {
    const tf = files((c) => { c.env = [{ key: 'GREETING', value: '${x} "q"' }]; })['aca/main.tf']!;
    expect(tf).toContain('value = "$${x} \\"q\\""');
  });
  it('probes, scale rule, and the CPU/memory pairing', () => {
    const tf = files()['aca/main.tf']!;
    for (const p of ['startup_probe', 'liveness_probe', 'readiness_probe']) expect(tf).toContain(p);
    expect(tf).toContain('http_scale_rule');
    expect(tf).toContain('memory = "${var.cpu * 2}Gi"');
  });
  it('restricts callers only when a range is chosen, and can be internal-only', () => {
    expect(files()['aca/main.tf']).not.toContain('ip_security_restriction');
    expect(files((c) => { c.aca.allowedCidr = '203.0.113.0/24'; })['aca/main.tf']).toContain('ip_security_restriction');
    expect(files((c) => { c.aca.externalIngress = false; })['aca/variables.tf']).toMatch(/external_ingress"[^}]*default     = false/);
  });
  it('builds in Azure, so deploy.sh never needs Docker', () => {
    const d = files()['deploy.sh']!;
    expect(d).toContain('az acr build');
    expect(d).not.toMatch(/need docker|docker push|docker build/);
    expect(d.indexOf('-target=azurerm_container_registry.app')).toBeLessThan(d.indexOf('az acr build --registry'));
  });
  it('destroy needs no secret values at all, and purges the vault with the group', () => {
    const f = files();
    expect(f['destroy.sh']).not.toContain('TF_VAR');
    expect(f['destroy.sh']).toContain('terraform -chdir=aca destroy');
    expect(f['aca/main.tf']).toContain('purge_soft_delete_on_destroy    = true');
  });
  it('the workflow parses, signs in with OIDC and scans before pushing', () => {
    const w = files()['.github/workflows/deploy.yml']!;
    expect(parse(w).permissions['id-token']).toBe('write');
    expect(w).toContain('azure/login@v2');
    expect(w.indexOf('trivy-action@')).toBeLessThan(w.indexOf('docker push'));
  });
  it('estimates the cost, with scale-to-zero priced lower than always-on', () => {
    const on1 = estimateAcaCost(on('container-apps'))!;
    const zero = estimateAcaCost(on('container-apps', (c) => { c.aca.minReplicas = 0; }))!;
    expect(on1.monthlyUsd).toBeGreaterThan(zero.monthlyUsd);
    expect(zero.monthlyUsd).toBeGreaterThanOrEqual(5);
    expect(estimateAcaCost(on('none'))).toBeUndefined();
  });
});

describe('Kubernetes', () => {
  const run = (over?: (c: ContainerConfig) => void) => gen(on('kubernetes', over));
  it('validates the image, names, host and counts', () => {
    expect(errs(on('kubernetes', (c) => { c.k8s.image = ''; }))).toMatch(/image the cluster should pull/);
    expect(errs(on('kubernetes', (c) => { c.k8s.image = 'Bad Image'; }))).toMatch(/image the cluster should pull/);
    expect(errs(on('kubernetes', (c) => { c.appName = 'orders_api'; }))).toMatch(/Deployment/);
    expect(errs(on('kubernetes', (c) => { c.k8s.namespace = 'Shop'; }))).toMatch(/namespace/);
    expect(errs(on('kubernetes', (c) => { c.k8s.ingressHost = 'localhost'; }))).toMatch(/ingress host/);
    expect(errs(on('kubernetes', (c) => { c.k8s.tlsSecret = 'x'; }))).toMatch(/needs an ingress host/);
    expect(errs(on('kubernetes', (c) => { c.k8s.replicas = 0; }))).toMatch(/replicas/);
    expect(errs(on('kubernetes', (c) => { c.k8s.autoscaling = true; c.k8s.minReplicas = 4; c.k8s.maxReplicas = 2; }))).toMatch(/autoscaling/);
    expect(errs(on('kubernetes'))).toBe('');
  });
  it('splits an image into repository and tag without mistaking a registry port for a tag', () => {
    expect(splitImage('ghcr.io/a/b:1.2')).toEqual({ repository: 'ghcr.io/a/b', tag: '1.2' });
    expect(splitImage('localhost:5000/app')).toEqual({ repository: 'localhost:5000/app', tag: 'latest' });
    expect(splitImage('localhost:5000/app:v1')).toEqual({ repository: 'localhost:5000/app', tag: 'v1' });
    expect(splitImage('reg/app@sha256:' + 'a'.repeat(64)).tag).toBe('sha256:' + 'a'.repeat(64));
    expect(k8sMemory('512m')).toBe('512Mi');
    expect(k8sMemory('2g')).toBe('2Gi');
  });
  it('every manifest is valid YAML, and the kustomization lists files that exist', () => {
    const { byPath } = run((c) => { c.k8s.namespace = 'shop'; c.k8s.ingressHost = 'orders.example.com'; c.k8s.tlsSecret = 'orders-tls'; c.k8s.autoscaling = true; });
    const kust = parse(byPath['k8s/kustomization.yaml']!);
    for (const r of kust.resources as string[]) {
      expect(byPath[`k8s/${r}`]).toBeDefined();
      for (const d of parseAllDocuments(byPath[`k8s/${r}`]!)) { expect(d.errors).toEqual([]); expect(d.toJS().kind).toBeTruthy(); }
    }
    expect(kust.resources).toEqual(['namespace.yaml', 'deployment.yaml', 'service.yaml', 'ingress.yaml', 'hpa.yaml', 'pdb.yaml']);
  });
  it('the deployment is hardened and has probes, limits and zero-downtime updates', () => {
    const d = parse(run().byPath['k8s/deployment.yaml']!);
    const pod = d.spec.template.spec;
    const ctr = pod.containers[0];
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(ctr.securityContext).toMatchObject({ allowPrivilegeEscalation: false, runAsNonRoot: true, runAsUser: 1001, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } });
    expect(ctr.readinessProbe.httpGet).toEqual({ path: '/health', port: 'http' });
    expect(ctr.livenessProbe).toBeTruthy();
    expect(ctr.resources.limits).toEqual({ cpu: '1', memory: '512Mi' });
    expect(ctr.resources.requests).toEqual({ cpu: '500m', memory: '256Mi' });
    expect(d.spec.strategy.rollingUpdate).toEqual({ maxUnavailable: 0, maxSurge: 1 });
    expect(d.spec.replicas).toBe(2);
  });
  it('a static site runs as the nginx unprivileged user, and Java gets a startup probe', () => {
    const s = parse(gen(on('kubernetes', (c) => { Object.assign(c, { ...defaultConfig('static'), appName: 'site', env: [], k8s: c.k8s, ec2: c.ec2, ecs: c.ecs, aca: c.aca }); }))
      .byPath['k8s/deployment.yaml']!).spec.template.spec.containers[0];
    expect(s.securityContext.runAsUser).toBe(101);
    const j = parse(gen(on('kubernetes', (c) => { Object.assign(c, { ...defaultConfig('java'), appName: 'svc', env: [], k8s: c.k8s, ec2: c.ec2, ecs: c.ecs, aca: c.aca }); }))
      .byPath['k8s/deployment.yaml']!).spec.template.spec.containers[0];
    expect(j.startupProbe).toBeTruthy();
  });
  it('plain values survive YAML quoting; secrets come from the Secret, never a value', () => {
    const tricky = 'a: b # c "quoted" \\ back';
    const d = parse(run((c) => { c.env = [{ key: 'TRICKY', value: tricky }, { key: 'API_TOKEN', value: '', secret: true }]; }).byPath['k8s/deployment.yaml']!);
    const env = d.spec.template.spec.containers[0].env;
    expect(env[0]).toEqual({ name: 'TRICKY', value: tricky });
    expect(env[1]).toEqual({ name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'orders-api-secrets', key: 'API_TOKEN' } } });
  });
  it('autoscaling hands the replica count to the autoscaler', () => {
    const { byPath } = run((c) => { c.k8s.autoscaling = true; c.k8s.minReplicas = 3; c.k8s.maxReplicas = 9; });
    expect(parse(byPath['k8s/deployment.yaml']!).spec.replicas).toBeUndefined();
    expect(parse(byPath['k8s/hpa.yaml']!).spec).toMatchObject({ minReplicas: 3, maxReplicas: 9 });
  });
  it('ingress only with a host, TLS only with a secret, a budget only with more than one replica, no namespace file for default', () => {
    const plain = run().byPath;
    expect(plain['k8s/ingress.yaml']).toBeUndefined();
    expect(plain['k8s/namespace.yaml']).toBeUndefined();
    expect(plain['k8s/pdb.yaml']).toBeDefined();
    expect(run((c) => { c.k8s.replicas = 1; }).byPath['k8s/pdb.yaml']).toBeUndefined();
    const ing = parse(run((c) => { c.k8s.ingressHost = 'a.example.com'; c.k8s.tlsSecret = 'a-tls'; }).byPath['k8s/ingress.yaml']!);
    expect(ing.spec.tls[0]).toEqual({ hosts: ['a.example.com'], secretName: 'a-tls' });
    expect(parse(run((c) => { c.k8s.ingressHost = 'a.example.com'; }).byPath['k8s/ingress.yaml']!).spec.tls).toBeUndefined();
  });
  it('the Helm chart: chart and values parse, every template block closes, values drive the image and the switches', () => {
    const { byPath } = run((c) => { c.k8s.ingressHost = 'a.example.com'; });
    const dir = 'helm/orders-api';
    expect(parse(byPath[`${dir}/Chart.yaml`]!)).toMatchObject({ apiVersion: 'v2', name: 'orders-api', type: 'application' });
    const v = parse(byPath[`${dir}/values.yaml`]!);
    expect(v).toMatchObject({ image: { repository: 'ghcr.io/acme/orders-api', tag: '1.0' }, replicaCount: 2, port: 8000, healthPath: '/health', env: { LOG_LEVEL: 'info' }, secretNames: ['API_TOKEN'], nonRoot: true, runAsUser: 1001 });
    expect(v.ingress).toMatchObject({ enabled: true, host: 'a.example.com' });
    for (const [path, text] of Object.entries(byPath).filter(([p]) => p.startsWith(`${dir}/templates/`))) {
      const opens = (text.match(/\{\{-?\s*(if|range|define|with)\b/g) ?? []).length;
      const closes = (text.match(/\{\{-?\s*end\s*-?\}\}/g) ?? []).length;
      expect([path, opens]).toEqual([path, closes]);
    }
    const dep = byPath[`${dir}/templates/deployment.yaml`]!;
    expect(dep).toContain('image: {{ .Values.image.repository }}:{{ .Values.image.tag }}');
    expect(dep).toContain('{{- if .Values.nonRoot }}');
    expect(dep).toContain('allowPrivilegeEscalation: false');
  });
  it('the Helm chart can be left out', () => {
    expect(Object.keys(run((c) => { c.k8s.helm = false; }).byPath).some((p) => p.startsWith('helm/'))).toBe(false);
  });
  it('deploy.sh asks before touching a cluster, shows which, builds multi-arch, and keeps secrets out of files', () => {
    const d = run().byPath['deploy.sh']!;
    expect(d).toContain('kubectl config current-context');
    expect(d).toContain('Deploy $APP here? [y/N]');
    expect(d).toContain('--platform linux/amd64,linux/arm64');
    expect(d).toContain('create secret generic');
    expect(d).toContain('read -r -s');
    expect(d.indexOf('docker buildx')).toBeLessThan(d.indexOf('kubectl apply -k k8s'));
    expect(d).toContain('rollout status');
    expect(run().byPath['destroy.sh']).toContain('Type the app name');
  });
  it('the image workflow exists only for ghcr.io images, and scans before pushing', () => {
    expect(run().byPath['.github/workflows/image.yml']).toBeUndefined();
    const w = run((c) => { c.k8s.githubActions = true; }).byPath['.github/workflows/image.yml']!;
    expect(parse(w).jobs['build-and-push']).toBeTruthy();
    expect(w.indexOf('trivy-action@')).toBeLessThan(w.indexOf('docker push'));
    expect(run((c) => { c.k8s.githubActions = true; c.k8s.image = 'docker.io/acme/app:1'; }).byPath['.github/workflows/image.yml']).toBeUndefined();
  });
  it('the container build context ignores the deploy folders', () => {
    const ig = run().byPath['.dockerignore']!;
    for (const p of ['k8s', 'helm', '.github']) expect(ig.split('\n')).toContain(p);
  });
});

describe('Azure VM', () => {
  const files = (over?: (c: ContainerConfig) => void) => gen(on('azure-vm', over)).byPath;
  it('writes the Terraform project, the start-up script, scripts, README and workflow', () => {
    expect(Object.keys(files())).toEqual(expect.arrayContaining(['deploy.sh', 'destroy.sh', 'azvm/main.tf', 'azvm/variables.tf', 'azvm/outputs.tf', 'azvm/cloud-init.sh', 'azvm/README.md', '.github/workflows/deploy.yml']));
    expect(shellSyntaxOk(files()['azvm/cloud-init.sh']!)).toBe(true);
  });
  it('validates names, size, disk and range', () => {
    expect(errs(on('azure-vm', (c) => { c.appName = 'orders_api'; }))).toMatch(/single "-"/);
    expect(errs(on('azure-vm', (c) => { c.azvm.size = 'B2s'; }))).toMatch(/size looks like/);
    expect(errs(on('azure-vm', (c) => { c.azvm.diskGb = 10; }))).toMatch(/disk size/);
    expect(errs(on('azure-vm', (c) => { c.azvm.allowedCidr = 'x'; }))).toMatch(/IPv4 range/);
    expect(errs(on('azure-vm', (c) => { c.azvm.location = 'West Europe'; }))).toMatch(/location/);
    expect(errs(on('azure-vm'))).toBe('');
  });
  it('is closed by default: no SSH, no password, no registry admin, vault by role, only the app port', () => {
    const tf = files()['azvm/main.tf']!;
    expect(balanced(tf)).toBe(true);
    expect(tf).toContain('disable_password_authentication = true');
    expect(tf).toContain('admin_enabled       = false');
    expect(tf).toContain('enable_rbac_authorization  = true');
    expect(tf).toMatch(/destination_port_range\s+= tostring\(var\.app_port\)/);
    expect(tf).not.toMatch(/destination_port_range\s*=\s*"22"/);
    expect(tf).toContain('role_definition_name = "AcrPull"');
    expect(tf).toContain('role_definition_name = "Key Vault Secrets User"');
    expect(tf).toContain('ignore_changes = [admin_ssh_key, tags]');
    expect(files()['azvm/variables.tf']).toMatch(/variable "admin_ssh_public_key" \{[^}]*\}/);
    expect(files()['azvm/variables.tf']).not.toMatch(/admin_ssh_public_key" \{[^}]*default/);
  });
  it('the start-up script is static: nothing for Terraform to interpolate, the registry and vault come from the VM tags', () => {
    const ci = files()['azvm/cloud-init.sh']!;
    expect(ci).not.toMatch(/(?<!\$)\$\{/);
    expect(ci).toContain('vmtag acr');
    expect(ci).toContain('vmtag vault');
    expect(ci).toContain('vmtag image_tag');
    expect(ci).toContain('/oauth2/exchange');
    expect(ci).toContain('--password-stdin');
    expect(files()['azvm/main.tf']).toContain('custom_data                     = filebase64("${path.module}/cloud-init.sh")');
    expect(files()['azvm/main.tf']).toMatch(/acr\s+= azurerm_container_registry\.app\.login_server/);
  });
  it('secrets are read from Key Vault under a legal name, and never appear as a value', () => {
    expect(vaultSecretName('API_TOKEN')).toBe('API-TOKEN');
    const ci = files((c) => { c.env = [{ key: 'API_TOKEN', value: '', secret: true }, { key: 'GREETING', value: 'hi' }]; })['azvm/cloud-init.sh']!;
    expect(ci).toContain('secrets/API-TOKEN?api-version=7.4');
    expect(ci).toContain("printf '%s=%s\\n' 'API_TOKEN'");
    expect(ci).toContain('GREETING=hi');
    expect(azureCloudInit({ ...on('azure-vm'), env: [] })).not.toContain('vault.azure.net/secrets');
  });
  it('deploy.sh makes a throw-away key and deletes the private half at once; secrets go to the vault from a temp file', () => {
    const d = files()['deploy.sh']!;
    expect(d).toContain('ssh-keygen -q -t ed25519');
    expect(d.indexOf('rm -f "$KEYDIR/k"')).toBeGreaterThan(d.indexOf('ssh-keygen'));
    expect(d.indexOf('rm -f "$KEYDIR/k"')).toBeLessThan(d.indexOf('terraform -chdir=azvm apply'));
    expect(d).toContain('az keyvault secret set --vault-name "$VAULT" --name "$KVNAME" --file "$TMP"');
    expect(d).not.toMatch(/--value/);
    expect(d.indexOf('-target=azurerm_container_registry.app')).toBeLessThan(d.indexOf('az acr build --registry'));
    expect(d.indexOf('az acr build --registry')).toBeLessThan(d.indexOf('az vm run-command invoke'));
    expect(d).not.toMatch(/need docker|docker push|docker build/);
    expect(files()['destroy.sh']).toContain('terraform -chdir=azvm destroy');
  });
  it('the workflow signs in with OIDC, scans before pushing and restarts the VM', () => {
    const w = files()['.github/workflows/deploy.yml']!;
    expect(parse(w).permissions['id-token']).toBe('write');
    expect(w.indexOf('trivy-action@')).toBeLessThan(w.indexOf('docker push'));
    expect(w).toContain('az vm run-command invoke');
  });
  it('estimates the cost: VM, disk, public IP, registry', () => {
    const cost = estimateAzVmCost(on('azure-vm'))!;
    expect(cost.monthlyUsd).toBeCloseTo(0.0416 * 730 + 30 * 0.075 + 0.005 * 730 + 5, 1);
    expect(cost.lines).toHaveLength(4);
    expect(estimateAzVmCost(on('azure-vm', (c) => { c.azvm.size = 'Standard_Z9'; }))!.notes.join(' ')).toMatch(/not in the price table/);
    expect(estimateAzVmCost(on('none'))).toBeUndefined();
  });
});

describe('Azure Kubernetes Service', () => {
  const files = (over?: (c: ContainerConfig) => void) => gen(on('aks', over)).byPath;
  it('writes the cluster Terraform, the manifests and the Helm chart, but no generic deploy README or workflow', () => {
    const f = files();
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['deploy.sh', 'destroy.sh', 'aks/main.tf', 'aks/variables.tf', 'aks/outputs.tf', 'aks/README.md', 'k8s/deployment.yaml', 'k8s/kustomization.yaml', 'helm/orders-api/Chart.yaml']));
    expect(f['k8s/README.md']).toBeUndefined();
    expect(f['.github/workflows/image.yml']).toBeUndefined();
  });
  it('validates the cluster settings and the Kubernetes settings it shares', () => {
    expect(errs(on('aks', (c) => { c.appName = 'orders_api'; }))).toMatch(/cluster and DNS prefix/);
    expect(errs(on('aks', (c) => { c.aks.minNodes = 4; c.aks.maxNodes = 2; }))).toMatch(/nodes need a minimum/);
    expect(errs(on('aks', (c) => { c.aks.nodeSize = 'B2s'; }))).toMatch(/node size/);
    expect(errs(on('aks', (c) => { c.k8s.namespace = 'Shop'; }))).toMatch(/namespace/);
    expect(errs(on('aks', (c) => { c.k8s.ingressHost = 'localhost'; }))).toMatch(/ingress host/);
    expect(errs(on('aks', (c) => { c.k8s.image = ''; }))).toBe(''); // the image is the registry's, not typed
    expect(errs(on('aks'))).toBe('');
  });
  it('the manifests run the image deploy.sh builds, with the managed ingress class when there is a host', () => {
    expect(aksAsK8s(on('aks')).k8s.image).toBe('orders-api:latest');
    const f = files((c) => { c.k8s.ingressHost = 'orders.example.com'; c.aks.imageTag = 'v3'; });
    expect(parse(f['k8s/deployment.yaml']!).spec.template.spec.containers[0].image).toBe('orders-api:v3');
    expect(parse(f['k8s/ingress.yaml']!).spec.ingressClassName).toBe('webapprouting.kubernetes.azure.com');
    expect(parse(files((c) => { c.k8s.ingressHost = 'a.example.com'; c.k8s.ingressClass = 'my-class'; })['k8s/ingress.yaml']!).spec.ingressClassName).toBe('my-class');
  });
  it('the cluster pulls with its own identity, has workload identity, autoscaling and monitoring, and the registry has no password', () => {
    const tf = files()['aks/main.tf']!;
    expect(balanced(tf)).toBe(true);
    expect(tf).toContain('admin_enabled       = false');
    expect(tf).toContain('role_definition_name             = "AcrPull"');
    expect(tf).toContain('kubelet_identity[0].object_id');
    expect(tf).toContain('workload_identity_enabled = true');
    expect(tf).toContain('oidc_issuer_enabled       = true');
    expect(tf).toContain('enable_auto_scaling = true');
    expect(tf).toContain('oms_agent');
    expect(tf).toContain('network_plugin_mode = "overlay"');
  });
  it('deploy.sh builds in Azure, uses a private kubeconfig, creates secrets by prompt, and runs the registry image', () => {
    const d = files()['deploy.sh']!;
    expect(d).toContain('az acr build --registry');
    expect(d).toContain('KUBECONFIG="$(mktemp)"');
    expect(d).toContain('create secret generic');
    expect(d).toContain('read -r -s');
    expect(d).toContain('sed "s#image: $APP:$TAG#image: $ACR.azurecr.io/$APP:$TAG#"');
    expect(d.indexOf('terraform -chdir=aks apply')).toBeLessThan(d.indexOf('az acr build --registry'));
    expect(d.indexOf('az acr build --registry')).toBeLessThan(d.indexOf('kubectl apply'));
    expect(d).toContain('rollout status');
    expect(d).not.toMatch(/docker (build|push|buildx)/);
    expect(d).not.toContain('approuting');
    expect(files((c) => { c.k8s.ingressHost = 'a.example.com'; })['deploy.sh']).toContain('az aks approuting enable');
  });
  it('the manifests are valid YAML and hardened like the plain Kubernetes target', () => {
    const f = files();
    const ctr = parse(f['k8s/deployment.yaml']!).spec.template.spec.containers[0];
    expect(ctr.securityContext).toMatchObject({ allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ['ALL'] } });
    for (const r of parse(f['k8s/kustomization.yaml']!).resources as string[]) expect(f[`k8s/${r}`]).toBeDefined();
  });
  it('the Helm chart points at the registry image by value', () => {
    expect(parse(files()['helm/orders-api/values.yaml']!).image).toEqual({ repository: 'orders-api', tag: 'latest' });
    expect(files()['aks/README.md']).toContain('--set image.repository=<acr_name>.azurecr.io/orders-api');
  });
  it('estimates the cost: nodes, load balancer and outbound IP, registry', () => {
    const cost = estimateAksCost(on('aks'))!;
    expect(cost.monthlyUsd).toBeCloseTo(0.0416 * 730 + 0.03 * 730 + 5, 1);
    expect(cost.lines.map((l) => l.label)).toEqual(expect.arrayContaining([expect.stringContaining('Free tier')]));
    expect(estimateAksCost(on('aks', (c) => { c.aks.minNodes = 3; }))!.monthlyUsd).toBeGreaterThan(cost.monthlyUsd);
    expect(estimateAksCost(on('none'))).toBeUndefined();
  });
  it('the cluster\'s own warnings replace the generic image-tag and secret ones', () => {
    const w = gen(on('aks', (c) => { c.env = [{ key: 'T', value: '', secret: true }]; })).warnings.join(' ');
    expect(w).toMatch(/AKS: the "latest" tag/);
    expect(w).toMatch(/only base64-encoded/);
    expect(w).not.toMatch(/Kubernetes: the image has no version tag/);
  });
});

describe('security checks for the new targets', () => {
  const ids = (c: ContainerConfig, edit?: (files: { path: string; content: string }[]) => void) => {
    const r = gen(c); const files = r.files.map((f) => ({ ...f })); edit?.(files);
    return checkContainer(c, files).map((f) => f.id);
  };
  const patch = (files: { path: string; content: string }[], path: string, fn: (s: string) => string) => { const f = files.find((x) => x.path === path)!; f.content = fn(f.content); };

  it('the defaults of each target raise nothing above medium for what CloudCraft controls', () => {
    for (const t of ['ecs', 'container-apps', 'kubernetes'] as const) {
      const c = on(t, (x) => { x.ecs.allowedCidr = '10.0.0.0/8'; x.aca.allowedCidr = '10.0.0.0/8'; x.ecs.imageTag = 'v1'; x.aca.imageTag = 'v1'; x.ecs.certificateArn = 'arn:aws:acm:us-east-1:123456789012:certificate/abc'; x.k8s.ingressHost = 'a.example.com'; x.k8s.tlsSecret = 'a-tls'; });
      expect(checkContainer(c, gen(c).files).filter((f) => f.severity === 'high')).toEqual([]);
    }
  });
  it('ECS: plain HTTP, open load balancer, tasks open to anyone', () => {
    expect(ids(on('ecs'))).toEqual(expect.arrayContaining(['CT-017', 'CT-011']));
    const open = ids(on('ecs'), (f) => patch(f, 'ecs/main.tf', (s) => s.replace('security_groups = [aws_security_group.alb.id]', 'cidr_blocks = ["0.0.0.0/0"]')));
    expect(open).toContain('CT-018');
    expect(ids(on('ecs'), (f) => patch(f, 'ecs/main.tf', (s) => s.replace('deployment_circuit_breaker', 'x')))).toContain('CT-019');
  });
  it('Container Apps: registry admin user, plain HTTP, secrets in state', () => {
    expect(ids(on('container-apps'), (f) => patch(f, 'aca/main.tf', (s) => s.replace('admin_enabled       = false', 'admin_enabled       = true')))).toContain('CT-020');
    expect(ids(on('container-apps'), (f) => patch(f, 'aca/main.tf', (s) => s + '\nallow_insecure_connections = true'))).toContain('CT-021');
    expect(ids(on('container-apps'))).not.toContain('CT-022');
    expect(ids(on('container-apps'), (f) => patch(f, 'aca/main.tf', (s) => s.replace(/key_vault_secret_id = "[^"]*"/, 'value = "x"')))).toContain('CT-022');
  });
  it('Kubernetes: root, privilege escalation, host access, no limits, plain-HTTP ingress, untagged image', () => {
    expect(ids(on('kubernetes', (c) => { c.runAsNonRoot = false; }))).toContain('CT-002');
    expect(ids(on('kubernetes'), (f) => patch(f, 'k8s/deployment.yaml', (s) => s.replace('allowPrivilegeEscalation: false', 'allowPrivilegeEscalation: true')))).toContain('CT-023');
    expect(ids(on('kubernetes'), (f) => patch(f, 'k8s/deployment.yaml', (s) => s + '\n      hostNetwork: true\n'))).toContain('CT-007');
    expect(ids(on('kubernetes'), (f) => patch(f, 'k8s/deployment.yaml', (s) => s.replace(/limits:[\s\S]*?memory: \S+/, 'x:')))).toContain('CT-009');
    expect(ids(on('kubernetes', (c) => { c.k8s.ingressHost = 'a.example.com'; }))).toContain('CT-024');
    expect(ids(on('kubernetes', (c) => { c.k8s.image = 'ghcr.io/acme/app'; }))).toContain('CT-016');
    expect(ids(on('kubernetes', (c) => { c.k8s.image = 'ghcr.io/acme/app:latest'; }))).toContain('CT-016');
  });
  it('Azure VM: SSH, password sign-in, registry admin user, vault access policies', () => {
    expect(ids(on('azure-vm'), (f) => patch(f, 'azvm/main.tf', (s) => s + '\n  destination_port_range = "22"\n'))).toContain('CT-014');
    expect(ids(on('azure-vm'), (f) => patch(f, 'azvm/main.tf', (s) => s.replace('disable_password_authentication = true', 'disable_password_authentication = false')))).toContain('CT-025');
    expect(ids(on('azure-vm'), (f) => patch(f, 'azvm/main.tf', (s) => s.replace('admin_enabled       = false', 'admin_enabled       = true')))).toContain('CT-020');
    expect(ids(on('azure-vm'), (f) => patch(f, 'azvm/main.tf', (s) => s.replace('enable_rbac_authorization  = true', 'enable_rbac_authorization  = false')))).toContain('CT-026');
    expect(ids(on('azure-vm'))).toEqual(expect.arrayContaining(['CT-011', 'CT-016']));
    expect(ids(on('azure-vm', (c) => { c.azvm.allowedCidr = '10.0.0.0/8'; c.azvm.imageTag = 'v1'; }))).not.toEqual(expect.arrayContaining(['CT-011']));
  });
  it('AKS: the Kubernetes checks apply to its manifests, registry admin user is caught, the latest tag is reported once', () => {
    expect(ids(on('aks', (c) => { c.runAsNonRoot = false; }))).toContain('CT-002');
    expect(ids(on('aks'), (f) => patch(f, 'k8s/deployment.yaml', (s) => s.replace('allowPrivilegeEscalation: false', 'allowPrivilegeEscalation: true')))).toContain('CT-023');
    expect(ids(on('aks'), (f) => patch(f, 'aks/main.tf', (s) => s.replace('admin_enabled       = false', 'admin_enabled       = true')))).toContain('CT-020');
    expect(ids(on('aks', (c) => { c.k8s.ingressHost = 'a.example.com'; }))).toContain('CT-024');
    expect(ids(on('aks')).filter((i) => i === 'CT-016')).toHaveLength(1);
  });
  it('the old EC2 checks still fire and nothing else target-specific leaks into them', () => {
    const e = ids(on('ec2'));
    expect(e).toEqual(expect.arrayContaining(['CT-011', 'CT-016']));
    expect(e.some((i) => ['CT-017', 'CT-018', 'CT-020', 'CT-024'].includes(i))).toBe(false);
  });
});

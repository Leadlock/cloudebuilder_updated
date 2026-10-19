/**
 * A ready-made image on Kubernetes/AKS decides its own user: forcing user 1001 on the official nginx makes it crash (it cannot write its own
 * cache files). The pod stays hardened, and a known root-running image gets a warning that names the exact fix.
 */
import { defaultConfig, generateContainerFiles, type ContainerConfig } from '@/lib/engines/containers/dockerTemplates';

const make = (image: string, extra: Partial<ContainerConfig> = {}, target: 'k8s' | 'aks' = 'k8s'): ContainerConfig => {
  const c = defaultConfig('node');
  c.image = image;
  c.port = 80;
  if (target === 'k8s') c.k8s = { ...c.k8s, enabled: true, image: image === '' ? 'ghcr.io/acme/app:1' : '' };
  else c.aks = { ...c.aks, enabled: true };
  return { ...c, ...extra };
};
const gen = (c: ContainerConfig) => {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { r, get: (p: string) => r.files.find((f) => f.path === p)?.content ?? '' };
};

describe('ready-made image on Kubernetes', () => {
  test('no user id is forced on a ready-made image', () => {
    const dep = gen(make('nginx:1.27')).get('k8s/deployment.yaml');
    expect(dep).not.toMatch(/runAsUser:/);
    expect(dep).toMatch(/runAsNonRoot:\s*true/);
    expect(dep).toContain('drop: ["ALL"]');
  });

  test('an image built by CloudBuilder still runs as its fixed user', () => {
    const c = make('');
    expect(gen(c).get('k8s/deployment.yaml')).toMatch(/runAsUser: 1001/);
  });

  test('the official nginx is warned about, with the unprivileged image as the fix', () => {
    const w = gen(make('nginx:1.27')).r.warnings.join(' ');
    expect(w).toContain('nginxinc/nginx-unprivileged');
    expect(w).toContain('Run as non-root');
    expect(gen(make('docker.io/library/httpd:2.4')).r.warnings.join(' ')).toContain('starts as root');
  });

  test('the unprivileged nginx and other images are not warned about', () => {
    expect(gen(make('nginxinc/nginx-unprivileged:1.27')).r.warnings.join(' ')).not.toContain('starts as root');
    expect(gen(make('ghcr.io/me/nginx-tools:1')).r.warnings.join(' ')).not.toContain('starts as root');
  });

  test('turning non-root off for a root image adds back only the four permissions it needs', () => {
    const { get, r } = gen(make('nginx:1.27', { runAsNonRoot: false }));
    const dep = get('k8s/deployment.yaml');
    expect(dep).not.toMatch(/runAsNonRoot/);
    expect(dep).toContain('add: ["CHOWN", "SETGID", "SETUID", "NET_BIND_SERVICE"]');
    expect(dep).toContain('drop: ["ALL"]');
    expect(dep).toContain('allowPrivilegeEscalation: false');
    expect(r.warnings.join(' ')).toContain('runs as root with the four permissions');
  });

  test('a built image never gets extra permissions', () => {
    expect(gen(make('', { runAsNonRoot: false })).get('k8s/deployment.yaml')).not.toContain('add: [');
  });

  test('the Helm chart leaves the user to the image and keeps the switch', () => {
    const files = gen(make('nginx:1.27')).r.files;
    const values = files.find((f) => f.path.endsWith('values.yaml'))!.content;
    const tpl = files.find((f) => /templates\/deployment\.yaml$/.test(f.path))!.content;
    expect(values).toMatch(/nonRoot: true/);
    expect(values).toMatch(/runAsUser: ""/);
    expect(tpl).toContain('{{- if .Values.runAsUser }}');
    expect(tpl).toContain('runAsNonRoot: true');
  });

  test('AKS gets the same treatment', () => {
    const dep = gen(make('nginx:1.27', {}, 'aks')).get('k8s/deployment.yaml');
    expect(dep).not.toMatch(/runAsUser:/);
  });

  test('a static-site stack with a ready-made image follows the checkbox, not the stack', () => {
    const c = make('nginx:1.27', { runAsNonRoot: false });
    c.stack = 'static';
    expect(gen(c).get('k8s/deployment.yaml')).not.toMatch(/runAsNonRoot/);
  });
});

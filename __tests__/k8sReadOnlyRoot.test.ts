/**
 * The generated Kubernetes Deployments of a BUILT image run with a read-only root filesystem and a writable /tmp (every stack's sample app was run
 * that way with Docker: scripts/build-samples.ts, READ_ONLY=1), and carry a pod-level security context. A ready-made image keeps its own filesystem.
 */
import { defaultConfig, generateContainerFiles, STACKS, type ContainerConfig } from '@/lib/engines/containers/dockerTemplates';

const make = (stack: ContainerConfig['stack'], extra: Partial<ContainerConfig> = {}): ContainerConfig => {
  const c = defaultConfig(stack);
  c.k8s = { ...c.k8s, enabled: true, image: 'ghcr.io/acme/app:1' };
  return { ...c, ...extra };
};
const files = (c: ContainerConfig) => {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return (p: string) => r.files.find((f) => f.path === p)?.content ?? '';
};

describe('a built image', () => {
  test.each(STACKS)('%s: read-only root filesystem, a writable /tmp, and a pod security context', (stack) => {
    const dep = files(make(stack))('k8s/deployment.yaml');
    expect(dep).toMatch(/readOnlyRootFilesystem: true/);
    expect(dep).toMatch(/mountPath: \/tmp/);
    expect(dep).toMatch(/- name: tmp\n\s+emptyDir:\n\s+sizeLimit: 128Mi/);
    expect(dep).toMatch(/\n {6}securityContext:\n {8}seccompProfile:\n {10}type: RuntimeDefault/);
    expect(dep.match(/^ {6}volumes:/gm)).toHaveLength(1);
    expect(dep.match(/^ {2}volumeMounts:|^ {10}volumeMounts:/gm)?.length ?? 0).toBe(1);
  });

  test('the Helm chart switches it with a value, on by default, and only adds the volume when it is on', () => {
    const get = files(make('node'));
    expect(get('helm/my-app/values.yaml')).toMatch(/readOnlyRootFilesystem: true/);
    const dep = get('helm/my-app/templates/deployment.yaml');
    expect(dep).toContain('readOnlyRootFilesystem: {{ .Values.readOnlyRootFilesystem }}');
    expect(dep).toMatch(/\{\{- if \.Values\.readOnlyRootFilesystem \}\}\n\s+- name: tmp/);
    expect(dep).toMatch(/\{\{- if \.Values\.nonRoot \}\}\n\s+runAsNonRoot: true/);
  });
});

describe('a ready-made image', () => {
  test('keeps its own filesystem (it may write anywhere) but still gets the pod security context', () => {
    const get = files(make('node', { image: 'nginx:1.27', port: 80, k8s: { ...defaultConfig('node').k8s, enabled: true, image: '' } }));
    const dep = get('k8s/deployment.yaml');
    expect(dep).not.toMatch(/readOnlyRootFilesystem/);
    expect(dep).not.toMatch(/name: tmp/);
    expect(dep).toMatch(/\n {6}securityContext:\n {8}seccompProfile:/);
    expect(get('helm/my-app/values.yaml')).toMatch(/readOnlyRootFilesystem: false/);
  });
});

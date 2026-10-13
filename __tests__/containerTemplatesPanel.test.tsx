/**
 * @jest-environment jsdom
 */
/**
 * The Container Templates panel, rendered for real: picking a deployment target shows that target's settings, its estimate and its files,
 * invalid settings stop the files, and a configuration sent from a canvas node arrives in the form.
 */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
// jsdom has no TextEncoder; every browser does.
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const mockDispatch = jest.fn();
let mockProject: unknown = null;
jest.mock('@/context/AppContext', () => ({
  useApp: () => ({ state: { theme: 'light' }, dispatch: mockDispatch }),
  useActiveProject: () => mockProject,
}));

import ContainerTemplatesPanel from '@/components/panels/ContainerTemplatesPanel';
import { sendToContainerTemplates } from '@/components/panels/containerHandoff';
import { defaultConfig, withDeployTarget } from '@/lib/engines/containers/dockerTemplates';

beforeEach(() => {
  mockDispatch.mockReset();
  mockProject = null;
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: { templates: [] } }) }));
});

const pick = (value: string) => fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value } });
const tabs = () => screen.queryAllByRole('tab').map((t) => t.textContent);
const checks = () => screen.getByTestId('container-checks').textContent ?? '';

describe('choosing where to deploy', () => {
  it('offers every target, starting with no deployment files', async () => {
    render(<ContainerTemplatesPanel />);
    const select = screen.getByLabelText('Deploy to') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['none', 'ec2', 'ecs', 'azure-vm', 'container-apps', 'aks', 'kubernetes']);
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['AWS', 'Azure', 'Any cluster']);
    expect(select.value).toBe('none');
    expect(tabs()).not.toContain('deploy.sh');
    await waitFor(() => expect(screen.getByText('Nothing saved yet.')).toBeTruthy());
  });

  it('ECS: shows its settings, writes its files, estimates its cost and only offers memory Fargate accepts', () => {
    render(<ContainerTemplatesPanel />);
    pick('ecs');
    expect(tabs()).toEqual(expect.arrayContaining(['deploy.sh', 'ecs/main.tf', '.github/workflows/deploy.yml']));
    expect(screen.getByText(/Estimated cost on AWS ECS Fargate: \$/)).toBeTruthy();
    const mem = screen.getByLabelText('Task memory') as HTMLSelectElement;
    expect([...mem.options].map((o) => o.value)).toEqual(['512', '1024', '2048']);
    fireEvent.change(screen.getByLabelText('CPU units'), { target: { value: '1024' } });
    expect([...(screen.getByLabelText('Task memory') as HTMLSelectElement).options].map((o) => o.value)[0]).toBe('2048');
    // a memory size that does not fit the new CPU was moved to one that does, so the files still generate
    expect(tabs()).toContain('ecs/main.tf');
    expect(checks()).toContain('plain HTTP');
    fireEvent.change(screen.getByLabelText(/ACM certificate ARN/), { target: { value: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' } });
    expect(checks()).not.toContain('plain HTTP');
  });

  it('Container Apps: shows its settings and findings', () => {
    render(<ContainerTemplatesPanel />);
    pick('container-apps');
    expect(tabs()).toEqual(expect.arrayContaining(['aca/main.tf', 'deploy.sh']));
    expect(screen.getByLabelText('Azure region')).toBeTruthy();
    expect(screen.getByText(/Estimated cost on Azure Container Apps: \$/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Minimum replicas'), { target: { value: '9' } });
    expect(screen.getByRole('alert').textContent).toMatch(/maximum number of replicas/);
    expect(tabs()).not.toContain('aca/main.tf'); // an invalid setting stops the files
  });

  it('Kubernetes: needs an image, then writes manifests and the Helm chart', () => {
    render(<ContainerTemplatesPanel />);
    pick('kubernetes');
    expect(screen.getByRole('alert').textContent).toMatch(/image the cluster should pull/);
    fireEvent.change(screen.getByLabelText('Image the cluster pulls'), { target: { value: 'ghcr.io/acme/app:1.0' } });
    expect(tabs()).toEqual(expect.arrayContaining(['k8s/deployment.yaml', 'k8s/kustomization.yaml', 'helm/my-app/Chart.yaml']));
    fireEvent.click(screen.getByLabelText('Also generate a Helm chart'));
    expect(tabs().some((t) => t?.startsWith('helm/'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Ingress host (optional)'), { target: { value: 'app.example.com' } });
    expect(tabs()).toContain('k8s/ingress.yaml');
    expect(checks()).toContain('plain HTTP');
  });

  it('switching target keeps what you typed for the others and shows exactly one set of settings', () => {
    render(<ContainerTemplatesPanel />);
    pick('ecs');
    fireEvent.change(screen.getByLabelText('Tasks'), { target: { value: '4' } });
    pick('container-apps');
    expect(screen.queryByLabelText('Tasks')).toBeNull();
    pick('ecs');
    expect((screen.getByLabelText('Tasks') as HTMLInputElement).value).toBe('4');
    pick('none');
    expect(screen.queryByLabelText('Tasks')).toBeNull();
  });

  it('Azure VM and AKS: show their settings, files and estimates', () => {
    render(<ContainerTemplatesPanel />);
    pick('azure-vm');
    expect(tabs()).toEqual(expect.arrayContaining(['azvm/main.tf', 'azvm/cloud-init.sh', 'deploy.sh']));
    expect(screen.getByLabelText('VM size')).toBeTruthy();
    expect(screen.getByText(/Estimated cost on Azure VM: \$/)).toBeTruthy();
    pick('aks');
    expect(tabs()).toEqual(expect.arrayContaining(['aks/main.tf', 'k8s/deployment.yaml', 'helm/my-app/Chart.yaml']));
    expect(screen.getByLabelText('Node size')).toBeTruthy();
    expect(screen.queryByLabelText('Image the cluster pulls')).toBeNull(); // the image is the registry's
    expect(screen.getByText(/Estimated cost on Azure Kubernetes Service: \$/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Minimum nodes'), { target: { value: '9' } });
    expect(screen.getByRole('alert').textContent).toMatch(/nodes need a minimum/);
  });

  it('a starter template can deploy to Azure instead of AWS', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(screen.getByText('Azure (Container Apps)'));
    fireEvent.click(screen.getByText('Go service'));
    expect((screen.getByLabelText('Deploy to') as HTMLSelectElement).value).toBe('container-apps');
    expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('go-api');
    fireEvent.click(screen.getByText('AWS (EC2)'));
    fireEvent.click(screen.getByText('Go service'));
    expect((screen.getByLabelText('Deploy to') as HTMLSelectElement).value).toBe('ec2');
  });

  it('a starter template switches EC2 on in the selector', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(screen.getByText('FastAPI service'));
    expect((screen.getByLabelText('Deploy to') as HTMLSelectElement).value).toBe('ec2');
  });
});

describe('the canvas', () => {
  it('a configuration sent from a node arrives in the form, and Update changes that node', () => {
    const cfg = withDeployTarget({ ...defaultConfig('python'), appName: 'from-canvas', port: 8123 }, 'ec2');
    mockProject = { nodes: [{ id: 'n1', type: 'cloudNode', resourceType: 'aws_container_service', provider: 'aws', label: 'old', position: { x: 0, y: 0 }, config: { name: 'old' } }], edges: [] };
    sendToContainerTemplates(cfg, 'n1');
    render(<ContainerTemplatesPanel />);
    expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('from-canvas');
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('8123');
    fireEvent.click(screen.getByText('Update the canvas node'));
    const call = mockDispatch.mock.calls.find((c) => c[0].type === 'UPDATE_NODE_CONFIG')![0];
    expect(call).toMatchObject({ nodeId: 'n1', label: 'from-canvas', config: { name: 'from-canvas', port: 8123, stack: 'python' } });
  });

  it('Add to architecture creates the resource that matches the target, or says why it cannot', () => {
    const { rerender } = render(<ContainerTemplatesPanel />);
    fireEvent.click(screen.getByText('Add to architecture'));
    expect(screen.getByRole('status').textContent).toMatch(/Open or create a project/);
    expect(mockDispatch).not.toHaveBeenCalled();
    mockProject = { nodes: [], edges: [] };
    rerender(<ContainerTemplatesPanel />);
    fireEvent.click(screen.getByText('Add to architecture'));
    expect(screen.getByRole('status').textContent).toMatch(/Pick where to deploy/);
    const added = (target: string) => {
      mockDispatch.mockReset();
      pick(target);
      fireEvent.click(screen.getByText(/Add to architecture|Update the canvas node/));
      return mockDispatch.mock.calls.find((c) => c[0].type === 'UPDATE_CANVAS')?.[0].nodes.at(-1);
    };
    expect(added('ec2')).toMatchObject({ resourceType: 'aws_container_service', provider: 'aws', label: 'my-app' });
    mockProject = { nodes: [], edges: [] }; rerender(<ContainerTemplatesPanel />);
    expect(added('azure-vm')).toMatchObject({ resourceType: 'azure_container_service', provider: 'azure', config: { vmSize: 'Standard_B2s', allowedCidr: '0.0.0.0/0' } }); // what the form says, which the checks then flag
    mockProject = { nodes: [], edges: [] }; rerender(<ContainerTemplatesPanel />);
    expect(added('container-apps')).toMatchObject({ resourceType: 'azure_container_apps', provider: 'azure', config: { name: 'my-app', targetPort: 3000, minReplicas: 1, cpu: '0.5' } });
    for (const t of ['ecs', 'aks']) {
      mockProject = { nodes: [], edges: [] }; rerender(<ContainerTemplatesPanel />);
      expect(added(t)).toBeUndefined();
    }
    expect(screen.getByRole('status').textContent).toMatch(/no single canvas resource|Fix the errors/);
  });
});

describe('saving', () => {
  it('lists saved templates and opens one', async () => {
    const saved = { id: 't1', name: 'Orders API', updatedAt: 'x', config: { ...defaultConfig('python'), appName: 'orders-api' } };
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: { templates: [saved] } }) }));
    render(<ContainerTemplatesPanel />);
    const card = (await screen.findByText('Orders API')).closest('li')!;
    fireEvent.click(within(card).getByText('Open'));
    expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('orders-api');
    expect(screen.getByText('Update this template')).toBeTruthy();
  });
  it('shows why saving failed', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? { ok: false, json: async () => ({ error: { message: 'Viewers cannot save templates.' } }) } : { ok: true, json: async () => ({ data: { templates: [] } }) });
    render(<ContainerTemplatesPanel />);
    fireEvent.click(screen.getByText('Save as new'));
    expect((await screen.findByRole('alert')).textContent).toContain('Viewers cannot save templates.');
  });
});

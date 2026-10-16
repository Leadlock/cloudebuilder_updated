/**
 * @jest-environment jsdom
 */
/**
 * The Stack area of Container Templates: Frontend, Backend, API and Database, each with its own list. Picking a database hides what only an
 * application has, limits the places it can be deployed to, and the canvas refuses it.
 */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent, within } from '@testing-library/react';

let mockProject: unknown = null;
const mockDispatch = jest.fn();
jest.mock('@/context/AppContext', () => ({
  useApp: () => ({ state: { theme: 'light', activeEnvironment: 'production' }, dispatch: mockDispatch }),
  useActiveProject: () => mockProject,
}));

import ContainerTemplatesPanel from '@/components/panels/ContainerTemplatesPanel';

beforeEach(() => {
  mockProject = null;
  mockDispatch.mockReset();
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: { templates: [] } }) }));
});

const include = (name: string) => screen.getByLabelText(`Include ${name}`) as HTMLInputElement;
const choice = (name: string) => screen.getByLabelText(`${name} choice`) as HTMLSelectElement;
const labels = (name: string) => [...choice(name).options].map((o) => o.textContent);
const targetOptions = () => [...(screen.getByLabelText('Deploy to') as HTMLSelectElement).options].map((o) => o.value);
const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);

describe('the Stack parts', () => {
  test('there are four, starting with only the Backend (Node.js) ticked', () => {
    render(<ContainerTemplatesPanel />);
    expect(['Frontend', 'Backend', 'API', 'Database'].map((n) => include(n).checked)).toEqual([false, true, false, false]);
    expect(choice('Backend').selectedOptions[0]!.textContent).toMatch(/Node\.js/);
  });

  test('each part lists its own options', () => {
    render(<ContainerTemplatesPanel />);
    expect(labels('Frontend').join(' | ')).toMatch(/React.*Static website.*Next\.js/);
    expect(labels('API').join(' | ')).toMatch(/FastAPI.*Express.*Spring Boot.*Web API.*Go HTTP API/);
    expect(labels('Database')).toEqual(['PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'RabbitMQ']);
  });

  test('the last ticked part cannot be unticked', () => {
    render(<ContainerTemplatesPanel />);
    expect(include('Backend').disabled).toBe(true);
    fireEvent.click(include('Frontend'));
    expect(include('Backend').disabled).toBe(false);
  });

  test('ticking one part never unticks another, and the files cover all of them', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('Frontend'));
    fireEvent.click(include('API'));
    fireEvent.click(include('Database'));
    expect(['Frontend', 'Backend', 'API', 'Database'].map((n) => include(n).checked)).toEqual([true, true, true, true]);
    expect(tabNames()).toEqual(expect.arrayContaining(['docker-compose.yml', '.env.example', 'README.md', 'frontend/Dockerfile', 'frontend/nginx.conf', 'backend/Dockerfile', 'api/Dockerfile']));
    expect(tabNames().filter((n) => n === 'docker-compose.yml')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: 'docker-compose.yml' }));
    const text = document.body.textContent ?? '';
    for (const svc of ['frontend:', 'backend:', 'api:', 'database:']) expect(text).toContain(svc);
  });

  test('choosing from one list changes only that part', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('API'));
    fireEvent.change(choice('API'), { target: { value: 'go-api' } });
    expect(choice('Backend').selectedOptions[0]!.textContent).toMatch(/Node\.js/);
    expect(choice('API').value).toBe('go-api');
    expect(include('Backend').checked).toBe(true);
  });

  test('with several parts the app name, the single-service deployments and the add-on services are not offered; the project name and a project deployment are', () => {
    render(<ContainerTemplatesPanel />);
    expect(screen.getByLabelText('Deploy to')).toBeTruthy();
    expect([...(screen.getByLabelText('Deploy to') as HTMLSelectElement).options].map((o) => o.value)).toContain('ecs');
    fireEvent.click(include('Frontend'));
    // The Deploy card of one service is replaced by the project's: none, or one server (EC2 or an Azure VM) for everything.
    expect([...(screen.getByLabelText('Deploy to') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['none', 'ec2', 'azure-vm', 'kubernetes', 'aks']);
    expect(screen.queryByLabelText('App name')).toBeNull();
    expect(screen.queryByText('Add PostgreSQL')).toBeNull();
    expect(screen.getByLabelText('Project name')).toBeTruthy();
    fireEvent.click(include('Frontend'));
    expect([...(screen.getByLabelText('Deploy to') as HTMLSelectElement).options].map((o) => o.value)).toContain('ecs');
    expect(screen.getByLabelText('App name')).toBeTruthy();
  });

  test('choosing EC2 for the project adds the deployment files for all of it, with its own settings and cost', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('Frontend')); fireEvent.click(include('API')); fireEvent.click(include('Database'));
    expect(tabNames()).not.toContain('deploy.sh');
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'ec2' } });
    expect(tabNames()).toEqual(expect.arrayContaining(['deploy.sh', 'destroy.sh', 'ec2/main.tf', 'ec2/compose.deploy.yml', 'ec2/user_data.sh', 'docker-compose.yml']));
    expect((screen.getByLabelText('Instance type') as HTMLInputElement).value).toBe('t3.medium');
    expect(document.body.textContent).toMatch(/Estimated cost on AWS EC2: \$\d+/);
    fireEvent.change(screen.getByLabelText('Instance type'), { target: { value: 'm5.large' } });
    fireEvent.click(screen.getByRole('tab', { name: 'ec2/variables.tf' }));
    expect(document.body.textContent).toContain('m5.large');
    fireEvent.change(screen.getByLabelText(/Who can connect/), { target: { value: 'everyone' } });
    expect(screen.getByRole('alert').textContent).toMatch(/who can connect/);
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'none' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(tabNames()).not.toContain('deploy.sh');
  });

  test('choosing an Azure VM for the project adds its files, its own settings and cost, and keeps the EC2 settings apart', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('Frontend')); fireEvent.click(include('API'));
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'azure-vm' } });
    expect(tabNames()).toEqual(expect.arrayContaining(['deploy.sh', 'azvm/main.tf', 'azvm/cloud-init.sh', 'azvm/compose.deploy.yml']));
    expect(tabNames()).not.toContain('ec2/main.tf');
    expect((screen.getByLabelText('VM size') as HTMLInputElement).value).toBe('Standard_B2ms');
    expect(document.body.textContent).toMatch(/Estimated cost on Azure VM: \$\d+/);
    fireEvent.change(screen.getByLabelText('VM size'), { target: { value: 'Standard_D2s_v3' } });
    fireEvent.click(screen.getByRole('tab', { name: 'azvm/variables.tf' }));
    expect(document.body.textContent).toContain('Standard_D2s_v3');
    fireEvent.change(screen.getByLabelText(/Who can connect/), { target: { value: 'everyone' } });
    expect(screen.getByRole('alert').textContent).toMatch(/who can connect/);
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'ec2' } });
    expect((screen.getByLabelText(/Who can connect/) as HTMLInputElement).value).toBe('0.0.0.0/0');   // the other cloud's setting is not carried over
  });

  test('choosing Kubernetes for the project adds a folder of manifests per service, asks for the registry first, and refuses a database with the way out', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('Frontend')); fireEvent.click(include('API'));
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'kubernetes' } });
    expect(screen.getByRole('alert').textContent).toMatch(/registry/);
    fireEvent.change(screen.getByLabelText('Image registry'), { target: { value: 'ghcr.io/acme' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(tabNames()).toEqual(expect.arrayContaining(['deploy.sh', 'k8s/kustomization.yaml', 'k8s/namespace.yaml', 'k8s/frontend/deployment.yaml', 'k8s/api/service.yaml']));
    expect(tabNames()).not.toContain('ec2/main.tf');
    fireEvent.change(screen.getByLabelText('Ingress host (optional)'), { target: { value: 'shop.example.com' } });
    expect(tabNames()).toContain('k8s/frontend/ingress.yaml');
    expect(tabNames()).not.toContain('k8s/api/ingress.yaml');
    fireEvent.click(include('Database'));
    expect(screen.getByRole('alert').textContent).toMatch(/Database is not run in the cluster/);
    expect(screen.getByRole('alert').textContent).toMatch(/DATABASE_URL/);
    fireEvent.click(include('Database'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('choosing AKS for the project adds the cluster Terraform and the manifests, with its own settings and cost, and refuses a database with the way out', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('Frontend')); fireEvent.click(include('API'));
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'aks' } });
    expect(tabNames()).toEqual(expect.arrayContaining(['deploy.sh', 'aks/main.tf', 'aks/variables.tf', 'k8s/kustomization.yaml', 'k8s/api/deployment.yaml']));
    expect(tabNames()).not.toContain('ec2/main.tf');
    expect((screen.getByLabelText('Node size') as HTMLInputElement).value).toBe('Standard_B2s');
    expect(document.body.textContent).toMatch(/Estimated cost on Azure Kubernetes Service[^:]*: \$\d+/);
    fireEvent.change(screen.getByLabelText('Node size'), { target: { value: 'Standard_D2s_v3' } });
    fireEvent.click(screen.getByRole('tab', { name: 'aks/variables.tf' }));
    expect(document.body.textContent).toContain('Standard_D2s_v3');
    fireEvent.change(screen.getByLabelText('Ingress host (optional)'), { target: { value: 'shop.example.com' } });
    expect(tabNames()).toContain('k8s/frontend/ingress.yaml');
    fireEvent.click(include('Database'));
    expect(screen.getByRole('alert').textContent).toMatch(/AKS: a Database is not run in the cluster/);
    expect(screen.getByRole('alert').textContent).toMatch(/DATABASE_URL/);
    fireEvent.click(include('Database'));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'kubernetes' } });
    expect(screen.getByLabelText('Image registry')).toBeTruthy();    // the plain Kubernetes settings are separate from AKS's
  });

  test('the project deployment is kept when parts are ticked and unticked, and one part alone goes back to its own deployment card', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('API'));
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'ec2' } });
    fireEvent.click(include('Database'));
    expect((screen.getByLabelText('Deploy to') as HTMLSelectElement).value).toBe('ec2');
    fireEvent.click(include('API')); fireEvent.click(include('Database'));
    expect([...(screen.getByLabelText('Deploy to') as HTMLSelectElement).options].map((o) => o.value)).toContain('ecs');
    expect(tabNames()).not.toContain('ec2/compose.deploy.yml');
  });

  test('"Edit settings" shows that part\'s form', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('API'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit settings' })[0]!);
    expect(screen.getByTestId('editing-layer').textContent).toContain('Backend');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit settings' })[0]!);
    expect(screen.getByTestId('editing-layer').textContent).toContain('API');
  });

  test('a project of several parts cannot be saved or added to the canvas yet', () => {
    mockProject = { id: 'p1', provider: 'aws', region: 'us-east-1', nodes: [], edges: [], environments: { production: { id: 'production', region: 'us-east-1', nodes: [], edges: [] } } };
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('Database'));
    expect((screen.getByRole('button', { name: /Save as new/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Add to architecture/ }));
    expect(screen.getByText(/not added to the canvas yet/)).toBeTruthy();
    expect(mockDispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'UPDATE_CANVAS' }));
  });

  test('a bad project name stops the files with the reason', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('Frontend'));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Bad Name' } });
    expect(screen.getByRole('alert').textContent).toMatch(/Project name/);
  });
});

describe('a database', () => {
  const pickDatabase = (name = 'PostgreSQL') => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(include('Database'));
    fireEvent.click(include('Backend'));
    if (name !== 'PostgreSQL') fireEvent.change(choice('Database'), { target: { value: `db-${name.toLowerCase()}` } });
  };

  test('shows its own version list, a fixed port and no health path or image choice', () => {
    pickDatabase();
    expect([...(screen.getByLabelText('PostgreSQL version') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['17', '16', '15', '14']);
    expect((screen.getByLabelText('Port') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('5432');
    expect(screen.queryByLabelText('Health check path')).toBeNull();
    expect(screen.queryByLabelText('Where does the image come from?')).toBeNull();
  });

  test('changing the version changes the image in the files', () => {
    pickDatabase();
    fireEvent.change(screen.getByLabelText('PostgreSQL version'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('tab', { name: 'docker-compose.yml' }));
    expect(document.body.textContent).toContain('postgres:15-alpine');
  });

  test('its files are only the compose file, the example variables and the README, and it asks for the password', () => {
    pickDatabase('MySQL');
    expect(screen.getByRole('tab', { name: 'docker-compose.yml' })).toBeTruthy();
    expect(screen.queryByText('Dockerfile')).toBeNull();
    expect(screen.getAllByDisplayValue('MYSQL_PASSWORD').length + screen.getAllByText(/MYSQL_PASSWORD/).length).toBeGreaterThan(0);
  });

  test('it can only go to a virtual machine, or nowhere', () => {
    pickDatabase();
    expect(targetOptions()).toEqual(['none', 'ec2', 'azure-vm']);
  });

  test('on a VM the range is labelled as the database\'s, not the app\'s, and starts private', () => {
    pickDatabase();
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'ec2' } });
    const input = screen.getByLabelText(/Who can connect to the database/) as HTMLInputElement;
    expect(input.value).toBe('10.0.0.0/16');
  });

  test('opening it to everyone is refused with the reason', () => {
    pickDatabase();
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'ec2' } });
    fireEvent.change(screen.getByLabelText(/Who can connect to the database/), { target: { value: '0.0.0.0/0' } });
    expect(document.body.textContent).toContain('must not be open to the internet');
  });

  test('app-only options are hidden', () => {
    pickDatabase();
    expect(screen.queryByText('Add PostgreSQL')).toBeNull();
    expect(screen.queryByText(/HTTPS reverse proxy/)).toBeNull();
    expect(screen.queryByText('Include a sample app')).toBeNull();
  });

  test('the cloud chip sends a database to a virtual machine, never to Container Apps', () => {
    pickDatabase();
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'ec2' } });
    fireEvent.click(screen.getByRole('button', { name: /Azure \(Container Apps\)/ }));
    expect((screen.getByLabelText('Deploy to') as HTMLSelectElement).value).toBe('azure-vm');
    expect(document.body.textContent).not.toContain('cannot be deployed here');
    fireEvent.click(screen.getByRole('button', { name: /AWS \(EC2\)/ }));
    expect((screen.getByLabelText('Deploy to') as HTMLSelectElement).value).toBe('ec2');
  });

  test('going back to an application restores the usual form', () => {
    pickDatabase();
    fireEvent.click(include('Backend'));
    fireEvent.click(include('Database'));
    expect(screen.queryByLabelText('PostgreSQL version')).toBeNull();
    expect(screen.getByLabelText('Health check path')).toBeTruthy();
    expect((screen.getByLabelText('Port') as HTMLInputElement).disabled).toBe(false);
    expect(targetOptions()).toEqual(['none', 'ec2', 'ecs', 'azure-vm', 'container-apps', 'aks', 'kubernetes']);
  });

  test('the canvas says why a database is not added there', () => {
    mockProject = { id: 'p1', provider: 'aws', region: 'us-east-1', nodes: [], edges: [], environments: { production: { id: 'production', region: 'us-east-1', nodes: [], edges: [] } } };
    pickDatabase();
    fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value: 'ec2' } });
    fireEvent.click(screen.getByRole('button', { name: /Add to architecture/ }));
    expect(screen.getByText(/A database is not added to the canvas from here/)).toBeTruthy();
    expect(mockDispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'UPDATE_CANVAS' }));
  });
});

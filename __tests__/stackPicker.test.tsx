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

  test('with several parts the app name, deployment and add-on services are not offered, and the project name is', () => {
    render(<ContainerTemplatesPanel />);
    expect(screen.getByLabelText('Deploy to')).toBeTruthy();
    fireEvent.click(include('Frontend'));
    expect(screen.queryByLabelText('Deploy to')).toBeNull();
    expect(screen.queryByLabelText('App name')).toBeNull();
    expect(screen.queryByText('Add PostgreSQL')).toBeNull();
    expect(screen.getByLabelText('Project name')).toBeTruthy();
    fireEvent.click(include('Frontend'));
    expect(screen.getByLabelText('Deploy to')).toBeTruthy();
    expect(screen.getByLabelText('App name')).toBeTruthy();
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

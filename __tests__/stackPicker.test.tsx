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

const group = (name: string) => within(screen.getByRole('group', { name: 'Stack group' })).getByRole('button', { name });
const optionSelect = () => screen.getByLabelText(/^(Frontend|Backend|API|Database)$/) as HTMLSelectElement;
const optionLabels = () => [...optionSelect().options].map((o) => o.textContent);
const targetOptions = () => [...(screen.getByLabelText('Deploy to') as HTMLSelectElement).options].map((o) => o.value);

describe('the Stack groups', () => {
  test('there are four, starting on Backend with Node.js chosen', () => {
    render(<ContainerTemplatesPanel />);
    expect(['Frontend', 'Backend', 'API', 'Database'].map((n) => group(n).textContent)).toEqual(['Frontend', 'Backend', 'API', 'Database']);
    expect(group('Backend').getAttribute('aria-pressed')).toBe('true');
    expect(optionSelect().selectedOptions[0]!.textContent).toMatch(/Node\.js/);
  });

  test('each group lists its own options', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(group('Frontend'));
    expect(optionLabels().join(' | ')).toMatch(/React.*Static website.*Next\.js/);
    fireEvent.click(group('API'));
    expect(optionLabels().join(' | ')).toMatch(/FastAPI.*Express.*Spring Boot.*Web API.*Go HTTP API/);
    fireEvent.click(group('Database'));
    expect(optionLabels()).toEqual(['PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'RabbitMQ']);
  });

  test('opening a group opens its first option and the files follow', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(group('Frontend'));
    expect(group('Frontend').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('nginx.conf')).toBeTruthy();
  });

  test('choosing from the list changes the stack', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(group('API'));
    fireEvent.change(optionSelect(), { target: { value: 'go-api' } });
    expect((screen.getByLabelText('Health check path') as HTMLInputElement).value).toBe('/health');
    expect(screen.getAllByText('Dockerfile').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText('Dockerfile')[0]!);
    expect(document.body.textContent).toContain('golang');
  });
});

describe('a database', () => {
  const pickDatabase = (name = 'PostgreSQL') => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(group('Database'));
    if (name !== 'PostgreSQL') fireEvent.change(optionSelect(), { target: { value: `db-${name.toLowerCase()}` } });
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
    fireEvent.click(screen.getByText('docker-compose.yml'));
    expect(document.body.textContent).toContain('postgres:15-alpine');
  });

  test('its files are only the compose file, the example variables and the README, and it asks for the password', () => {
    pickDatabase('MySQL');
    expect(screen.getByText('docker-compose.yml')).toBeTruthy();
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
    fireEvent.click(group('Backend'));
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

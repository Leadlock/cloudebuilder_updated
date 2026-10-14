/**
 * @jest-environment jsdom
 */
/**
 * Choosing a region in the top bar changes the project (also an unsaved draft), and the Container Templates follow it; the "Deploys to" cloud
 * chip moves the form that is open instead of only the next starter.
 */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent, act } from '@testing-library/react';

let mockProject: unknown = null;
const mockDispatch = jest.fn();
jest.mock('@/context/AppContext', () => {
  const actual = jest.requireActual('@/context/AppContext');
  return {
    ...actual,
    useApp: () => ({ state: { theme: 'light', activeEnvironment: 'production' }, dispatch: mockDispatch }),
    useActiveProject: () => mockProject,
  };
});

import ContainerTemplatesPanel from '@/components/panels/ContainerTemplatesPanel';
import { reducer, initialState } from '@/context/AppContext';
import { withProjectRegion } from '@/lib/engines/containers/projectRegion';
import { defaultConfig } from '@/lib/engines/containers/dockerTemplates';

const project = (provider: string, region: string) => ({ id: 'p1', provider, region, nodes: [], edges: [], environments: { production: { id: 'production', region, nodes: [], edges: [] } } });

beforeEach(() => {
  mockProject = null;
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: { templates: [] } }) }));
});

describe('region in the top bar (reducer)', () => {
  test('an unsaved draft takes the region, in the project, its environment and its resources', () => {
    const draft = initialState.draftProject;
    const withNode = { ...draft, nodes: [{ id: 'n1', type: 'aws_ec2', resourceType: 'aws_ec2', label: 'Web', provider: 'aws', region: 'us-east-1', config: {}, position: { x: 0, y: 0 } } as never] };
    const state = { ...initialState, activeProjectId: null, draftProject: withNode };
    const next = reducer(state, { type: 'SET_REGION', region: 'eu-west-1' });
    expect(next.draftProject.region).toBe('eu-west-1');
    expect(next.draftProject.environments.production.region).toBe('eu-west-1');
    expect(next.draftProject.nodes[0]!.region).toBe('eu-west-1');
    expect(next.autoSaveStatus).toBe('unsaved');
  });

  test('the draft id counts as a draft too', () => {
    const next = reducer({ ...initialState, activeProjectId: 'draft-project' }, { type: 'SET_REGION', region: 'ap-south-1' });
    expect(next.draftProject.region).toBe('ap-south-1');
  });

  test('a saved project takes the region and the draft is left alone', () => {
    const saved = { ...initialState.draftProject, id: 'p1', region: 'us-east-1' };
    const state = { ...initialState, activeProjectId: 'p1', projects: [saved] };
    const next = reducer(state, { type: 'SET_REGION', region: 'eu-central-1' });
    expect(next.projects[0]!.region).toBe('eu-central-1');
    expect(next.projects[0]!.environments.production.region).toBe('eu-central-1');
    expect(next.draftProject.region).toBe(initialState.draftProject.region);
  });
});

describe('withProjectRegion', () => {
  test('an AWS region fills the EC2 and ECS regions and leaves Azure alone', () => {
    const c = withProjectRegion(defaultConfig('node'), 'aws', 'eu-west-1');
    expect(c.ec2.region).toBe('eu-west-1');
    expect(c.ecs.region).toBe('eu-west-1');
    expect(c.aca.location).toBe(defaultConfig('node').aca.location);
  });
  test('an Azure region fills the Azure locations and leaves AWS alone', () => {
    const c = withProjectRegion(defaultConfig('node'), 'azure', 'northeurope');
    expect([c.azvm.location, c.aca.location, c.aks.location]).toEqual(['northeurope', 'northeurope', 'northeurope']);
    expect(c.ec2.region).toBe(defaultConfig('node').ec2.region);
  });
  test('a region of the wrong shape, or none, changes nothing', () => {
    const base = defaultConfig('node');
    expect(withProjectRegion(base, 'aws', 'westeurope')).toBe(base);
    expect(withProjectRegion(base, 'azure', 'eu-west-1')).toBe(base);
    expect(withProjectRegion(base, 'aws', undefined)).toBe(base);
    expect(withProjectRegion(base, 'multi', 'eu-west-1')).toBe(base);
  });
});

describe('the "Deploys to" chip', () => {
  const chip = (name: RegExp) => screen.getByRole('button', { name });
  const target = () => (screen.getByLabelText('Deploy to') as HTMLSelectElement).value;

  test('moves a form that already has a deployment, and its files and cost follow', () => {
    render(<ContainerTemplatesPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Node\.js web app/ }));
    expect(target()).toBe('ec2');
    fireEvent.click(chip(/Azure \(Container Apps\)/));
    expect(target()).toBe('container-apps');
    expect(screen.getByText(/Estimated cost on/).textContent).toMatch(/Container Apps/);
    expect(screen.getByText(/Estimated cost on/).textContent).not.toMatch(/EC2/);
    expect(screen.queryAllByRole('tab').map((t) => t.textContent).join(' ')).not.toContain('ec2/main.tf');
    fireEvent.click(chip(/AWS \(EC2\)/));
    expect(target()).toBe('ec2');
  });

  test('does not switch on a deployment for a form that has none', () => {
    render(<ContainerTemplatesPanel />);
    expect(target()).toBe('none');
    fireEvent.click(chip(/Azure \(Container Apps\)/));
    expect(target()).toBe('none');
  });
});

describe('Container Templates follow the project region', () => {
  const regionInput = () => screen.getByLabelText('Region') as HTMLInputElement;
  const pick = (value: string) => fireEvent.change(screen.getByLabelText('Deploy to'), { target: { value } });

  test('a starter opens in the project\'s AWS region', () => {
    mockProject = project('aws', 'eu-west-1');
    render(<ContainerTemplatesPanel />);
    fireEvent.click(screen.getByRole('button', { name: /FastAPI service/ }));
    expect(regionInput().value).toBe('eu-west-1');
  });

  test('changing the region in the top bar changes it here, without a reload', () => {
    mockProject = project('aws', 'us-east-1');
    const { rerender } = render(<ContainerTemplatesPanel />);
    pick('ec2');
    expect(regionInput().value).toBe('us-east-1');
    mockProject = project('aws', 'ap-south-1');
    act(() => { rerender(<ContainerTemplatesPanel />); });
    expect(regionInput().value).toBe('ap-south-1');
  });

  test('an AWS region does not touch the Azure settings', () => {
    mockProject = project('aws', 'eu-west-1');
    render(<ContainerTemplatesPanel />);
    pick('container-apps');
    expect((screen.getByLabelText('Azure region') as HTMLInputElement).value).toBe(defaultConfig('node').aca.location);
  });
});

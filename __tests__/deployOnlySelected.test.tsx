/**
 * @jest-environment jsdom
 */
/**
 * Terraform panel, "Deploy only some resources": the ticked canvas resources are what the plan is asked for; none ticked means everything.
 */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const project = {
  id: 'p1', provider: 'aws', region: 'us-east-1', environments: {},
  nodes: [
    { id: 'n-vpc', resourceType: 'aws_vpc', label: 'Main VPC', position: { x: 0, y: 0 } },
    { id: 'n-s3', resourceType: 'aws_s3', label: 'Logs bucket', position: { x: 0, y: 0 } },
    { id: 'n-box', resourceType: 'aws_cloud_boundary', label: 'Cloud', position: { x: 0, y: 0 } },
  ],
  edges: [],
};
jest.mock('@/context/AppContext', () => ({
  useApp: () => ({ state: { theme: 'light', activeEnvironment: 'production', currentUser: { id: 'u1', role: 'admin', name: 'A', email: 'a@x.io', orgId: 'o1' } }, dispatch: jest.fn() }),
  useActiveProject: () => project,
}));
const mockGeneratePlan = jest.fn();
jest.mock('@/lib/services/ApiTerraformExecutionService', () => ({
  ApiTerraformExecutionService: new Proxy({}, { get: (_t, prop) => (prop === 'generatePlan' ? mockGeneratePlan : jest.fn().mockResolvedValue({})) }),
}));
jest.mock('@/lib/services/ApiReviewService', () => ({ ApiReviewService: { getReviews: jest.fn().mockResolvedValue({ latest: { id: 'r1', status: 'approved', architectureHash: 'h' } }) } }));
jest.mock('@/components/panels/TerraformLimitsBar', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/panels/TerraformApprovalBar', () => ({ __esModule: true, default: () => null, TerraformApprovalInbox: () => null }));
jest.mock('@/components/panels/TerraformWorkerNotice', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/panels/RequiredPermissionsCard', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/panels/TerraformPermissionHelp', () => ({ __esModule: true, default: () => null }));

import TerraformExecutionPanel from '@/components/panels/TerraformExecutionPanel';

beforeEach(() => {
  mockGeneratePlan.mockReset();
  localStorage.clear();
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: [{ id: 'acct-1', provider: 'aws', name: 'Prod', status: 'connected' }] }) }));
});

describe('Deploy only some resources', () => {
  test('lists the canvas resources (not the cloud outline) and nothing is ticked at first', async () => {
    render(<TerraformExecutionPanel />);
    const section = await screen.findByTestId('deploy-only');
    expect(section.textContent).toContain('Deploy only some resources');
    expect((screen.getByLabelText('Deploy Main VPC') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText('Deploy Logs bucket')).toBeTruthy();
    expect(screen.queryByLabelText('Deploy Cloud')).toBeNull();
  });

  test('ticking resources says how many, and clearing goes back to everything', async () => {
    render(<TerraformExecutionPanel />);
    await screen.findByTestId('deploy-only');
    fireEvent.click(screen.getByLabelText('Deploy Logs bucket'));
    expect(screen.getByTestId('deploy-only').textContent).toContain('Deploy only 1 selected resource');
    expect(screen.getByRole('button', { name: /Generate Plan for 1 selected/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Clear \(deploy everything\)/ }));
    expect(screen.getByRole('button', { name: /Generate Terraform Plan/ })).toBeTruthy();
  });

  const plan = (targets?: string[]) => ({ planId: 'pl1', planHash: 'h', expiresAt: new Date(Date.now() + 600000).toISOString(), summary: { toAdd: 2, toChange: 0, toDestroy: 0, resourceChanges: [], ...(targets ? { targets } : {}) } });

  test('the plan is asked for the ticked resources only, and says it covers only those', async () => {
    mockGeneratePlan.mockResolvedValue(plan(['aws_s3_bucket.logs']));
    render(<TerraformExecutionPanel />);
    await screen.findByTestId('deploy-only');
    fireEvent.change(await screen.findByPlaceholderText('S3 bucket (leave empty to auto-name)'), { target: { value: 'state-bucket' } });
    await waitFor(() => expect((screen.getByLabelText(/Account/i) as HTMLSelectElement).value).toBe('acct-1'));
    fireEvent.click(screen.getByLabelText('Deploy Logs bucket'));
    fireEvent.click(screen.getByRole('button', { name: /Generate Plan for 1 selected/ }));
    await waitFor(() => expect(mockGeneratePlan).toHaveBeenCalled());
    expect(mockGeneratePlan.mock.calls[0]![5]).toEqual(['n-s3']);
    expect((await screen.findByTestId('targeted-plan')).textContent).toMatch(/Only the selected resources/);
  });

  test('with nothing ticked the whole architecture is planned and no "only" notice shows', async () => {
    mockGeneratePlan.mockResolvedValue(plan());
    render(<TerraformExecutionPanel />);
    await screen.findByTestId('deploy-only');
    fireEvent.change(await screen.findByPlaceholderText('S3 bucket (leave empty to auto-name)'), { target: { value: 'state-bucket' } });
    await waitFor(() => expect((screen.getByLabelText(/Account/i) as HTMLSelectElement).value).toBe('acct-1'));
    fireEvent.click(screen.getByRole('button', { name: /Generate Terraform Plan/ }));
    await waitFor(() => expect(mockGeneratePlan).toHaveBeenCalled());
    expect(mockGeneratePlan.mock.calls[0]![5]).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId('deploy-only')).toBeNull());
    expect(screen.queryByTestId('targeted-plan')).toBeNull();
  });
});

/**
 * @jest-environment jsdom
 */
/** The access card on the Deploy page and the operator page, rendered for real against a fake server. */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

jest.mock('@/context/AppContext', () => ({ useApp: () => ({ state: { theme: 'light' }, dispatch: jest.fn() }) }));

import TerraformAccessCard from '@/components/panels/TerraformAccessCard';
import OperatorAccessPanel from '@/components/panels/OperatorAccessPanel';

const checks = (over: Partial<Record<string, boolean>> = {}) => [
  { id: 'authenticator', label: 'Authenticator app turned on for you', passed: over['authenticator'] ?? true, detail: over['authenticator'] === false ? 'Not turned on.' : 'On.', fix: 'Turn it on under Cloud Accounts.' },
  { id: 'cloud-account', label: 'A cloud account that passed its check', passed: over['cloud'] ?? true, detail: over['cloud'] === false ? 'No cloud account connected.' : '1 of 1 cloud account checked and working.', fix: 'Connect an account.' },
  { id: 'encryption-key', label: "Credentials stored under the server's own key", passed: true, detail: 'The server uses its own encryption key.', fix: 'Set a key.' },
];
const summary = (over: Record<string, unknown> = {}) => ({ status: 'none', note: null, checks: checks(), autoApprove: false, canRequest: true, mayDeploy: false, reason: 'x', operator: false, ...over });

function fakeFetch(handlers: Record<string, (init?: { method?: string; body?: string }) => { ok?: boolean; data?: unknown; message?: string }>) {
  const calls: Array<[string, string]> = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push([method, url]);
    const h = handlers[`${method} ${url}`];
    const r = h ? h(init) : { ok: false, message: 'no handler' };
    return { ok: r.ok !== false, json: async () => (r.ok === false ? { error: { message: r.message } } : { data: r.data }) };
  });
  return calls;
}

describe('the access card', () => {
  it('shows what stands between the organization and Terraform, and what to do about each', async () => {
    fakeFetch({ 'GET /api/terraform-access': () => ({ data: summary({ checks: checks({ authenticator: false, cloud: false }) }) }) });
    render(<TerraformAccessCard />);
    expect(await screen.findByText('Terraform is not enabled for this organization yet')).toBeTruthy();
    expect(screen.getByText(/An operator approves each request/)).toBeTruthy();
    expect(screen.getByText(/Not turned on\. Turn it on under Cloud Accounts\./)).toBeTruthy();
    expect(screen.getByText(/No cloud account connected\. Connect an account\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask for access' })).toBeTruthy();
  });
  it('offers "Enable Terraform" when the server approves automatically and everything passes, and asks the server when clicked', async () => {
    let asked = 0;
    let status = 'none';
    const calls = fakeFetch({
      'GET /api/terraform-access': () => ({ data: summary({ autoApprove: true, status }) }),
      'POST /api/terraform-access': () => { asked++; status = 'approved'; return { data: { status: 'approved', automatic: true } }; },
    });
    const onChanged = jest.fn();
    const { container } = render(<TerraformAccessCard onChanged={onChanged} />);
    expect(await screen.findByText(/enables Terraform automatically when all of these are in place/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enable Terraform' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(asked).toBe(1);
    expect(calls.filter(([m]) => m === 'POST')).toHaveLength(1);
    await waitFor(() => expect(container.querySelector('[data-testid="terraform-access-card"]')).toBeNull()); // approved: nothing left to say
  });
  it('with failing checks and automatic approval on, the button still only asks (it does not claim to enable)', async () => {
    fakeFetch({ 'GET /api/terraform-access': () => ({ data: summary({ autoApprove: true, checks: checks({ cloud: false }) }) }) });
    render(<TerraformAccessCard />);
    expect(await screen.findByRole('button', { name: 'Ask for access' })).toBeTruthy();
  });
  it('the operator sees "Enable Terraform" even with checks failing, and is told why', async () => {
    fakeFetch({ 'GET /api/terraform-access': () => ({ data: summary({ operator: true, checks: checks({ authenticator: false, cloud: false }) }) }) });
    render(<TerraformAccessCard />);
    expect(await screen.findByText(/You run this server, so you can enable it without these/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable Terraform' })).toBeTruthy();
  });
  it('a pending request has no button; a withdrawn one shows the operator\'s note and no checklist', async () => {
    fakeFetch({ 'GET /api/terraform-access': () => ({ data: summary({ status: 'requested' }) }) });
    const first = render(<TerraformAccessCard />);
    expect(await screen.findByText('Waiting for an operator to approve your request')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    first.unmount();
    fakeFetch({ 'GET /api/terraform-access': () => ({ data: summary({ status: 'revoked', note: 'abuse report', canRequest: false }) }) });
    render(<TerraformAccessCard />);
    expect(await screen.findByText('An operator withdrew access for this organization')).toBeTruthy();
    expect(screen.getByText(/Operator's note: abuse report/)).toBeTruthy();
    expect(screen.queryByText(/Authenticator app turned on/)).toBeNull();
  });
  it('a member who cannot ask is told who can; a failed request shows why', async () => {
    fakeFetch({ 'GET /api/terraform-access': () => ({ data: summary({ canRequest: false }) }) });
    const first = render(<TerraformAccessCard />);
    expect(await screen.findByText(/Ask an owner or admin of the organization to request it/)).toBeTruthy();
    first.unmount();
    fakeFetch({ 'GET /api/terraform-access': () => ({ data: summary() }), 'POST /api/terraform-access': () => ({ ok: false, message: 'Only an owner or admin of the organization can ask for Terraform access.' }) });
    render(<TerraformAccessCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask for access' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Only an owner or admin');
  });
});

describe('the operator page', () => {
  const entry = (over: Record<string, unknown>) => ({ orgId: 'o1', orgName: 'Acme', status: 'requested', source: 'operator', requestedBy: 'owner@acme.test', requestedAt: '2026-10-13T08:00:00Z', decidedBy: null, decidedAt: null, note: null, checks: checks({ cloud: false }), updatedAt: 'x', ...over });

  it('lists requests with who asked and which checks failed, and approves with a note', async () => {
    let list = [entry({})];
    const bodies: unknown[] = [];
    fakeFetch({
      'GET /api/operator/terraform-access': () => ({ data: { entries: list, autoApprove: false, envListed: [] } }),
      'PUT /api/operator/terraform-access/o1': (init) => { bodies.push(JSON.parse(init!.body!)); list = [entry({ status: 'approved', decidedBy: 'ops@platform.test' })]; return { data: { status: 'approved' } }; },
    });
    render(<OperatorAccessPanel />);
    const card = (await screen.findByTestId('access-entry'));
    expect(within(card).getByText('Acme')).toBeTruthy();
    expect(within(card).getByText(/Asked by owner@acme.test on 2026-10-13/)).toBeTruthy();
    expect(within(card).getByText(/No cloud account connected/)).toBeTruthy();
    expect(screen.getByText(/Automatic approval is off/)).toBeTruthy();
    fireEvent.change(within(card).getByLabelText('Note for Acme'), { target: { value: 'trial customer' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(bodies).toEqual([{ action: 'approve', note: 'trial customer' }]));
    expect(await screen.findByText(/by ops@platform.test/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
  it('an approved organization can be revoked, a request can be denied, and the page says when approval is automatic', async () => {
    const bodies: unknown[] = [];
    fakeFetch({
      'GET /api/operator/terraform-access': () => ({ data: { entries: [entry({ orgId: 'o1', status: 'approved', source: 'auto', decidedBy: 'automatic', checks: checks() }), entry({ orgId: 'o2', orgName: 'Bravo' })], autoApprove: true, envListed: ['o1'] } }),
      'PUT /api/operator/terraform-access/o1': (init) => { bodies.push(JSON.parse(init!.body!)); return { data: {} }; },
      'PUT /api/operator/terraform-access/o2': (init) => { bodies.push(JSON.parse(init!.body!)); return { data: {} }; },
    });
    render(<OperatorAccessPanel />);
    const [acme, bravo] = await screen.findAllByTestId('access-entry');
    expect(screen.getByText(/approved automatically/)).toBeTruthy();
    expect(within(acme!).getByText('automatically')).toBeTruthy();
    expect(within(acme!).getByText(/also on the server's list/)).toBeTruthy();
    fireEvent.click(within(acme!).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    await waitFor(() => expect((within(bravo!).getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(false)); // one decision at a time
    fireEvent.click(within(bravo!).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(bodies).toEqual([{ action: 'revoke', note: '' }, { action: 'deny', note: '' }]));
  });
  it('someone who is not an operator sees the server\'s refusal and no data', async () => {
    fakeFetch({ 'GET /api/operator/terraform-access': () => ({ ok: false, message: 'Only a platform operator can see this.' }) });
    render(<OperatorAccessPanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('Only a platform operator');
    expect(screen.queryByTestId('access-entry')).toBeNull();
  });
  it('says so when nobody has asked', async () => {
    fakeFetch({ 'GET /api/operator/terraform-access': () => ({ data: { entries: [], autoApprove: false, envListed: [] } }) });
    render(<OperatorAccessPanel />);
    expect(await screen.findByText('No organization has asked yet.')).toBeTruthy();
  });
});

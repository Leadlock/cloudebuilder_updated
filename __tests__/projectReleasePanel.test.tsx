/**
 * @jest-environment jsdom
 */
/**
 * "Deploy from CloudCraft" in the browser: plan, confirm with the password, watch the steps, enter the secrets it asks for, and what is and is not kept.
 */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { defaultProject, LAYERS } from '@/lib/engines/containers/stackProject';
import ProjectReleasePanel from '@/components/panels/ProjectReleasePanel';

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let routes: Array<[RegExp, (c: Call) => { status?: number; data?: unknown; code?: string; message?: string }]> = [];

const stack = (() => { const p = defaultProject(); p.name = 'shop'; for (const l of LAYERS) p.layers[l].enabled = ['backend', 'api'].includes(l); p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }]; p.deploy.target = 'azure-vm'; return p; })();
const STEPS = (states: Record<string, string> = {}) => ['infrastructure', 'secrets', 'build', 'publish', 'start', 'verify'].map((name) => ({ name, state: states[name] ?? 'pending', ...(states[`${name}_msg`] ? { message: states[`${name}_msg`] } : {}) }));
const release = (over: Record<string, unknown> = {}) => ({ id: 'rel-1', project: 'shop', imageTag: 'v1', status: 'planned', steps: STEPS(), error: null, log: [], secrets: ['JWT_SECRET'], planId: 'plan-1', planHash: 'h'.repeat(64), outputs: null, ...over });
const PLAN = { release: release(), plan: { planId: 'plan-1', planHash: 'h'.repeat(64), summary: { toAdd: 18, toChange: 0, toDestroy: 0 }, expiresAt: 'later' }, cost: { monthlyUsd: 87.64 }, warnings: ['Azure VM: the "latest" tag is used.'] };

beforeEach(() => {
  calls = []; routes = [];
  localStorage.clear();
  localStorage.setItem('cloudcraft_tf_backend_p1', JSON.stringify({ azureBackend: { resourceGroupName: 'rg-state', storageAccountName: 'tfstateacct', containerName: 'tfstate', key: 'cloudcraft/terraform.tfstate' } }));
  routes.push([/GET \/api\/cloud-accounts\?provider=azure/, () => ({ data: [{ id: 'acct-1', name: 'Test subscription', provider: 'azure' }, { id: 'acct-2', name: 'Key only', provider: 'azure', identity: { authMethod: 'access-key' } }] })]);
  routes.push([/GET \/api\/projects\/p1\/releases\?/, () => ({ data: { releases: [] } })]);
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const call = { method, path, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const hit = routes.find(([re]) => re.test(`${method} ${path}`));
    const r = hit ? hit[1](call) : { status: 404, code: 'NOT_FOUND', message: 'no route' };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => (status < 400 ? { ok: true, data: r.data } : { ok: false, error: { code: r.code ?? 'ERROR', message: r.message ?? 'failed' } }) };
  });
});

const mount = () => render(<ProjectReleasePanel projectId="p1" environment="production" stack={stack} isLight />);
const plan = async () => {
  routes.unshift([/POST \/api\/projects\/p1\/releases$/, () => ({ status: 201, data: PLAN })]);
  mount();
  await waitFor(() => expect((screen.getByLabelText('State: resource group') as HTMLInputElement).value).toBe('rg-state'));
  fireEvent.click(screen.getByRole('button', { name: 'Plan the deployment' }));
  await screen.findByTestId('release-plan');
};

describe('planning', () => {
  test('offers the Azure accounts that can run Terraform, fills in the storage the Deploy tab knows, and gives the project its own state file', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Test subscription' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Key only' })).toBeNull();
    expect((screen.getByLabelText('State: storage account') as HTMLInputElement).value).toBe('tfstateacct');
    expect((screen.getByLabelText('State: file name') as HTMLInputElement).value).toBe('cloudcraft/releases/shop-production.tfstate');   // not the architecture's file
  });

  test('sends the project settings, the account and the state, and shows what will be created, the cost, the warnings and the secrets', async () => {
    await plan();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ environment: 'production', cloudAccountId: 'acct-1', stateBackend: { provider: 'azure', resourceGroupName: 'rg-state', storageAccountName: 'tfstateacct', containerName: 'tfstate', key: 'cloudcraft/releases/shop-production.tfstate' }, project: { name: 'shop' } });
    const text = screen.getByTestId('release-plan').textContent!;
    expect(text).toContain('18 to create, 0 to change, 0 to destroy');
    expect(text).toContain('$87.64 a month');
    expect(text).toContain('JWT_SECRET');
    expect(text).toContain('"latest" tag is used');
  });

  test('a refusal from the server is shown, and nothing is offered to confirm', async () => {
    routes.unshift([/POST \/api\/projects\/p1\/releases$/, () => ({ status: 400, code: 'BAD_REQUEST', message: 'Frontend: Port must be 1-65535' })]);
    mount();
    await waitFor(() => expect((screen.getByLabelText('State: resource group') as HTMLInputElement).value).toBe('rg-state'));
    fireEvent.click(screen.getByRole('button', { name: 'Plan the deployment' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Frontend: Port must be 1-65535');
    expect(screen.queryByTestId('release-plan')).toBeNull();
  });

  test('without the storage for Terraform\'s record there is nothing to plan', async () => {
    localStorage.clear();
    mount();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Test subscription' })).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Plan the deployment' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('a server that has this switched off says so and offers the terminal way', async () => {
    routes.unshift([/GET \/api\/projects\/p1\/releases\?/, () => ({ status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Deploying a project from CloudCraft is not switched on on this server (CLOUDCRAFT_PROJECT_RELEASES=1).' })]);
    mount();
    expect(await screen.findByText(/not switched on on this server/)).toBeTruthy();
    expect(document.body.textContent).toContain('bash deploy.sh');
    expect(screen.queryByRole('button', { name: 'Plan the deployment' })).toBeNull();
  });

  test('without a project there is nothing to deploy from', () => {
    render(<ProjectReleasePanel projectId={null} environment="production" stack={stack} isLight />);
    expect(screen.getByText(/Open or create a project first/)).toBeTruthy();
    expect(calls).toEqual([]);
  });
});

describe('confirming and running', () => {
  test('confirms with the password for exactly this plan, then runs the release, and forgets the password', async () => {
    routes.unshift([/POST \/api\/projects\/p1\/terraform\/confirm$/, () => ({ status: 200, data: { approval: { id: 'a1' } } })]);
    routes.unshift([/POST \/api\/projects\/p1\/releases\/rel-1\/run$/, () => ({ status: 201, data: { releaseId: 'rel-1', jobId: 'j1', status: 'approved' } })]);
    routes.unshift([/GET \/api\/projects\/p1\/releases\/rel-1$/, () => ({ data: { release: release({ status: 'running', steps: STEPS({ infrastructure: 'running' }) }), missing: null } })]);
    await plan();
    const pw = screen.getByLabelText('Your password') as HTMLInputElement;
    expect((screen.getByRole('button', { name: 'Confirm and deploy' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(pw, { target: { value: 'my-account-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and deploy' }));
    await screen.findByTestId('release-status');
    const sent = calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(sent.slice(-2)).toEqual(['/api/projects/p1/terraform/confirm', '/api/projects/p1/releases/rel-1/run']);
    expect(calls.find((c) => c.path.endsWith('/confirm'))!.body).toEqual({ action: 'apply', planId: 'plan-1', planHash: 'h'.repeat(64), password: 'my-account-password' });
    expect(screen.queryByLabelText('Your password')).toBeNull();
    expect(JSON.stringify([...Object.entries(localStorage)])).not.toContain('my-account-password');
    expect(screen.getByTestId('release-state').textContent).toBe('running');
  });

  test('a wrong password stops there and nothing is run; an authenticator code is asked for when needed', async () => {
    routes.unshift([/POST \/api\/projects\/p1\/terraform\/confirm$/, (c) => ((c.body as { code?: string }).code ? { status: 403, code: 'WRONG_PASSWORD', message: 'That password is not right. 4 tries left.' } : { status: 400, code: 'CODE_REQUIRED', message: 'Also enter the 6-digit code from your authenticator app.' })]);
    await plan();
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and deploy' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/6-digit code/);
    fireEvent.change(await screen.findByLabelText('Code from your authenticator app'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and deploy' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not right/));
    expect(calls.some((c) => c.path.endsWith('/run'))).toBe(false);
    expect(screen.getByTestId('release-plan')).toBeTruthy();
  });
});

describe('watching a release', () => {
  const showing = async (r: Record<string, unknown>, missing: string[] | null = null) => {
    routes.unshift([/GET \/api\/projects\/p1\/releases\?/, () => ({ data: { releases: [r] } })]);
    routes.unshift([/GET \/api\/projects\/p1\/releases\/rel-1$/, () => ({ data: { release: r, missing } })]);
    mount();
    await screen.findByTestId('release-status');
  };

  test('shows each step and what happened, without the ones that do not apply', async () => {
    await showing(release({ status: 'running', steps: [...STEPS({ infrastructure: 'done', infrastructure_msg: 'Created rg-shop', secrets: 'done', build: 'running' })].map((s) => (s.name === 'start' ? { ...s, state: 'skipped' } : s)), log: ['build: started', 'Building api'] }));
    const text = screen.getByTestId('release-status').textContent!;
    expect(text).toContain('Create the resource group, registry, vault and VM · Created rg-shop');
    expect(text).toContain('Build the images in Azure');
    expect(text).not.toContain('Start the services');
    expect(text).toContain('Building api');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  test('a release that waits asks for the missing secrets as password fields, sends them once, and clears them', async () => {
    const waiting = release({ status: 'waiting', steps: STEPS({ infrastructure: 'done', secrets: 'waiting', secrets_msg: 'Waiting for JWT_SECRET' }) });
    routes.unshift([/POST \/api\/projects\/p1\/releases\/rel-1\/secrets$/, () => ({ status: 201, data: { missing: [], continued: true } })]);
    await showing(waiting, ['JWT_SECRET']);
    const field = screen.getByLabelText('JWT_SECRET') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('off');
    expect((screen.getByRole('button', { name: 'Store the secrets and continue' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'jwt-value_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Store the secrets and continue' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/secrets'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/secrets'))!.body).toEqual({ values: { JWT_SECRET: 'jwt-value_1' } });
    await waitFor(() => expect((screen.getByLabelText('JWT_SECRET') as HTMLInputElement).value).toBe(''));
    expect(JSON.stringify([...Object.entries(localStorage)])).not.toContain('jwt-value_1');
  });

  test('a refused secret shows the reason and is not kept in the field', async () => {
    routes.unshift([/POST \/api\/projects\/p1\/releases\/rel-1\/secrets$/, () => ({ status: 400, code: 'BAD_REQUEST', message: 'JWT_SECRET may use only letters, digits and . _ ~ - (no spaces or other symbols), up to 200 characters.' })]);
    await showing(release({ status: 'waiting', steps: STEPS({ infrastructure: 'done', secrets: 'waiting' }) }), ['JWT_SECRET']);
    fireEvent.change(screen.getByLabelText('JWT_SECRET'), { target: { value: 'has space' } });
    fireEvent.click(screen.getByRole('button', { name: 'Store the secrets and continue' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/may use only letters/);
    expect((screen.getByLabelText('JWT_SECRET') as HTMLInputElement).value).toBe('');
  });

  test('a success shows the address', async () => {
    await showing(release({ status: 'succeeded', steps: STEPS({ infrastructure: 'done', secrets: 'done', build: 'done', publish: 'done', start: 'done', verify: 'done' }), outputs: { url: 'http://203.0.113.9:8080/', resourceGroup: 'rg-shop', vmName: 'vm-shop' } }));
    expect(screen.getByRole('link', { name: 'http://203.0.113.9:8080/' }).getAttribute('href')).toBe('http://203.0.113.9:8080/');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  test('a rollback is explained', async () => {
    await showing(release({ status: 'rolled_back', error: 'verify: did not answer. The previous release (v0) was put back and answers.', steps: STEPS({ infrastructure: 'done', secrets: 'done', build: 'done', publish: 'rolled_back', start: 'rolled_back', verify: 'failed' }) }));
    expect(screen.getByTestId('release-status').textContent).toContain('the previous one was put back and answers');
  });

  test('a failure after the infrastructure can be retried; before it, the deployment has to be planned again', async () => {
    routes.unshift([/POST \/api\/projects\/p1\/releases\/rel-1\/run$/, () => ({ status: 201, data: { releaseId: 'rel-1', status: 'failed' } })]);
    await showing(release({ status: 'failed', error: 'build: The build of shop-api:v1 failed.', steps: STEPS({ infrastructure: 'done', secrets: 'done', build: 'failed' }) }));
    expect(screen.getByTestId('release-status').textContent).toContain('build: The build of shop-api:v1 failed.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry from the failed step' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/run'))).toBe(true));
  });

  test('a failed release whose infrastructure was never created offers no retry', async () => {
    await showing(release({ status: 'failed', error: 'infrastructure: terraform apply failed', steps: STEPS({ infrastructure: 'failed' }) }));
    expect(screen.queryByRole('button', { name: 'Retry from the failed step' })).toBeNull();
    expect(screen.getByTestId('release-status').textContent).toContain('Plan the deployment again');
  });

  test('cancel is sent for a release that is going on', async () => {
    routes.unshift([/POST \/api\/projects\/p1\/releases\/rel-1\/cancel$/, () => ({ data: { release: release({ status: 'cancelled' }) } })]);
    await showing(release({ status: 'running', steps: STEPS({ infrastructure: 'running' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(true));
  });

  test('a release that is going on is followed until it ends', async () => {
    jest.useFakeTimers();
    try {
      let n = 0;
      const states = [release({ status: 'running', steps: STEPS({ infrastructure: 'running' }) }), release({ status: 'running', steps: STEPS({ infrastructure: 'done', secrets: 'running' }) }), release({ status: 'succeeded', steps: STEPS({ infrastructure: 'done', secrets: 'done', build: 'done', publish: 'done', start: 'done', verify: 'done' }) })];
      routes.unshift([/GET \/api\/projects\/p1\/releases\/rel-1$/, () => ({ data: { release: states[Math.min(n++, 2)], missing: null } })]);
      routes.unshift([/GET \/api\/projects\/p1\/releases\?/, () => ({ data: { releases: [states[0]] } })]);
      mount();
      await act(async () => { await Promise.resolve(); });
      await screen.findByTestId('release-status');
      for (let i = 0; i < 3; i++) await act(async () => { jest.advanceTimersByTime(3100); await Promise.resolve(); });
      await waitFor(() => expect(screen.getByTestId('release-state').textContent).toBe('succeeded'));
      const before = calls.length;
      await act(async () => { jest.advanceTimersByTime(10_000); await Promise.resolve(); });
      expect(calls.length).toBe(before);       // it stopped asking once it was over
    } finally { jest.useRealTimers(); }
  });
});

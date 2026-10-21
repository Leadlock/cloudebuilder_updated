/**
 * @jest-environment jsdom
 */
/** The API keys card in the Templates gallery: make a key and see it once, with how to use it; see the keys; revoke one. */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ApiKeysCard from '@/components/templates/ApiKeysCard';

type Call = { method: string; path: string; body?: Record<string, unknown> };
let calls: Call[]; let keys: unknown[];
const REC = { id: 'k1', orgId: 'o1', name: 'Marketplace', keyPrefix: 'cb_abcdef', scope: 'templates:read', includeBuiltin: true, includeOwn: false, createdBy: 'a', createdAt: '2026-10-21T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null };
const KEY = `cb_${'A'.repeat(43)}`;

beforeEach(() => {
  calls = []; keys = [REC];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ ok: true, data: { keys } }) };
    if (method === 'POST') return { ok: true, status: 201, json: async () => ({ ok: true, data: { key: KEY, record: REC } }) };
    if (method === 'DELETE') { keys = [{ ...REC, revokedAt: '2026-10-21T01:00:00Z' }]; return { ok: true, status: 200, json: async () => ({ ok: true, data: { revoked: true } }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  window.confirm = jest.fn(() => true);
});

const open = async () => { render(<ApiKeysCard isLight />); fireEvent.click(screen.getByRole('button', { name: /API keys for other systems/ })); await waitFor(() => expect(screen.getByText('Marketplace')).toBeTruthy()); };

describe('API keys card', () => {
  test('lists the keys with what each reads and its state, and never a key', async () => {
    await open();
    const row = screen.getByText('Marketplace').closest('tr')!.textContent!;
    expect(row).toContain('cb_abcdef…');
    expect(row).toContain('built-in');
    expect(row).not.toContain('ours');
    expect(row).toContain('active');
  });
  test('making a key shows it once, with the command that uses it, and sends the choices', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Neozaar marketplace' } });
    fireEvent.click(screen.getByLabelText('Can read our own templates'));        // switch off one of the two kinds
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(screen.getByTestId('new-key')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Neozaar marketplace', includeBuiltin: true, includeOwn: false, expiresInDays: 30 });
    expect(screen.getByTestId('new-key').textContent).toContain(KEY);
    expect(screen.getByTestId('new-key').textContent).toContain('/api/public/templates?graphs=1');
    expect(screen.getByTestId('new-key').textContent).toContain('not shown again');
  });
  test('a key must have a name and read at least one kind of template', async () => {
    await open();
    const create = screen.getByRole('button', { name: 'Create key' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'x' } });
    expect(create.disabled).toBe(false);
    fireEvent.click(screen.getByLabelText('Can read the built-in templates'));
    fireEvent.click(screen.getByLabelText('Can read our own templates'));          // both off now
    expect(create.disabled).toBe(true);
  });
  test('revoking asks first, then the key is shown as revoked with no revoke button', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.getByText(/revoked/)).toBeTruthy());
    expect(window.confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/api-keys/k1')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
  test('a refusal (not an administrator) is shown', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch.mockImplementation(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: { message: 'Only an administrator can manage API keys.' } }) }));
    render(<ApiKeysCard isLight />);
    fireEvent.click(screen.getByRole('button', { name: /API keys for other systems/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Only an administrator can manage API keys.'));
  });
});

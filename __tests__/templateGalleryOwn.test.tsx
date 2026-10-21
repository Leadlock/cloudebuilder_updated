/**
 * @jest-environment jsdom
 */
/** The Templates gallery with the organization's own templates from the database, saving the open project as one, and downloading a template as a file. */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockDispatch = jest.fn();
let mockProject: { id: string; name: string; provider: string; nodes: unknown[]; edges: unknown[] } | null;
jest.mock('@/context/AppContext', () => ({
  useApp: () => ({ state: { theme: 'dark', displayCurrency: 'USD' }, dispatch: mockDispatch }),
  useActiveProject: () => mockProject,
}));

const mkTemplate = (id: string, name: string, provider: string, category: string) => ({
  id, name, description: `${name} description`, provider, category, tags: [], complexity: 'simple', estimatedCost: 10, resourceCount: 1, features: [],
  generate: () => ({ nodes: [{ id: 'n', type: 'aws_vpc', label: 'VPC', position: { x: 0, y: 0 }, config: {} }], edges: [] }),
});
// A few built-in templates: the real list is 250 cards, which makes every render in this test slow.
jest.mock('@/lib/templates', () => ({
  architectureTemplates: [mkTemplate('b1', 'Three-Tier Web App', 'aws', 'Web Applications'), mkTemplate('b2', 'Serverless API', 'aws', 'Serverless'), mkTemplate('b3', 'Microservices on AKS', 'azure', 'Microservices')],
}));

import TemplateGallery from '@/components/templates/TemplateGallery';

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let listed: unknown[];
const OWN = { id: 'org-1', orgId: 'o1', source: 'org', name: 'Our standard stack', description: 'Ours', provider: 'aws', category: 'Custom', complexity: 'simple', tags: [], features: [], estimatedCost: 0, resourceCount: 1, meta: {}, createdBy: 'a@x.com', createdAt: 't', updatedAt: 't',
  graph: { nodes: [{ id: 'n1', type: 'aws_vpc', label: 'VPC', position: { x: 0, y: 0 }, config: {} }], edges: [] } };

beforeEach(() => {
  calls = []; listed = [OWN]; mockDispatch.mockClear();
  mockProject = { id: 'p1', name: 'Shop', provider: 'aws', nodes: [{ id: 'a', type: 'aws_vpc', label: 'VPC', position: { x: 0, y: 0 } }], edges: [] };
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path.startsWith('/api/architecture-templates') && method === 'GET') return { ok: true, status: 200, json: async () => ({ ok: true, data: { templates: listed } }) };
    if (path === '/api/architecture-templates' && method === 'POST') return { ok: true, status: 201, json: async () => ({ ok: true, data: { template: OWN } }) };
    if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true, data: { deleted: true } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
});

describe('the Templates gallery', () => {
  test('shows the organization\'s own templates (category Custom) next to the built-in ones, and the built-in ones when the database cannot be reached', async () => {
    render(<TemplateGallery />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(screen.getByText('Our standard stack')).toBeTruthy());
    expect(screen.queryByText(/Three-Tier/)).toBeNull();                      // only the Custom category is shown
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getAllByText(/Three-Tier|Serverless|Microservices/i).length).toBeGreaterThan(0);

    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => { throw new Error('down'); });
    const { container } = render(<TemplateGallery />);
    expect(container.textContent).toMatch(/Architecture Templates/);
  });

  test('the open project can be saved as a template: its name, its resources and its connections go to the server', async () => {
    render(<TemplateGallery />);
    fireEvent.click(screen.getByText('Save the open project as a template'));
    fireEvent.change(screen.getByLabelText('Template description'), { target: { value: 'For shops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved'));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ name: 'Shop', description: 'For shops', provider: 'aws', category: 'Custom', nodes: [{ id: 'a' }], edges: [] });
  });

  test('nothing to save from an empty project or none', () => {
    mockProject = { id: 'p1', name: 'Empty', provider: 'aws', nodes: [], edges: [] };
    const { unmount } = render(<TemplateGallery />);
    expect(screen.queryByText('Save the open project as a template')).toBeNull();
    unmount();
    mockProject = null;
    render(<TemplateGallery />);
    expect(screen.queryByText('Save the open project as a template')).toBeNull();
  });

  test('a server refusal is shown', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch.mockImplementation(async (path: string, init: RequestInit = {}) => (init.method === 'POST'
      ? { ok: false, status: 403, json: async () => ({ ok: false, error: { message: 'Viewers cannot save templates.' } }) }
      : { ok: true, status: 200, json: async () => ({ ok: true, data: { templates: [] } }) }));
    render(<TemplateGallery />);
    fireEvent.click(screen.getByText('Save the open project as a template'));
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Viewers cannot save templates.'));
  });
});

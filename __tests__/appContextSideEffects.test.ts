/**
 * @jest-environment jsdom
 */
/**
 * Regression test for a critical bug: the useEffect in AppContext.tsx that
 * mirrors dispatched actions (CREATE_PROJECT, DELETE_PROJECT, SAVE_PROJECT,
 * SET_ACTIVE_PROJECT, canvas autosave, etc.) to the backend API previously had
 * a dependency array of only `[triggerAutoSave]` — a stable useCallback — so
 * it ran once on mount and never again. Every mutating action after mount was
 * silently applied to local state only and never persisted, with no error
 * surfaced anywhere. This test renders the real AppProvider, dispatches
 * CREATE_PROJECT, and asserts the injected architecture service is actually
 * invoked. If the effect's dependency array regresses, this test fails.
 */
import React from 'react';
import { render, act, waitFor } from '@testing-library/react';

// uuid ships ESM-only and Jest's CJS transform can't load it directly on this
// setup; AppContext only uses it to mint client-side ids, so a trivial stub
// is sufficient here and avoids fighting the module system for a test that
// isn't about id generation.
let __idCounter = 0;
jest.mock('uuid', () => ({ v4: () => `test-uuid-${++__idCounter}` }));

// AppContext makes a handful of direct fetch() calls on mount (session check,
// etc.) unrelated to the architecture service under test here. jsdom's test
// environment doesn't provide a global fetch; stub one that fails cleanly so
// those unrelated mount-time calls no-op instead of throwing.
global.fetch = jest.fn(async () => ({
  ok: false,
  status: 404,
  json: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'stub' } }),
})) as unknown as typeof fetch;

import { AppProvider, useApp, setArchitectureService } from '@/context/AppContext';
import type { IArchitectureService } from '@/lib/services/ArchitectureService';
import type { Project } from '@/types';

function makeProject(id: string, name: string): Project {
  const now = new Date().toISOString();
  return {
    id,
    name,
    provider: 'aws',
    description: '',
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    resourceCount: 0,
    securityScore: 100,
    architectureScore: 0,
    estimatedMonthlyCost: 0,
    environment: 'production',
    region: 'us-east-1',
    versions: [],
    tags: [],
    environments: {
      production: { id: 'production', label: 'Production', nodes: [], edges: [], region: 'us-east-1' },
      staging: { id: 'staging', label: 'Staging', nodes: [], edges: [], region: 'us-east-1' },
      development: { id: 'development', label: 'Development', nodes: [], edges: [], region: 'us-east-1' },
    },
  };
}

describe('AppContext dispatched-action side effects', () => {
  it('actually invokes the architecture service when CREATE_PROJECT is dispatched', async () => {
    const createProject = jest.fn(async (name: string, _provider) => makeProject('server-id-1', name));
    const mockService: IArchitectureService = {
      getProjects: jest.fn(async () => []),
      getProject: jest.fn(async () => null),
      saveProject: jest.fn(async (p) => p),
      deleteProject: jest.fn(async () => {}),
      saveCanvas: jest.fn(async () => ({})),
      loadCanvas: jest.fn(async () => ({ nodes: [], edges: [] })),
      createProject,
      listVersions: jest.fn(async () => []),
      saveVersion: jest.fn(async () => { throw new Error('not used in this test'); }),
      restoreVersion: jest.fn(async () => ({ nodes: [], edges: [] })),
      cloneEnvironment: jest.fn(async () => ({ cloned: true, from: 'production', to: 'staging', nodeCount: 0 })),
      promoteEnvironment: jest.fn(async () => ({ promoted: true, from: 'staging', to: 'production', nodeCount: 0 })),
      saveDraft: jest.fn(async () => ({})),
      loadDraft: jest.fn(async () => null),
      clearDraft: jest.fn(async () => {}),
    };
    setArchitectureService(mockService);

    let dispatchRef: ((action: unknown) => void) | null = null;
    function Harness() {
      const { dispatch } = useApp();
      dispatchRef = dispatch as unknown as (action: unknown) => void;
      return null;
    }

    render(
      React.createElement(AppProvider, null, React.createElement(Harness, null)),
    );

    await waitFor(() => expect(dispatchRef).not.toBeNull());

    act(() => {
      dispatchRef!({ type: 'CREATE_PROJECT', name: 'Regression Test Project', provider: 'aws' });
    });

    // The bug under regression: if the mirroring effect's dependency array is
    // too narrow, this call never happens — the assertion below is the entire
    // point of the test.
    await waitFor(() => expect(createProject).toHaveBeenCalledWith('Regression Test Project', 'aws'));
  });
});

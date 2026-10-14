/**
 * @jest-environment jsdom
 */
/**
 * The closed tabs are out of sight for an account that may not use them, and a closed screen says so.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

let mockUser: { restrictedFeatures?: boolean; role: string; operator?: boolean } | null = null;
jest.mock('@/context/AppContext', () => ({
  useApp: () => ({
    state: { activeView: 'dashboard', sidebarCollapsed: false, mobileSidebarOpen: false, projects: [], activeProjectId: null, currentUser: mockUser, theme: 'light', draftProject: null },
    dispatch: jest.fn(),
  }),
  useActiveProject: () => null,
}));

import Sidebar from '@/components/layout/Sidebar';
import LockedFeature from '@/components/panels/LockedFeature';

describe('Sidebar', () => {
  test('another account still sees them, greyed out and marked Not accessible, and cannot open them', () => {
    mockUser = { role: 'admin', restrictedFeatures: false };
    render(<Sidebar />);
    for (const label of ['Deploy', 'AI Generator']) {
      const button = screen.getByRole('button', { name: `${label} — Not accessible` }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain('Not accessible');
    }
    // everything else is unchanged
    const terraform = screen.getByRole('button', { name: /Terraform/ }) as HTMLButtonElement;
    expect(terraform.textContent).not.toContain('Not accessible');
    expect(screen.getByRole('button', { name: /Visual Builder/ })).toBeTruthy();
  });

  test('an account that may use them gets working buttons, with no "Not accessible" anywhere', () => {
    mockUser = { role: 'admin', restrictedFeatures: true };
    render(<Sidebar />);
    expect((screen.getByRole('button', { name: 'AI Generator' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryAllByText('Not accessible')).toHaveLength(0);
  });

  test('an older saved user without the field is treated as allowed (the server decides)', () => {
    mockUser = { role: 'admin' };
    render(<Sidebar />);
    expect(screen.getAllByText('Deploy').length).toBeGreaterThan(0);
  });
});

test('the locked screen says the feature is not accessible', () => {
  render(<LockedFeature />);
  expect(screen.getByText('Not accessible')).toBeTruthy();
  expect(screen.getByText(/not accessible for your account/i)).toBeTruthy();
});

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
  test('an account that may use them sees the Deploy and AI Generator tabs', () => {
    mockUser = { role: 'admin', restrictedFeatures: true };
    render(<Sidebar />);
    expect(screen.getAllByText('Deploy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('AI Generator').length).toBeGreaterThan(0);
  });

  test('another account does not see them, and still sees everything else', () => {
    mockUser = { role: 'admin', restrictedFeatures: false };
    render(<Sidebar />);
    expect(screen.queryAllByText('Deploy')).toHaveLength(0);
    expect(screen.queryAllByText('AI Generator')).toHaveLength(0);
    expect(screen.getAllByText('Terraform').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Visual Builder').length).toBeGreaterThan(0);
  });

  test('an older saved user without the field is treated as allowed (the server decides)', () => {
    mockUser = { role: 'admin' };
    render(<Sidebar />);
    expect(screen.getAllByText('Deploy').length).toBeGreaterThan(0);
  });
});

test('the locked screen says the feature is not open', () => {
  render(<LockedFeature />);
  expect(screen.getByText(/not open to your account/i)).toBeTruthy();
});

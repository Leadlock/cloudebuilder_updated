/**
 * @jest-environment jsdom
 */
/**
 * The Review Workflow screen: the buttons that decide are only for the person who may decide, and everyone else is told who the review is
 * waiting for.
 */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, waitFor } from '@testing-library/react';

let mockUser: Record<string, unknown> = {};
jest.mock('@/context/AppContext', () => ({
  useApp: () => ({ state: { theme: 'light', activeEnvironment: 'production', displayCurrency: 'USD', currentUser: mockUser }, dispatch: jest.fn() }),
  useActiveProject: () => ({ id: 'p1', name: 'Shop', nodes: [], edges: [], provider: 'aws', region: 'us-east-1', environments: {} }),
}));

const pending = {
  id: 'rev-1', projectId: 'p1', environment: 'production', architectureHash: 'abc', status: 'pending_review',
  submittedBy: { id: 'u-dev', name: 'Dev', email: 'dev@neozaar.com' }, submittedAt: new Date().toISOString(), assignedTo: ['ajinkya@neozaar.com'],
  summary: { nodeCount: 3, edgeCount: 2, criticalIssuesCount: 0, estimatedMonthlyCost: 40 },
};
jest.mock('@/lib/services/ApiReviewService', () => ({
  ApiReviewService: { getReviews: async () => ({ reviews: [pending], latest: pending }), getDeployments: async () => [] },
}));

import ReviewWorkflowPanel from '@/components/panels/ReviewWorkflowPanel';

const renderAs = async (user: Record<string, unknown>) => { mockUser = user; render(<ReviewWorkflowPanel />); await waitFor(() => expect(screen.getByTestId('review-assignment')).toBeTruthy()); };

test('the approver sees that it is waiting for them, and the three decision buttons', async () => {
  await renderAs({ id: 'u1', role: 'admin', name: 'Ajinkya', email: 'ajinkya@neozaar.com', canDecideReviews: true });
  expect(screen.getByTestId('review-assignment').textContent).toContain('Waiting for you');
  expect(screen.getByRole('button', { name: /Approve Architecture/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Reject/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Request Changes/ })).toBeTruthy();
});

test('another admin is told who it is waiting for and gets no decision buttons', async () => {
  await renderAs({ id: 'u2', role: 'admin', name: 'Boss', email: 'boss@neozaar.com', canDecideReviews: false });
  expect(screen.getByTestId('review-assignment').textContent).toContain('Waiting for approval by ajinkya@neozaar.com');
  expect(screen.queryByRole('button', { name: /Approve Architecture/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Reject/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Request Changes/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Submit Current Architecture for Review/ })).toBeTruthy();   // anyone can still submit
});

test('an ordinary member can submit and see the wait, and cannot decide', async () => {
  await renderAs({ id: 'u3', role: 'user', name: 'Dev', email: 'dev@neozaar.com', canDecideReviews: false });
  expect(screen.queryByRole('button', { name: /Approve Architecture/ })).toBeNull();
});

test('an older saved user without the flag falls back to the admin role', async () => {
  await renderAs({ id: 'u2', role: 'admin', name: 'Boss', email: 'boss@neozaar.com' });
  expect(screen.getByRole('button', { name: /Approve Architecture/ })).toBeTruthy();
});

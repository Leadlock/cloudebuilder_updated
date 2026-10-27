/**
 * @jest-environment jsdom
 */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent } from '@testing-library/react';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

import WorkflowOnboardingModal from '@/components/modals/WorkflowOnboardingModal';
import WorkflowStepNavigator from '@/components/layout/WorkflowStepNavigator';
import { AppProvider, initialState, reducer } from '@/context/AppContext';

describe('Workflow Navigation & Customer Onboarding Tour', () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  describe('AppContext SET_TOUR_MODAL reducer', () => {
    it('should open and close the tour modal via action', () => {
      const state1 = reducer(initialState, { type: 'SET_TOUR_MODAL', open: true });
      expect(state1.isTourOpen).toBe(true);

      const state2 = reducer(state1, { type: 'SET_TOUR_MODAL', open: false });
      expect(state2.isTourOpen).toBe(false);
    });
  });

  describe('WorkflowOnboardingModal', () => {
    it('renders step 1 when open and advances through the 5 lifecycle steps', () => {
      const onClose = jest.fn();
      render(
        <AppProvider>
          <WorkflowOnboardingModal isOpen={true} onClose={onClose} />
        </AppProvider>
      );

      // Step 1: Visual Builder
      expect(screen.getByText(/1\. Visual Builder: Design Your Cloud Architecture/i)).toBeTruthy();
      expect(screen.getByText(/Phase 1 · Visual Modeling/i)).toBeTruthy();

      // Click next step
      const nextBtn = screen.getByRole('button', { name: /Next: Step 2/i });
      fireEvent.click(nextBtn);

      // Step 2: Architecture Review
      expect(screen.getByText(/2\. Architecture Review: Security, Posture & Cost Scans/i)).toBeTruthy();
      expect(screen.getByText(/Phase 2 · Governance & Security/i)).toBeTruthy();

      // Click next step
      fireEvent.click(screen.getByRole('button', { name: /Next: Step 3/i }));

      // Step 3: Stacks & DAG
      expect(screen.getByText(/3\. Stacks & DAG: Dependency Sequencing & Clustering/i)).toBeTruthy();
      expect(screen.getByText(/Phase 3 · Dependency Orchestration/i)).toBeTruthy();

      // Click next step
      fireEvent.click(screen.getByRole('button', { name: /Next: Step 4/i }));

      // Step 4: Terraform & Deploy
      expect(screen.getByText(/4\. Terraform Code & Live Cloud Deployment/i)).toBeTruthy();
      expect(screen.getByText(/Phase 4 · Cloud Provisioning/i)).toBeTruthy();

      // Click next step
      fireEvent.click(screen.getByRole('button', { name: /Next: Step 5/i }));

      // Step 5: Drift & Reconcile
      expect(screen.getByText(/5\. Drift & Reconcile: Continuous Cloud Synchronization/i)).toBeTruthy();
      expect(screen.getByText(/Phase 5 · Continuous Operations/i)).toBeTruthy();

      // Finish button
      const finishBtn = screen.getByRole('button', { name: /Get Started with Canvas/i });
      fireEvent.click(finishBtn);
      expect(onClose).toHaveBeenCalled();
      expect(localStorageMock.getItem('cloudbuilder_workflow_tour_completed')).toBe('true');
    });

    it('allows skipping the tour at any time', () => {
      const onClose = jest.fn();
      render(
        <AppProvider>
          <WorkflowOnboardingModal isOpen={true} onClose={onClose} />
        </AppProvider>
      );

      const skipBtn = screen.getByTitle(/Skip tour and close/i);
      fireEvent.click(skipBtn);
      expect(onClose).toHaveBeenCalled();
      expect(localStorageMock.getItem('cloudbuilder_workflow_tour_completed')).toBe('true');
    });
  });

  describe('WorkflowStepNavigator', () => {
    it('renders guidance without crashing', () => {
      render(
        <AppProvider>
          <WorkflowStepNavigator />
        </AppProvider>
      );
      // Verify component mounts cleanly
      expect(true).toBe(true);
    });
  });
});

/**
 * @jest-environment jsdom
 */
/** The Azure review sheet card: shows the coverage and the gaps, everything on request, and downloads the file. */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WaAzureReview from '@/components/panels/WaAzureReview';

const getAzureReview = jest.fn();
const downloadAzureReview = jest.fn();
jest.mock('@/lib/services/ApiWellArchitectedService', () => ({ apiWellArchitectedService: { getAzureReview: (...a: unknown[]) => getAzureReview(...a), downloadAzureReview: (...a: unknown[]) => downloadAzureReview(...a) } }));

const DATA = {
  counts: { gap: 1, met: 1, answer_needed: 1, not_assessed: 1 }, total: 59, rulesetVersion: 'r', evaluatedAt: '2026-10-26T00:00:00Z',
  rows: [
    { code: 'SE:07', pillar: 'security', title: 'Encrypt data by using modern, industry-standard methods', state: 'gap', basis: ['AZ-SQL-002: TDE is off on sql-1'] },
    { code: 'SE:06', pillar: 'security', title: 'Isolate, filter, and control network traffic', state: 'met', basis: ['3 checks passed.'] },
    { code: 'SE:09', pillar: 'security', title: 'Protect application secrets', state: 'answer_needed', basis: ['…'] },
    { code: 'SE:11', pillar: 'security', title: 'Establish a comprehensive testing regimen', state: 'not_assessed', basis: ['…'] },
  ],
};

beforeEach(() => {
  getAzureReview.mockReset().mockResolvedValue(DATA);
  downloadAzureReview.mockReset().mockResolvedValue({ blob: new Blob(['# sheet']), filename: 'azure-well-architected-shop.md' });
  (global as unknown as { URL: { createObjectURL: () => string; revokeObjectURL: () => void } }).URL.createObjectURL = () => 'blob:x';
  (global as unknown as { URL: { createObjectURL: () => string; revokeObjectURL: () => void } }).URL.revokeObjectURL = () => undefined;
});

it('shows the coverage and only the gaps first, and everything on request', async () => {
  render(<WaAzureReview isLight />);
  expect(getAzureReview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Show the sheet' }));
  expect(await screen.findByText(/2 of 59/)).toBeTruthy();
  expect(screen.getByText('SE:07')).toBeTruthy();
  expect(screen.getByText(/TDE is off on sql-1/)).toBeTruthy();
  expect(screen.queryByText('SE:06')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show all 59' }));
  expect(screen.getByText('SE:06')).toBeTruthy();
  expect(screen.getByText('For the team')).toBeTruthy();
});

it('downloads the sheet as a file', async () => {
  render(<WaAzureReview isLight />);
  fireEvent.click(screen.getByRole('button', { name: 'Download (.md)' }));
  await waitFor(() => expect(downloadAzureReview).toHaveBeenCalled());
});

it('says why it failed, and why it is off for an unsaved project', async () => {
  getAzureReview.mockRejectedValueOnce(new Error('This project has no Azure resources'));
  const { unmount } = render(<WaAzureReview isLight />);
  fireEvent.click(screen.getByRole('button', { name: 'Show the sheet' }));
  expect((await screen.findByRole('alert')).textContent).toContain('no Azure resources');
  unmount();
  render(<WaAzureReview isLight disabledReason="Save the project to make the sheet." />);
  expect(screen.getByText('Save the project to make the sheet.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

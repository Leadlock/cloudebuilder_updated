/**
 * @jest-environment jsdom
 */
/** The AWS Well-Architected Tool card: nothing is sent until the button is pressed; the result says what was done and links to the console. */
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';
Object.assign(globalThis, { TextEncoder, TextDecoder });
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WaAwsTool from '@/components/panels/WaAwsTool';

const previewAwsTool = jest.fn();
const syncAwsTool = jest.fn();
const downloadAgentPackage = jest.fn();
jest.mock('@/lib/services/ApiWellArchitectedService', () => ({ apiWellArchitectedService: { previewAwsTool: (...a: unknown[]) => previewAwsTool(...a), syncAwsTool: (...a: unknown[]) => syncAwsTool(...a), downloadAgentPackage: (...a: unknown[]) => downloadAgentPackage(...a) } }));

const PRACTICES = [
  { bp: 'SEC08-BP02', choiceId: 'sec_protect_data_rest_encrypt', title: 'Enforce encryption at rest', state: 'met', passed: 3, problems: [], unclear: 0 },
  { bp: 'SEC05-BP02', choiceId: 'sec_network_protection_layered', title: 'Control traffic flow within your network layers', state: 'not_met', passed: 0, problems: ['AWS-SG-001: SSH open to the internet'], unclear: 0 },
];

beforeEach(() => {
  downloadAgentPackage.mockReset().mockResolvedValue({ blob: new Blob(['zip']), filename: 'well-architected-agent-shop.zip' });
  (global as unknown as { URL: { createObjectURL: () => string; revokeObjectURL: () => void } }).URL.createObjectURL = () => 'blob:x';
  (global as unknown as { URL: { createObjectURL: () => string; revokeObjectURL: () => void } }).URL.revokeObjectURL = () => undefined;
  previewAwsTool.mockReset().mockResolvedValue({ dryRun: true, practices: PRACTICES, rulesetVersion: 'r', evaluatedAt: '2026-10-26T00:00:00Z' });
  syncAwsTool.mockReset().mockResolvedValue({ workloadId: 'a'.repeat(32), workloadName: 'Shop (CloudBuilder 12345678)', created: true, region: 'eu-north-1', consoleUrl: 'https://eu-north-1.console.aws.amazon.com/wellarchitected/home?region=eu-north-1#/workload/x', answered: [{ questionId: 'q', questionTitle: 'Q', added: ['c'] }], notesOnly: 1, unmatched: [], practices: PRACTICES });
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: [{ id: 'acc1', name: 'Ajinkya', provider: 'aws' }] }) }));
});

it('sends nothing on its own, shows the evidence, then sends only when asked', async () => {
  render(<WaAwsTool isLight defaultRegion="eu-north-1" />);
  expect(previewAwsTool).not.toHaveBeenCalled();
  expect(syncAwsTool).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Show what can be sent' }));
  expect(await screen.findByText('SEC08-BP02')).toBeTruthy();
  expect(screen.getByText('In place')).toBeTruthy();
  expect(screen.getByText(/SSH open to the internet/)).toBeTruthy();
  expect(syncAwsTool).not.toHaveBeenCalled();

  await waitFor(() => expect((screen.getByLabelText('AWS account') as HTMLSelectElement).value).toBe('acc1'));
  fireEvent.click(screen.getByRole('button', { name: 'Send to AWS Well-Architected Tool' }));
  await waitFor(() => expect(syncAwsTool).toHaveBeenCalledWith({ cloudAccountId: 'acc1', region: 'eu-north-1', milestone: false }));
  expect(await screen.findByText(/Workload created/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /Open in the AWS console/ }).getAttribute('href')).toContain('wellarchitected');
});

it('refuses an invalid region and shows an error from the server', async () => {
  syncAwsTool.mockRejectedValueOnce(new Error('The AWS account may not use the Well-Architected Tool'));
  render(<WaAwsTool isLight />);
  fireEvent.click(screen.getByRole('button', { name: 'Show what can be sent' }));
  await screen.findByText('SEC08-BP02');
  await waitFor(() => expect((screen.getByLabelText('AWS account') as HTMLSelectElement).value).toBe('acc1'));
  fireEvent.change(screen.getByLabelText('Region of the Well-Architected Tool'), { target: { value: 'nowhere' } });
  expect((screen.getByRole('button', { name: 'Send to AWS Well-Architected Tool' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Region of the Well-Architected Tool'), { target: { value: 'eu-west-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to AWS Well-Architected Tool' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
});

it('says why it is off for an unsaved project', () => {
  render(<WaAwsTool isLight disabledReason="Save the project to send it." />);
  expect(screen.getByText('Save the project to send it.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

it('downloads the Terraform package for the AWS Well-Architected Agent without sending anything to AWS', async () => {
  render(<WaAwsTool isLight />);
  fireEvent.click(screen.getByRole('button', { name: 'Download for the AWS Well-Architected Agent' }));
  await waitFor(() => expect(downloadAgentPackage).toHaveBeenCalledTimes(1));
  expect(syncAwsTool).not.toHaveBeenCalled();
});

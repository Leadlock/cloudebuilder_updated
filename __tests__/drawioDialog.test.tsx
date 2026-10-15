/**
 * @jest-environment jsdom
 */
/**
 * The draw.io export dialog: shows the code, copies it, downloads the file, and says how to use it.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('@/context/AppContext', () => ({ useApp: () => ({ state: { theme: 'light' }, dispatch: jest.fn() }) }));

import DrawioExportDialog from '@/components/canvas/DrawioExportDialog';
import type { CanvasEdge, CanvasNode } from '@/types';

const nodes: CanvasNode[] = [
  { id: 'a', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'Web', position: { x: 0, y: 0 }, config: {} },
  { id: 'b', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'DB', position: { x: 300, y: 0 }, config: {} },
];
const edges: CanvasEdge[] = [{ id: 'e', source: 'a', target: 'b', label: 'SQL' }];

describe('DrawioExportDialog', () => {
  test('shows the code and counts what is in it', () => {
    render(<DrawioExportDialog title="Shop" nodes={nodes} edges={edges} onClose={() => {}} />);
    const box = screen.getByLabelText('draw.io code') as HTMLTextAreaElement;
    expect(box.value).toContain('<mxGraphModel');
    expect(box.value).toContain('n-a');
    expect(box.readOnly).toBe(true);
    expect(screen.getByText(/2 resources and 1 connection\b/)).toBeTruthy();
    expect(screen.getByText(/nothing is sent anywhere/i)).toBeTruthy();
  });

  test('explains how to use it in draw.io', () => {
    render(<DrawioExportDialog title="Shop" nodes={nodes} edges={edges} onClose={() => {}} />);
    expect(screen.getByText(/Edit Diagram/)).toBeTruthy();
  });

  test('Copy code puts the code on the clipboard', async () => {
    const writeText = jest.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<DrawioExportDialog title="Shop" nodes={nodes} edges={edges} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Copy code/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect((writeText.mock.calls[0] as unknown as string[])[0]).toContain('<mxGraphModel');
    await waitFor(() => expect(screen.getByRole('button', { name: /Copied/ })).toBeTruthy());
  });

  test('when the browser refuses to copy, the code is selected and the person is told', async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn(async () => { throw new Error('denied'); }) } });
    render(<DrawioExportDialog title="Shop" nodes={nodes} edges={edges} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Copy code/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Ctrl\+C/));
  });

  test('Download makes a .drawio file named after the project', () => {
    const created: Blob[] = [];
    Object.assign(URL, { createObjectURL: jest.fn((b: Blob) => { created.push(b); return 'blob:x'; }), revokeObjectURL: jest.fn() });
    const names: string[] = [];
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    render(<DrawioExportDialog title="My Shop!" nodes={nodes} edges={edges} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Download \.drawio/ }));
    expect(names).toEqual(['my-shop.drawio']);
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe('application/vnd.jgraph.mxfile');
    click.mockRestore();
  });

  test('Close and Escape both close it', () => {
    const onClose = jest.fn();
    render(<DrawioExportDialog title="Shop" nodes={nodes} edges={edges} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

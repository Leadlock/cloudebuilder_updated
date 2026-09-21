import { generateSvg, generatePng, generatePdf, type ExportInput } from '@/lib/services/ExportService';

const sampleInput: ExportInput = {
  title: 'Export Test Architecture',
  version: 'v1',
  theme: 'light',
  nodes: [
    {
      id: 'n1',
      type: 'aws_ec2',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Web Server',
      position: { x: 0, y: 0 },
      config: {},
    },
    {
      id: 'n2',
      type: 'aws_rds',
      resourceType: 'aws_rds',
      provider: 'aws',
      label: 'Primary DB',
      position: { x: 300, y: 0 },
      config: {},
    },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2', label: 'reads/writes' }],
};

describe('ExportService', () => {
  it('generateSvg produces well-formed SVG containing node labels', () => {
    const svg = generateSvg(sampleInput);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('Web Server');
    expect(svg).toContain('Primary DB');
  });

  it('generatePng produces a valid PNG buffer via sharp', async () => {
    const png = await generatePng(sampleInput);
    expect(Buffer.isBuffer(png)).toBe(true);
    // PNG magic number: 89 50 4E 47 0D 0A 1A 0A
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.length).toBeGreaterThan(100);
  });

  it('generatePdf produces a valid PDF buffer via pdfkit', async () => {
    const pdf = await generatePdf(sampleInput);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
  });

  it('handles an empty node list without throwing', () => {
    const svg = generateSvg({ ...sampleInput, nodes: [], edges: [] });
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  });
});

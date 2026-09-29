/**
 * Tests for lib/services/AiGeneratorService.ts after switching the AI
 * architecture generator from Gemini to Azure AI Foundry (OpenAI-SDK-compatible
 * v1 Responses API). Covers: the RDE catalog validation still rejects
 * unsupported resource types, the Foundry client is built from the expected
 * env vars, and generation history is recorded via the (mocked) db layer.
 */
process.env['AZURE_AI_FOUNDRY_ENDPOINT'] = 'https://test-resource.services.ai.azure.com/openai/v1/responses';
process.env['AZURE_AI_FOUNDRY_API_KEY'] = 'test-key';
process.env['AZURE_AI_FOUNDRY_DEPLOYMENT'] = 'gpt-4o';

const mockCreate = jest.fn();
const mockOpenAIConstructor = jest.fn().mockImplementation(() => ({
  responses: { create: mockCreate },
}));
jest.mock('openai', () => ({
  __esModule: true,
  default: mockOpenAIConstructor,
}));

const mockHistoryCreate = jest.fn().mockResolvedValue({ id: 'hist-1' });
jest.mock('@/src/prisma/db', () => ({
  db: { orm: { public: { AIGenerationHistory: { create: (...args: unknown[]) => mockHistoryCreate(...args) } } } },
}));

const mockFindByEnvironment = jest.fn().mockResolvedValue({ id: 'arch-1' });
jest.mock('@/lib/repositories/architectureRepository', () => ({
  architectureRepository: { findByEnvironment: (...args: unknown[]) => mockFindByEnvironment(...args) },
}));

import { AiGeneratorService } from '@/lib/services/AiGeneratorService';

describe('AiGeneratorService — Azure AI Foundry backend', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockOpenAIConstructor.mockClear();
    mockHistoryCreate.mockClear();
    mockFindByEnvironment.mockClear();
  });

  it('builds the Foundry client from the "/responses"-suffixed endpoint env var', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ resources: [], connections: [] }) });

    await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      baseURL: 'https://test-resource.services.ai.azure.com/openai/v1',
      apiKey: 'test-key',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o', text: { format: { type: 'json_object' } } })
    );
  });

  it('keeps a valid, catalog-recognized resource', async () => {
    mockCreate.mockResolvedValue({
      output_text: JSON.stringify({
        resources: [{ id: 'r1', resourceType: 'aws_vpc', label: 'VPC' }],
        connections: [],
      }),
    });

    const result = await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(result.architectureJson.resources).toEqual([{ id: 'r1', resourceType: 'aws_vpc', label: 'VPC' }]);
    expect(result.rejectedTypes).toEqual([]);
  });

  it('rejects resource types outside the RDE catalog and drops their connections', async () => {
    mockCreate.mockResolvedValue({
      output_text: JSON.stringify({
        resources: [
          { id: 'r1', resourceType: 'aws_vpc', label: 'VPC' },
          { id: 'r2', resourceType: 'not_a_real_type', label: 'Bogus' },
        ],
        connections: [{ sourceId: 'r1', targetId: 'r2' }],
      }),
    });

    const result = await AiGeneratorService.generateArchitecture('a vpc and something fake', 'proj-1', 'env-1', 'aws');

    expect(result.architectureJson.resources).toEqual([{ id: 'r1', resourceType: 'aws_vpc', label: 'VPC' }]);
    expect(result.architectureJson.connections).toEqual([]);
    expect(result.rejectedTypes).toEqual(['not_a_real_type']);
  });

  it('falls back to an empty graph when the model returns non-JSON output', async () => {
    mockCreate.mockResolvedValue({ output_text: 'not json at all' });

    const result = await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(result.architectureJson).toEqual({ resources: [], connections: [] });
  });

  it('records generation history against the resolved architecture', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ resources: [], connections: [] }) });

    const result = await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(mockFindByEnvironment).toHaveBeenCalledWith('env-1');
    expect(mockHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', architectureId: 'arch-1', model: 'gpt-4o', provider: 'aws' })
    );
    expect(result.historyId).toBe('hist-1');
  });

  it('still returns a result when history recording fails', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ resources: [], connections: [] }) });
    mockFindByEnvironment.mockRejectedValueOnce(new Error('db down'));

    const result = await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(result.historyId).toBe('');
    expect(result.architectureJson).toEqual({ resources: [], connections: [] });
  });

  it('includes provider-specific quality guidelines (SPOF, encryption, no open SSH/RDP) in the system prompt', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ resources: [], connections: [] }) });

    await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');
    const awsSystemPrompt = mockCreate.mock.calls[0]![0].input[0].content;
    expect(awsSystemPrompt).toContain('single point of failure');
    expect(awsSystemPrompt).toContain('Block Public Access');
    expect(awsSystemPrompt).toContain('0.0.0.0/0');
    expect(awsSystemPrompt).not.toContain('NSGs:');

    mockCreate.mockClear();
    await AiGeneratorService.generateArchitecture('a vnet', 'proj-1', 'env-1', 'azure');
    const azureSystemPrompt = mockCreate.mock.calls[0]![0].input[0].content;
    expect(azureSystemPrompt).toContain('Transparent Data Encryption');
    expect(azureSystemPrompt).not.toContain('Block Public Access');
  });
});

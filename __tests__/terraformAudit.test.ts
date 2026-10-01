const mockCreate = jest.fn();
jest.mock('@/src/prisma/db', () => ({ db: { orm: { public: { TerraformAuditEvent: { create: (...a: unknown[]) => mockCreate(...a) } } } } }));

import { recordTerraformAudit } from '@/lib/terraform/execution/audit';

describe('recordTerraformAudit', () => {
  let info: jest.SpyInstance; let warn: jest.SpyInstance;
  beforeEach(() => { mockCreate.mockReset(); info = jest.spyOn(console, 'info').mockImplementation(() => {}); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { info.mockRestore(); warn.mockRestore(); });

  it('stores who / what / outcome and also leaves a log line', async () => {
    mockCreate.mockResolvedValue({});
    await recordTerraformAudit({ action: 'apply', outcome: 'allowed', orgId: 'org-1', projectId: 'proj-1', userId: 'u-1', planId: 'p-1', planHash: 'abc', detail: 'apply queued' });
    const row = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({ action: 'apply', outcome: 'allowed', orgId: 'org-1', projectId: 'proj-1', userId: 'u-1', planId: 'p-1', planHash: 'abc', detail: 'apply queued' });
    expect(typeof row['id']).toBe('string');
    expect(new Date(row['createdAt'] as string).toString()).not.toBe('Invalid Date');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('[terraform-audit]'));
  });

  it('never throws and never loses the event when the database is unavailable', async () => {
    mockCreate.mockRejectedValue(new Error('relation "TerraformAuditEvent" does not exist'));
    await expect(recordTerraformAudit({ action: 'plan', outcome: 'denied', userId: 'u-1', detail: 'not enabled' })).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"outcome":"denied"'));
    expect(warn).toHaveBeenCalled();
  });

  it('truncates long details so a message can never bloat or leak a full terraform output', async () => {
    mockCreate.mockResolvedValue({});
    await recordTerraformAudit({ action: 'apply', outcome: 'failed', detail: 'x'.repeat(5000) });
    expect(((mockCreate.mock.calls[0]![0] as { detail: string }).detail).length).toBe(500);
  });
});

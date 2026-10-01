import { AUTO_UNLOCK_MIN_AGE_MS, decideAutoUnlock, describeHeldLock, isLockFromThisMachine, isStateLockError, parseLockInfo } from '@/lib/terraform/execution/stateLock';

// The error from a real teardown: another machine ("Tanmay") holds an Apply lock on the shared Azure state.
const REAL = [
  'terraform destroy failed (exit 1): Error: Error acquiring the state lock',
  'Error message: state blob is already locked',
  'Lock Info:',
  '  ID:        1afc9b38-cc96-8e8d-2330-dfba92af6cd7',
  '  Path:      tfstate/cloudcraft.terraform.tfstate',
  '  Operation: OperationTypeApply',
  '  Who:       TANMAY\\22tan@Tanmay',
  '  Version:   1.9.8',
  '  Created:   2026-10-01 08:44:17.5396572 +0000 UTC',
  '  Info:      ',
  'Terraform acquires a state lock to protect the state from being written by multiple users at the same time.',
].join('\n');
const FLAT = REAL.replace(/\n\s*/g, ' ');   // the same text flattened onto one line, as the UI shows it
const CREATED = Date.parse('2026-10-01T08:44:17Z');
const HOUR = 60 * 60 * 1000;

describe('parseLockInfo', () => {
  it.each([['multi-line', REAL], ['flattened', FLAT]])('reads every field from the real error (%s)', (_n, text) => {
    const info = parseLockInfo(text)!;
    expect(info.id).toBe('1afc9b38-cc96-8e8d-2330-dfba92af6cd7');
    expect(info.path).toBe('tfstate/cloudcraft.terraform.tfstate');
    expect(info.operation).toBe('OperationTypeApply');
    expect(info.who).toBe('TANMAY\\22tan@Tanmay');
    expect(info.created!.toISOString()).toBe('2026-10-01T08:44:17.000Z');
  });
  it('returns null when there is no lock id', () => {
    expect(parseLockInfo('terraform plan failed: something else')).toBeNull();
  });
  it('recognises state-lock errors and nothing else', () => {
    expect(isStateLockError(REAL)).toBe(true);
    expect(isStateLockError('Error: Insufficient permissions')).toBe(false);
  });
});

describe('isLockFromThisMachine', () => {
  const info = parseLockInfo(REAL)!;
  it('matches on the host after the @, ignoring case', () => {
    expect(isLockFromThisMachine(info, 'Tanmay')).toBe(true);
    expect(isLockFromThisMachine(info, 'TANMAY')).toBe(true);
    expect(isLockFromThisMachine(info, 'LAPTOP-G4Q1LCQB')).toBe(false);
    expect(isLockFromThisMachine({ id: 'x' }, 'Tanmay')).toBe(false);
  });
  it('does not match a host that merely contains the name', () => {
    expect(isLockFromThisMachine({ id: 'x', who: 'me@tanmay-build-server' }, 'Tanmay')).toBe(false);
  });
});

describe('decideAutoUnlock — when may CloudCraft break a lock itself?', () => {
  it('NEVER for a lock held by another machine, however old (the situation in the screenshot)', () => {
    for (const age of [5 * 60_000, 2 * HOUR, 30 * 24 * HOUR]) {
      const d = decideAutoUnlock(REAL, 'apply', CREATED + age, 'LAPTOP-G4Q1LCQB');
      expect(d.unlock).toBe(false);
      expect((d as { reason: string }).reason).toMatch(/another machine/);
    }
  });

  it('never for a destroy, even for its own old lock', () => {
    const d = decideAutoUnlock(REAL, 'destroy', CREATED + 5 * HOUR, 'Tanmay');
    expect(d.unlock).toBe(false);
    expect((d as { reason: string }).reason).toMatch(/destroy/);
  });

  it('not while its own lock is younger than the longest allowed run', () => {
    const d = decideAutoUnlock(REAL, 'apply', CREATED + AUTO_UNLOCK_MIN_AGE_MS - 60_000, 'Tanmay');
    expect(d.unlock).toBe(false);
    expect((d as { reason: string }).reason).toMatch(/may still be going/);
  });

  it('yes for its own plan/apply lock once it is older than any run could be', () => {
    for (const op of ['plan', 'apply'] as const) {
      expect(decideAutoUnlock(REAL, op, CREATED + AUTO_UNLOCK_MIN_AGE_MS + 60_000, 'Tanmay')).toEqual({ unlock: true, id: '1afc9b38-cc96-8e8d-2330-dfba92af6cd7' });
    }
  });

  it('no when the details cannot be read', () => {
    expect(decideAutoUnlock('Error acquiring the state lock', 'apply', CREATED + 9 * HOUR, 'Tanmay').unlock).toBe(false);
    const noTime = REAL.replace(/Created:.*\n/, '');
    expect(decideAutoUnlock(noTime, 'apply', CREATED + 9 * HOUR, 'Tanmay').unlock).toBe(false);
  });
});

describe('describeHeldLock', () => {
  it('tells the user who holds the lock, for how long, and the safe way to release it', () => {
    const d = decideAutoUnlock(REAL, 'destroy', CREATED + 2 * HOUR, 'LAPTOP-G4Q1LCQB') as Extract<ReturnType<typeof decideAutoUnlock>, { unlock: false }>;
    const text = describeHeldLock(REAL, d, CREATED + 2 * HOUR);
    expect(text).toContain('TANMAY\\22tan@Tanmay');
    expect(text).toContain('OperationTypeApply');
    expect(text).toContain('120 min ago');
    expect(text).toContain('terraform force-unlock 1afc9b38-cc96-8e8d-2330-dfba92af6cd7');
    expect(text).toMatch(/confirm that run has finished/i);
  });
});

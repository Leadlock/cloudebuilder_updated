import { applyControlUpdate, applyFindingUpdate, checkScope, checkSignoff, isSamePerson, safeFileName, fileExtension, EVIDENCE_EXTENSIONS, ControlUpdateSchema } from '@/lib/compliance/rules';
import { checkControlKeys } from '@/lib/compliance/evidenceInput';
import type { Signoff } from '@/lib/compliance/types';

const NOW = '2026-10-26T10:00:00.000Z';
const cur = { status: 'implemented' as const, owner: 'Priya Nair', note: '', naReason: '', reviewer: '' };

describe('who counts as the same person', () => {
  it('matches an owner written as a name, an email or the part before the @', () => {
    expect(isSamePerson('Priya Nair', { name: 'priya nair' })).toBe(true);
    expect(isSamePerson('priya@x.com', { email: 'Priya@x.com' })).toBe(true);
    expect(isSamePerson('priya', { email: 'priya@x.com' })).toBe(true);
    expect(isSamePerson('Priya Nair', { email: 'dana@x.com' })).toBe(false);
    expect(isSamePerson('', { email: '' })).toBe(false);
  });
});

describe('control updates', () => {
  it('refuses "not applicable" without a real reason', () => {
    expect(applyControlUpdate(cur, { status: 'not_applicable' }, { email: 'a@x.com' }, NOW)).toMatchObject({ ok: false });
    expect(applyControlUpdate(cur, { status: 'not_applicable', naReason: 'short' }, { email: 'a@x.com' }, NOW)).toMatchObject({ ok: false });
    expect(applyControlUpdate(cur, { status: 'not_applicable', naReason: 'We have no physical office.' }, { email: 'a@x.com' }, NOW)).toMatchObject({ ok: true });
  });
  it('a control cannot be reviewed by its owner, and review needs an owner', () => {
    expect(applyControlUpdate(cur, { markReviewed: true }, { email: 'x@y.com', name: 'Priya Nair' }, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/own owner/) });
    expect(applyControlUpdate({ ...cur, owner: '' }, { markReviewed: true }, { email: 'dana@x.com' }, NOW)).toMatchObject({ ok: false });
    const r = applyControlUpdate(cur, { markReviewed: true }, { email: 'dana@x.com', name: 'Dana Li' }, NOW);
    expect(r).toMatchObject({ ok: true, next: { reviewer: 'Dana Li', reviewedAt: NOW } });
  });
  it('changing the owner or the status ends an earlier review', () => {
    const reviewed = { ...cur, reviewer: 'Dana Li', reviewedAt: '2026-10-01' };
    const r = applyControlUpdate(reviewed, { owner: 'Sam Okafor' }, { email: 'a@x.com' }, NOW);
    expect(r).toMatchObject({ ok: true, next: { reviewer: '' } });
    expect((r as { next: { reviewedAt?: string } }).next.reviewedAt).toBeUndefined();
    expect(applyControlUpdate(reviewed, { note: 'A note' }, { email: 'a@x.com' }, NOW)).toMatchObject({ ok: true, next: { reviewer: 'Dana Li' } });
  });
  it('rejects unknown statuses and overlong text', () => {
    expect(ControlUpdateSchema.safeParse({ status: 'done' }).success).toBe(false);
    expect(ControlUpdateSchema.safeParse({ note: 'x'.repeat(2001) }).success).toBe(false);
  });
});

describe('findings', () => {
  const f = { owner: 'Sam Okafor', status: 'open' as const, managementResponse: '', acceptedBy: '', retestedBy: '', };
  it('closing needs a written response and someone other than the owner', () => {
    expect(applyFindingUpdate(f, { status: 'closed' }, { email: 'dana@x.com', isAdmin: true }, NOW)).toMatchObject({ ok: false });
    const withResponse = { ...f, managementResponse: 'Encryption switched on and verified.' };
    expect(applyFindingUpdate(withResponse, { status: 'closed' }, { name: 'Sam Okafor', isAdmin: true }, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/own owner/) });
    expect(applyFindingUpdate(withResponse, { status: 'closed' }, { name: 'Dana Li', isAdmin: false }, NOW)).toMatchObject({ ok: true, next: { retestedBy: 'Dana Li', retestedAt: NOW } });
  });
  it('accepting a risk is for an owner or admin only', () => {
    const withResponse = { ...f, managementResponse: 'The data is public by design.' };
    expect(applyFindingUpdate(withResponse, { status: 'risk_accepted' }, { email: 'a@x.com', isAdmin: false }, NOW)).toMatchObject({ ok: false });
    expect(applyFindingUpdate(withResponse, { status: 'risk_accepted' }, { email: 'a@x.com', isAdmin: true }, NOW)).toMatchObject({ ok: true, next: { acceptedBy: 'a@x.com' } });
  });
  it('re-opening clears the acceptance and the re-test', () => {
    const closed = { ...f, status: 'closed' as const, managementResponse: 'Done and verified.', retestedBy: 'Dana', retestedAt: '2026-10-20' };
    const r = applyFindingUpdate(closed, { status: 'open' }, { email: 'a@x.com', isAdmin: true }, NOW);
    expect(r).toMatchObject({ ok: true, next: { retestedBy: '', acceptedBy: '' } });
  });
});

describe('sign-off order and independence', () => {
  const s = (role: Signoff['role'], email: string): Signoff => ({ role, name: email, email, signedAt: NOW });
  it('anyone prepares; review and management are for owners and admins', () => {
    expect(checkSignoff('preparer', [], { email: 'a@x.com', isAdmin: false }).ok).toBe(true);
    expect(checkSignoff('reviewer', [s('preparer', 'a@x.com')], { email: 'b@x.com', isAdmin: false }).ok).toBe(false);
  });
  it('the reviewer is not the preparer, and a review needs a prepared report', () => {
    expect(checkSignoff('reviewer', [], { email: 'b@x.com', isAdmin: true }).ok).toBe(false);
    expect(checkSignoff('reviewer', [s('preparer', 'A@x.com')], { email: 'a@x.com', isAdmin: true }).ok).toBe(false);
    expect(checkSignoff('reviewer', [s('preparer', 'a@x.com')], { email: 'b@x.com', isAdmin: true }).ok).toBe(true);
  });
  it('management signs last', () => {
    expect(checkSignoff('management', [s('preparer', 'a@x.com')], { email: 'c@x.com', isAdmin: true }).ok).toBe(false);
    expect(checkSignoff('management', [s('preparer', 'a@x.com'), s('reviewer', 'b@x.com')], { email: 'c@x.com', isAdmin: true }).ok).toBe(true);
  });
});

describe('scope', () => {
  it('security is always in; a category left out needs a reason', () => {
    expect(checkScope({ categories: ['availability'], exclusions: {} })).toMatchObject({ ok: false, message: expect.stringMatching(/confidentiality/) });
    const r = checkScope({ categories: ['availability'], exclusions: { confidentiality: 'No data is classified confidential.' } });
    expect(r).toMatchObject({ ok: true, categories: ['security', 'availability'], exclusions: { confidentiality: 'No data is classified confidential.' } });
    expect(checkScope({ categories: ['security', 'availability', 'confidentiality'], exclusions: {} })).toMatchObject({ ok: true });
  });
});

describe('evidence input', () => {
  it('only documents and data are accepted, never anything a browser or machine would run', () => {
    for (const bad of ['html', 'svg', 'js', 'exe', 'sh', 'bat', 'jar']) expect(EVIDENCE_EXTENSIONS.has(bad)).toBe(false);
    for (const good of ['pdf', 'png', 'csv', 'json', 'docx']) expect(EVIDENCE_EXTENSIONS.has(good)).toBe(true);
  });
  it('file names lose paths and odd characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileName('a"b\r\n.pdf')).toBe('a_b__.pdf');
    expect(safeFileName('')).toBe('evidence');
    expect(fileExtension('Report.PDF')).toBe('pdf');
  });
  it('a control link must name a real control of a known framework', () => {
    expect(checkControlKeys(['soc2:CTL-01', 'aws-waf:SEC 1'])).toBeNull();
    expect(checkControlKeys(['soc2:NOPE'])).toMatch(/not a control/);
    expect(checkControlKeys(['made-up:CTL-01'])).toMatch(/not a control/);
  });
});

import { ENTRY_KINDS, ENTRY_META, EngagementSchema, checkEntry, entrySchema, groupEntries, isEntryKind } from '@/lib/compliance/entries';

describe('every kind of record is described once', () => {
  it('has a title, a blurb and at least one field, and a field key is never repeated', () => {
    for (const k of ENTRY_KINDS) {
      const m = ENTRY_META[k];
      expect(m.kind).toBe(k); expect(m.title.length).toBeGreaterThan(3); expect(m.blurb.length).toBeGreaterThan(20); expect(m.fields.length).toBeGreaterThan(0);
      expect(new Set(m.fields.map((f) => f.key)).size).toBe(m.fields.length);
      for (const f of m.fields) if (f.type === 'select') expect(f.options?.length).toBeGreaterThan(1);
    }
    expect(isEntryKind('walkthrough')).toBe(true); expect(isEntryKind('nope')).toBe(false);
  });
});

describe('what a record may hold', () => {
  const change = entrySchema('change');
  it('fills missing optional fields with empty text and trims', () => {
    expect(change.parse({ date: ' 2026-09-01 ', change: ' Moved the database ' })).toMatchObject({ date: '2026-09-01', change: 'Moved the database', systems: '', reviewedBy: '' });
  });
  it('requires what is marked required', () => {
    expect(change.safeParse({ date: '2026-09-01' }).success).toBe(false);
    expect(change.safeParse({ change: 'x' }).success).toBe(false);
  });
  it('refuses a bad date, a date in the future, a value outside the choices, a field that does not exist, and over-long text', () => {
    expect(change.safeParse({ date: '1 Sept', change: 'x' }).success).toBe(false);
    expect(change.safeParse({ date: '2999-01-01', change: 'x' }).success).toBe(false);
    expect(entrySchema('cuec').safeParse({ status: 'Maybe' }).success).toBe(false);
    expect(change.safeParse({ date: '2026-09-01', change: 'x', surprise: 'y' }).success).toBe(false);
    expect(change.safeParse({ date: '2026-09-01', change: 'x'.repeat(601) }).success).toBe(false);
  });
});

describe('rules beyond the fields', () => {
  it('a walkthrough cannot be reviewed by the person who prepared it', () => {
    expect(checkEntry('walkthrough', { preparer: 'Sam', reviewer: 'sam' })).toMatch(/cannot be the person/);
    expect(checkEntry('walkthrough', { preparer: 'Sam', reviewer: 'Dana' })).toBeNull();
    expect(checkEntry('walkthrough', { preparer: 'Sam', reviewer: '' })).toBeNull();
  });
  it('a closed prior finding needs closure evidence and a re-tester', () => {
    expect(checkEntry('prior_finding', { statusNow: 'Closed', closureEvidence: 'EV-1', retestedBy: '' })).toMatch(/closed finding needs/);
    expect(checkEntry('prior_finding', { statusNow: 'Closed', closureEvidence: 'EV-1', retestedBy: 'Dana' })).toBeNull();
    expect(checkEntry('prior_finding', { statusNow: 'Open' })).toBeNull();
  });
  it('a provider report that does not cover the period needs the dates of a bridge letter', () => {
    expect(checkEntry('provider_review', { coversPeriod: 'No', bridgeLetter: '' })).toMatch(/bridge letter/);
    expect(checkEntry('provider_review', { coversPeriod: 'No', bridgeLetter: '1 to 26 Oct' })).toBeNull();
    expect(checkEntry('provider_review', { coversPeriod: 'Yes', bridgeLetter: '' })).toBeNull();
  });
  it('a complementary control marked Gap needs a note', () => {
    expect(checkEntry('cuec', { status: 'Gap', note: '' })).toMatch(/gap needs a note/);
    expect(checkEntry('csoc', { status: 'Gap', note: 'Legal to add it' })).toBeNull();
    expect(checkEntry('csoc', { status: 'Confirmed' })).toBeNull();
  });
});

describe('the engagement settings', () => {
  it('accept a firm, a scan provider and a past assessment date, and refuse a future one', () => {
    expect(EngagementSchema.safeParse({ cpaFirm: 'Harbor & Pike LLP', scanProvider: 'X', assessmentDate: '2026-10-01' }).success).toBe(true);
    expect(EngagementSchema.safeParse({ assessmentDate: '2999-01-01' }).success).toBe(false);
    expect(EngagementSchema.safeParse({ assessmentDate: 'soon' }).success).toBe(false);
    expect(EngagementSchema.parse({})).toMatchObject({ cpaFirm: '', scanProvider: '', scanFrequency: '' });
  });
});

describe('rows become the records the report reads', () => {
  const row = (kind: string, key: string | null, data: unknown, at: string) => ({ id: `${kind}-${key}-${at}`, kind, key, dataJson: typeof data === 'string' ? data : JSON.stringify(data), updatedBy: 'a@x.com', updatedAt: at });
  it('files each kind where it belongs, sorts changes by date, and skips a damaged row or an unknown kind', () => {
    const team = groupEntries([
      row('change', null, { date: '2026-09-02', change: 'B' }, '2026-10-02'), row('change', null, { date: '2026-08-01', change: 'A' }, '2026-10-03'),
      row('walkthrough', 'CTL-01', { participant: 'P' }, '2026-10-04'), row('cuec', 'CUEC-1', { status: 'Confirmed' }, '2026-10-04'), row('provider_review', 'AWS', { treatment: 'Carve-out' }, '2026-10-04'),
      row('review_conclusion', 'main', { conclusion: 'ok' }, '2026-10-04'), row('limitation_note', 'L-01', { owner: 'S' }, '2026-10-04'), row('finding_plan', 'CTL-23', { milestones: 'M' }, '2026-10-04'),
      row('walkthrough', 'CTL-02', 'not json', '2026-10-05'), row('mystery', 'x', { a: 'b' }, '2026-10-05'),
    ], { cpaFirm: 'F', scanProvider: '', scanFrequency: '' });
    expect(team.changes.map((c) => c.data['change'])).toEqual(['A', 'B']);
    expect(Object.keys(team.walkthroughs)).toEqual(['CTL-01']);
    expect(team.cuecs['CUEC-1']!.data['status']).toBe('Confirmed');
    expect(team.providers['AWS']).toBeDefined(); expect(team.conclusion!.data['conclusion']).toBe('ok');
    expect(team.limitationNotes['L-01']).toBeDefined(); expect(team.findingPlans['CTL-23']).toBeDefined();
    expect(team.engagement.cpaFirm).toBe('F');
  });
  it('a later row for the same subject wins', () => {
    const team = groupEntries([row('walkthrough', 'CTL-01', { participant: 'Old' }, '2026-10-01'), row('walkthrough', 'CTL-01', { participant: 'New' }, '2026-10-09')], { cpaFirm: '', scanProvider: '', scanFrequency: '' });
    expect(team.walkthroughs['CTL-01']!.data['participant']).toBe('New');
  });
  it('a non-text value is read as empty rather than trusted', () => {
    const team = groupEntries([row('change', null, { date: '2026-09-02', change: { evil: 1 } }, '2026-10-02')], { cpaFirm: '', scanProvider: '', scanFrequency: '' });
    expect(team.changes[0]!.data['change']).toBe('');
  });
});

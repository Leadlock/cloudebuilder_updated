/**
 * The small helpers several Container Templates generators use (YAML quoting, the AWS region and Azure location patterns) are defined once, in
 * lib/engines/containers/shared.ts, so a fix to one cannot be missed in another copy.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { LOCATION, REGION, yq } from '@/lib/engines/containers/shared';
import { REGION as Ec2Region } from '@/lib/engines/containers/ec2Deploy';

describe('the shared helpers', () => {
  test('yq escapes only backslash and double quote', () => {
    expect(yq('plain')).toBe('"plain"');
    expect(yq('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(yq("it's $x")).toBe(`"it's $x"`);
  });

  test('REGION and LOCATION accept real names and refuse the other cloud\'s', () => {
    for (const ok of ['us-east-1', 'eu-west-2', 'ap-southeast-1']) expect(REGION.test(ok)).toBe(true);
    for (const bad of ['westeurope', 'us-east', 'US-EAST-1', '', 'us-east-1; drop']) expect(REGION.test(bad)).toBe(false);
    for (const ok of ['westeurope', 'eastus2', 'northeurope']) expect(LOCATION.test(ok)).toBe(true);
    for (const bad of ['eu-west-1', 'ab', 'West Europe', '']) expect(LOCATION.test(bad)).toBe(false);
  });

  test('ec2Deploy still exports the same region pattern for the generators that import it from there', () => {
    expect(Ec2Region).toBe(REGION);
  });
});

describe('no second copy', () => {
  const dir = join(__dirname, '..', 'lib', 'engines', 'containers');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'shared.ts');
  const text = (f: string) => readFileSync(join(dir, f), 'utf8');

  test.each([
    ['yq', /^(?:export )?const yq = /m],
    ['LOCATION', /^(?:export )?const (?:AZURE_)?LOCATION = \//m],
    ['REGION', /^(?:export )?const (?:AWS_)?REGION = \//m],
  ])('%s is not redefined in any generator', (_name, definition) => {
    expect(files.filter((f) => definition.test(text(f)))).toEqual([]);
  });
});

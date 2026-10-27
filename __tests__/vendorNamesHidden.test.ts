/**
 * Customers are not told which services run behind CloudBuilder. This checks the helper, the sign-in responses, and (by reading the source)
 * that no screen or API message names a back-end vendor. The customer's own clouds (AWS, Azure) and Terraform are product features and are
 * not part of this.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { hideVendorNames, hideVendorNamesDeep } from '@/lib/api/vendorNames';
import { fromPublicMethod, toPublicMethod, VERIFICATION_METHODS } from '@/lib/auth/challengeMethods';
import { apiError } from '@/lib/api/response';

const NAMES = /cognito|\bSES\b|foundry|openai|bedrock|anthropic|price list api|retail prices api|user pool/i;

describe('hideVendorNames', () => {
  test.each([
    ['An account with this email already exists in Cognito', 'sign-in service'],
    ['Password does not meet AWS Cognito complexity requirements', 'sign-in service'],
    ['CognitoIdentityProviderServiceException: boom', 'sign-in service'],
    ['Email address is not verified in AWS SES (eu-north-1)', 'email service'],
    ['Azure AI Foundry returned 429', 'assistant'],
    ['Azure OpenAI quota exceeded', 'assistant'],
    ['Bedrock is not available', 'assistant'],
    ['from the AWS Price List API / Azure Retail Prices API', 'official price list'],
    ['user pool is disabled', 'directory'],
  ])('%s', (input, neutral) => {
    const out = hideVendorNames(input);
    expect(out).not.toMatch(NAMES);
    expect(out).toContain(neutral);
  });

  test('text about the customer\'s own clouds and Terraform is left alone', () => {
    const t = 'Connect an AWS or Azure account, then export Terraform for your VPC and Lambda.';
    expect(hideVendorNames(t)).toBe(t);
  });

  test('cleans inside objects and lists, and leaves other values alone', () => {
    expect(hideVendorNamesDeep({ a: ['Cognito failed', 3, null], b: { c: 'SES', d: true } })).toEqual({ a: ['sign-in service failed', 3, null], b: { c: 'email service', d: true } });
  });
});

describe('API errors', () => {
  test('an error about the customer\'s own resources is sent exactly as it is', async () => {
    const message = 'Amazon Bedrock agent "Support Bedrock" has an invalid model, SES identity x@y.z is not verified, project "Foundry" not found';
    const res = apiError('BAD_REQUEST', message, 400, { resource: 'Azure OpenAI deployment gpt-4o' });
    expect(await res.json()).toEqual({ ok: false, error: { code: 'BAD_REQUEST', message, details: { resource: 'Azure OpenAI deployment gpt-4o' } } });
  });
});

describe('verification method names', () => {
  test('the service\'s challenge names map to neutral ones and back', () => {
    expect(toPublicMethod('SOFTWARE_TOKEN_MFA')).toBe('app');
    expect(toPublicMethod('SMS_MFA')).toBe('sms');
    expect(toPublicMethod('EMAIL_OTP')).toBe('email');
    expect(toPublicMethod('MFA_SETUP')).toBe('setup');
    expect(toPublicMethod('SOMETHING_NEW')).toBeNull();            // a step CloudBuilder cannot do is not guessed to be a code
    expect(toPublicMethod('NEW_PASSWORD_REQUIRED')).toBeNull();
    for (const m of VERIFICATION_METHODS) expect(toPublicMethod(fromPublicMethod(m))).toBe(m);
    for (const m of VERIFICATION_METHODS) expect(m).not.toMatch(NAMES);
  });
});

// ── the source: no screen text and no API message names a vendor ──────────────

const root = join(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e === '.next') continue;
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
/** Lines that put text in front of a person: not comments, not logs, not imports, not identifiers. */
function shownText(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => {
    const t = line.trim();
    if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('import ')) return false;
    if (/console\.(log|warn|error|info|debug)\(/.test(t)) return false;
    // Matching a resource type id (for example choosing an icon for aws_bedrock_agent) is not text a person sees.
    if (/^(if|else if) \(.*\btype\.includes\(/.test(t) || /^return .*\btype\.includes\(/.test(t)) return false;
    return true;
  }).filter((line) => {
    // Only text inside quotes or JSX text counts, not names such as CognitoService or cognitoErr.
    const strings = line.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`|>[^<>{}\n]+</g) ?? [];
    return strings.some((x) => NAMES.test(x));
  });
}

describe('no back-end vendor name in anything a customer can see', () => {
  const dirs = ['components', 'app', 'context'].map((d) => join(root, d));
  const files = dirs.flatMap((d) => walk(d));

  test('screens and API routes', () => {
    const found = files.flatMap((f) => shownText(f).map((l) => `${f.replace(root + '/', '')}: ${l.trim().slice(0, 140)}`));
    expect(found).toEqual([]);
  });
});

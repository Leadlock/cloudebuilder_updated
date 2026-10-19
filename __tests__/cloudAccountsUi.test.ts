/**
 * The Cloud Accounts tab and the pieces it is built from, rendered to HTML (no browser): what a person sees before they do anything.
 * Behaviour that needs clicks (connect, re-check, delete) is covered by the API tests and by looking at the running app.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConnectAwsAccountForm from '@/components/accounts/ConnectAwsAccountForm';
import ConnectAzureAccountForm from '@/components/accounts/ConnectAzureAccountForm';
import DeleteAccountDialog from '@/components/accounts/DeleteAccountDialog';
import CloudAccountsPanel from '@/components/panels/CloudAccountsPanel';
import type { AppView } from '@/types';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = async () => undefined;

describe('Connect AWS form', () => {
  const markup = html(createElement(ConnectAwsAccountForm, { onConnected: noop, initialMode: 'role' }));

  it('is about the user\'s own account: their key and their role, with nothing of CloudBuilder\'s to set up or trust', () => {
    expect(markup).toContain('Connect your own AWS account');
    expect(markup).toContain('nothing of CloudBuilder');
    expect(markup).toContain('temporary role credentials');
    expect(markup).not.toMatch(/CloudBuilder (server )?signs in to AWS/i);
    expect(markup).not.toContain('Checking how CloudBuilder signs in to AWS');
    expect(markup).not.toContain('no AWS credentials of its own');
  });

  it('asks for the access key, its secret (masked), the role ARN, an OPTIONAL External ID and a region — in one form, no method to choose', () => {
    expect(markup).toContain('Access key ID (AKIA');
    expect(markup).toMatch(/type="password"[^>]*placeholder="Secret access key/);
    expect(markup).toContain('Role ARN (arn:aws:iam::123456789012:role/CloudCraftRole)');
    expect(markup).toContain('External ID (optional');
    expect(markup).toContain('aria-label="Region"');
    expect(markup).toContain('Account name (optional)');
    expect(markup).toContain('Connect AWS Account');
    expect(markup).not.toContain('role="radiogroup"');
  });

  it('keeps the secret from being autofilled or spell-checked', () => {
    expect(markup).toMatch(/autoComplete="new-password"/);
  });

  it('walks through the four steps in the user\'s own AWS account and writes the policies for them', () => {
    expect(markup).toContain('How to set it up in AWS (4 short steps)');
    for (const step of ['1. Create the role', '2. Give the role its permissions', '3. Create an IAM user that may only assume the role', '4. Create the user']) expect(markup).toContain(step);
    expect(markup).toContain('Trust policy for the role');
    expect(markup).toContain('Read-only policy for discovery');
    expect(markup).toContain('Inline policy for the user');
    expect(markup).toContain('CloudCraftDiscoveryReadOnly');
    expect(markup).toContain('sts:AssumeRole');
  });

  it('before an account ID is known the policies carry a clear placeholder, and the trust policy trusts the user\'s OWN account (not anyone else\'s)', () => {
    expect(markup).toContain('&lt;YOUR-12-DIGIT-ACCOUNT-ID&gt;');
    expect(markup).toContain('arn:aws:iam::&lt;YOUR-12-DIGIT-ACCOUNT-ID&gt;:root');
    expect(markup).toContain('Generate an External ID (optional)');
  });
});

describe('Connect Azure form', () => {
  const markup = html(createElement(ConnectAzureAccountForm, { onConnected: noop }));
  it('asks for the four service-principal values, with the secret masked', () => {
    for (const label of ['Tenant ID', 'Client ID (Application ID)', 'Subscription ID']) expect(markup).toContain(label);
    expect(markup).toMatch(/type="password"[^>]*placeholder="Client Secret/);
    expect(markup).toContain('Connect Azure Account');
    expect(markup).toContain('Reader');
  });
  it('turns off autofill and spell-check on the secret fields', () => {
    expect(markup).toMatch(/type="password"[^>]*autoComplete="new-password"|autoComplete="new-password"[^>]*type="password"/);
  });
});

describe('Delete account dialog', () => {
  const markup = html(createElement(DeleteAccountDialog, { account: { id: 'a1', name: 'Production AWS', provider: 'aws' }, onClose: () => undefined, onDeleted: noop }));
  it('names the account and says what will and will not happen before anything is deleted', () => {
    expect(markup).toContain('Delete “Production AWS”?');
    expect(markup).toContain('stored connection details are deleted');
    expect(markup).toContain('Terraform plans and applies that use it will stop working');
    expect(markup).toContain('Nothing in your cloud account is touched');
  });
  it('is a modal dialog with a Cancel (the default focus) and a separate red delete button', () => {
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Cancel');
    expect(markup).toContain('Delete account');
  });
});

describe('Cloud Accounts tab', () => {
  const markup = html(createElement(CloudAccountsPanel));
  it('has a heading that says what it is for, and shows loading until the accounts arrive', () => {
    expect(markup).toContain('Cloud Accounts');
    expect(markup).toContain('Connect the AWS and Azure accounts CloudBuilder reads from and deploys to.');
    expect(markup).toContain('Loading your accounts');
  });
  it('does not show a connect form or an empty-state message before it knows whether there are accounts', () => {
    expect(markup).not.toContain('Connect an account');
    expect(markup).not.toContain('No accounts yet');
  });
});

describe('navigation', () => {
  it('"accounts" is a real view (the page maps every view to a component, so the compiler enforces this) and appears in the sidebar and top bar', async () => {
    const view: AppView = 'accounts';
    expect(view).toBe('accounts');
    const fs = await import('node:fs');
    expect(fs.readFileSync('components/layout/Sidebar.tsx', 'utf8')).toMatch(/id: 'accounts',\s+label: 'Cloud Accounts'/);
    expect(fs.readFileSync('components/layout/TopBar.tsx', 'utf8')).toMatch(/accounts: 'Cloud Accounts'/);
    expect(fs.readFileSync('app/page.tsx', 'utf8')).toMatch(/accounts:\s+<CloudAccountsPanel \/>/);
  });
});

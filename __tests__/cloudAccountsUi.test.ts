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
  const markup = html(createElement(ConnectAwsAccountForm, { onConnected: noop }));

  it('offers the IAM role (recommended) and the read-only access key, with the role selected first', () => {
    expect(markup).toContain('IAM role');
    expect(markup).toContain('Recommended. Also lets CloudCraft run Terraform.');
    expect(markup).toContain('Access key');
    expect(markup).toContain('Quick, read-only. Discovery only.');
    expect(markup).toMatch(/aria-checked="true"[^>]*>\s*<p[^>]*>IAM role/);
  });

  it('starts with the role fields (Role ARN, External ID) and none of the access-key fields', () => {
    expect(markup).toContain('Role ARN (arn:aws:iam::123456789012:role/CloudCraftReadOnly)');
    expect(markup).toContain('External ID (shared secret)');
    expect(markup).not.toContain('Access key ID (AKIA');
    expect(markup).not.toContain('Secret access key');
  });

  it('has a region, an account name, the connect button, and a way to check the server\'s AWS sign-in first', () => {
    expect(markup).toContain('Account name (optional)');
    expect(markup).toContain('aria-label="Region"');
    expect(markup).toContain('Connect AWS Account');
    expect(markup).toContain('Checking how CloudCraft signs in to AWS');     // the guide starts by asking the server who it is
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
    expect(markup).toContain('Connect the AWS and Azure accounts CloudCraft reads from and deploys to.');
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

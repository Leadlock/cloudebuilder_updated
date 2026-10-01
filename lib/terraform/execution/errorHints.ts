/**
 * Turns Terraform's raw error text into a short, plain explanation with next steps.
 *
 * Pure (no Node imports) so the Terraform panel can use it in the browser. The raw message is always kept and shown
 * behind a "details" toggle — this only adds a readable summary on top, it never hides or rewrites what Terraform said.
 */
import { isStateLockError, parseLockInfo } from './stateLockParse';

export type TerraformErrorKind =
  | 'state-lock' | 'resource-group-not-empty' | 'network' | 'not-installed' | 'invalid-configuration'
  | 'credentials' | 'already-exists' | 'quota' | 'timeout' | 'rate-limited' | 'unknown';

export interface TerraformErrorExplanation {
  kind: TerraformErrorKind;
  title: string;
  summary: string;
  steps: string[];
  /** Set when the error is about a state lock: the lock id the "Check lock" action works with. */
  lockId?: string;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** Names of the resources Terraform lists after "still exist within the Resource Group". */
function leftoverResources(message: string): string[] {
  return uniq([...message.matchAll(/`\/subscriptions\/[^`]*?\/providers\/([^`/]+)\/([^`/]+)\/([^`]+)`/g)].map((m) => `${m[3]} (${m[1]}/${m[2]})`));
}

export function explainTerraformError(raw: string | null | undefined): TerraformErrorExplanation | null {
  const message = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!message) return null;

  if (/CLI is not installed|not on PATH/i.test(message)) {
    return {
      kind: 'not-installed', title: 'Terraform is not installed on the server',
      summary: 'CloudCraft runs the Terraform program to plan, apply and destroy, and could not find it.',
      steps: ['Install Terraform from developer.hashicorp.com/terraform/install on the machine running the server.', 'Make sure it is on the PATH, or set TERRAFORM_BINARY_PATH to its full path, then try again.'],
    };
  }

  if (isStateLockError(message) || /remote state is locked/i.test(message)) {
    const info = parseLockInfo(message);
    const holder = info?.who ? ` by ${info.who}` : '';
    const since = info?.created ? ` since ${info.created.toISOString().replace('T', ' ').slice(0, 16)} UTC` : '';
    return {
      kind: 'state-lock', title: 'The Terraform state is locked',
      summary: `Another Terraform run${holder}${since} holds the lock on the shared state, so this one could not start. Terraform locks the state so two runs never write it at once.`,
      steps: [
        'If it is a teammate or a pipeline, wait for it to finish, or ask them.',
        'If it is a run from this machine that was interrupted (for example the internet dropped), use "Check lock" below — CloudCraft can release it safely when nothing is running.',
        'Never release a lock while its run might still be going: that can corrupt the state.',
      ],
      lockId: info?.id,
    };
  }

  const group = /deleting Resource Group "([^"]+)"[^]*?still contains Resources/i.exec(message);
  if (group || /still contains Resources/i.test(message)) {
    const left = leftoverResources(message);
    return {
      kind: 'resource-group-not-empty', title: `Azure still has resources in resource group "${group?.[1] ?? 'the group'}"`,
      summary: `Everything CloudCraft manages was removed, but the group still holds ${left.length > 0 ? left.length : 'other'} resource${left.length === 1 ? '' : 's'} it did not create${left.length > 0 ? `: ${left.join(', ')}` : ''}. Terraform refuses to delete a group that contains things outside its state.`,
      steps: [
        'Check whether those resources are still needed. If not, delete them in the Azure portal (or with the az command line).',
        'Then press Try again — the group itself is then quick to remove.',
        'Do not turn off Terraform\'s safety check (prevent_deletion_if_contains_resources): it would delete everything in the group, including things that are not yours.',
      ],
    };
  }

  if (/Reference to undeclared resource|rejected the generated configuration|Invalid reference|Unsupported argument|Missing required argument/i.test(message)) {
    return {
      kind: 'invalid-configuration', title: 'Terraform rejected the generated configuration',
      summary: 'The Terraform files CloudCraft generated for this architecture are not valid, so nothing was changed. This is a CloudCraft or design problem, not a cloud problem.',
      steps: ['Open the details to see which file and line Terraform objected to.', 'Check the resource named there (an imported or unusual setting is the usual cause), fix or remove it, and generate the plan again.', 'If it looks like a CloudCraft bug, report it with the details text.'],
    };
  }

  if (/getaddrinfow|no such host|dial tcp|i\/o timeout|connection reset|TLS handshake timeout|temporary failure in name resolution|network is unreachable|ECONNRESET|ENOTFOUND/i.test(message)) {
    return {
      kind: 'network', title: 'The connection to the cloud dropped',
      summary: 'This computer could not reach Azure/AWS or the state storage for a moment (a DNS or internet problem). Nothing is wrong with the design.',
      steps: ['Check the internet connection or VPN, and try again.', 'If it keeps happening, try a different DNS server (for example 1.1.1.1 or 8.8.8.8).', 'If a run was cut off, it may have left a state lock behind — use "Check lock" if the next attempt reports one.'],
    };
  }

  if (/AuthorizationFailed|InvalidAuthenticationToken|ExpiredToken|InvalidClientTokenId|AccessDenied|UnauthorizedOperation|AADSTS|SignatureDoesNotMatch|not authorized to perform|credentials/i.test(message)) {
    return {
      kind: 'credentials', title: 'The cloud account was not allowed to do this',
      summary: 'The connected account\'s credentials were rejected, have expired, or lack the permission this step needs.',
      steps: ['Reconnect the cloud account in the Import panel (or refresh its credentials).', 'Check the account has permission for the resources in this design.', 'Then try again.'],
    };
  }

  if (/already exists|needs to be imported into the State/i.test(message)) {
    return {
      kind: 'already-exists', title: 'A resource with that name already exists',
      summary: 'Terraform tried to create something that is already in the cloud account but not in its state file, often left over from an earlier deployment.',
      steps: ['Rename the resource in the design, or delete the existing one in the cloud console if it is not needed.', 'Or import it into the state with terraform import, then try again.'],
    };
  }

  if (/QuotaExceeded|LimitExceeded|SubscriptionIsOverQuotaForSku|InsufficientCapacity|vCPU/i.test(message)) {
    return {
      kind: 'quota', title: 'The account hit a quota or capacity limit',
      summary: 'The cloud account cannot create more of this resource right now (a quota, size limit or regional capacity).',
      steps: ['Pick a different size or region, or request a quota increase in the cloud console.', 'Then generate the plan again.'],
    };
  }

  if (/timed out after \d+ minutes/i.test(message)) {
    return {
      kind: 'timeout', title: 'The Terraform run took too long and was stopped',
      summary: 'Terraform did not finish within the time CloudCraft allows for this step. The cloud may still be finishing some work.',
      steps: ['Check the cloud console for what was created or removed.', 'Generate a fresh plan: it will show only what is still left to do.'],
    };
  }

  if (/Too many requests|RATE_LIMITED/i.test(message)) {
    return { kind: 'rate-limited', title: 'Too many requests', summary: 'You have used up the plans allowed in this window.', steps: ['Wait for the counter above to renew, then try again.'] };
  }

  return null;
}

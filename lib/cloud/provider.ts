/**
 * CloudProviderAdapter — base interface every cloud provider adapter must implement.
 * InfrastructureDiscoveryProvider — discovery operations on top of a provider adapter.
 *
 * Security contract:
 * - Credentials are accepted as constructor parameters and NEVER stored beyond the lifetime
 *   of the adapter instance.
 * - Adapters NEVER log credentials, secrets, or tokens.
 * - All public methods return sanitised data only.
 */
import { isAwsCredentials, isAzureCredentials } from './types';
import type {
  CloudCredentials,
  DiscoveryResult,
  AccountValidationResult,
  CloudProviderKey,
} from './types';
import type { DiscoveredTopology, DiscoveryOptions } from './discovery/types';

// ─── Base adapter ─────────────────────────────────────────────────────────────

/**
 * CloudProviderAdapter — lifecycle and identity operations for a cloud account.
 * Each adapter instance is scoped to a single set of credentials.
 */
export interface CloudProviderAdapter {
  readonly provider: CloudProviderKey;

  /**
   * Validate the credentials and check whether required read permissions are present.
   * Never throws — returns a structured result instead.
   */
  validateAccount(): Promise<AccountValidationResult>;

  /**
   * Destroy any SDK sessions or temporary tokens held by this adapter.
   * Calling this is best-effort; adapters must not throw from dispose().
   */
  dispose(): Promise<void>;
}

// ─── Discovery provider ───────────────────────────────────────────────────────

/**
 * InfrastructureDiscoveryProvider — discovers real resources from a cloud account.
 */
export interface InfrastructureDiscoveryProvider extends CloudProviderAdapter {
  /**
   * Discover all supported resource types in the configured account/region(s).
   * Returns a structured result; never throws.
   */
  discoverAll(regions?: string[]): Promise<DiscoveryResult>;

  /**
   * Read the account-level controls (CloudTrail, GuardDuty, root MFA, AWS Config), read-only. AWS only.
   * Never throws; a control that cannot be read comes back UNAVAILABLE with the reason.
   */
  readAccountControls?(regions: string[]): Promise<import('./accountControls/readAwsAccountControls').AccountControlResult[]>;

  /** Discover accessible regions for this account/subscription */
  discoverRegions?(): Promise<string[]>;

  /** Full topology discovery with relationships and hierarchy */
  discoverTopology?(options?: DiscoveryOptions): Promise<DiscoveredTopology>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a discovery provider for the given credentials.
 * Concrete adapters are imported lazily to avoid loading cloud SDKs at module init time
 * (which would pull in large SDK code and fail if env vars are missing).
 */
export async function createDiscoveryProvider(
  credentials: CloudCredentials,
): Promise<InfrastructureDiscoveryProvider> {
  if (isAwsCredentials(credentials)) {
    const { AwsDiscoveryAdapter } = await import('./adapters/awsAdapter');
    return new AwsDiscoveryAdapter(credentials);
  }
  if (isAzureCredentials(credentials)) {
    const { AzureDiscoveryAdapter } = await import('./adapters/azureAdapter');
    return new AzureDiscoveryAdapter(credentials);
  }
  throw new Error('Unrecognised credentials shape — cannot determine cloud provider');
}

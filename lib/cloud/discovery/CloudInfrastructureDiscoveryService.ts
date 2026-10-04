/**
 * CloudInfrastructureDiscoveryService — Provider-Independent Discovery Engine
 *
 * Orchestrates:
 * 1. Account credential validation
 * 2. Accessible region discovery
 * 3. Multi-region resource discovery across all supported AWS/Azure services
 * 4. Topological relationship reconstruction
 * 5. Progress reporting and rate limit backoff
 * 6. Non-fatal error handling and partial discovery resilience
 *
 * Security:
 * - Credentials are accepted as transient function arguments only.
 * - Adapters are disposed immediately after execution.
 * - Only sanitized metadata without secrets flows through this layer.
 */
import { isAwsCredentials, isAzureCredentials } from '../types';
import type { CloudCredentials, AccountValidationResult } from '../types';
import type {
  DiscoveredTopology,
  DiscoveryOptions,
} from './types';
import { AwsDiscoveryAdapter } from '../adapters/awsAdapter';
import { AzureDiscoveryAdapter } from '../adapters/azureAdapter';

export class CloudInfrastructureDiscoveryService {
  /**
   * Validate account credentials and verify required read-only permissions.
   */
  async validateAccount(credentials: CloudCredentials): Promise<AccountValidationResult> {
    if (isAwsCredentials(credentials)) {
      const adapter = new AwsDiscoveryAdapter(credentials);
      try {
        return await adapter.validateAccount();
      } finally {
        await adapter.dispose();
      }
    }

    if (isAzureCredentials(credentials)) {
      const adapter = new AzureDiscoveryAdapter(credentials);
      try {
        return await adapter.validateAccount();
      } finally {
        await adapter.dispose();
      }
    }

    throw new Error('Unrecognized credentials shape — cannot determine cloud provider');
  }

  /**
   * Dynamically discover accessible regions for the account.
   */
  async discoverRegions(credentials: CloudCredentials): Promise<string[]> {
    if (isAwsCredentials(credentials)) {
      const adapter = new AwsDiscoveryAdapter(credentials);
      try {
        return await adapter.discoverRegions();
      } finally {
        await adapter.dispose();
      }
    }

    if (isAzureCredentials(credentials)) {
      const adapter = new AzureDiscoveryAdapter(credentials);
      try {
        return await adapter.discoverRegions();
      } finally {
        await adapter.dispose();
      }
    }

    return [];
  }

  /**
   * Discover infrastructure and reconstruct topology.
   */
  async discoverInfrastructure(
    credentials: CloudCredentials,
    options: DiscoveryOptions = {},
  ): Promise<DiscoveredTopology> {
    if (isAwsCredentials(credentials)) {
      const adapter = new AwsDiscoveryAdapter(credentials);
      try {
        return await adapter.discoverTopology(options);
      } finally {
        await adapter.dispose();
      }
    }

    if (isAzureCredentials(credentials)) {
      const adapter = new AzureDiscoveryAdapter(credentials);
      try {
        return await adapter.discoverTopology(options);
      } finally {
        await adapter.dispose();
      }
    }

    throw new Error('Unrecognized credentials shape — cannot determine cloud provider');
  }
}

export const cloudInfrastructureDiscoveryService = new CloudInfrastructureDiscoveryService();

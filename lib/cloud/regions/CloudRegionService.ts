/**
 * CloudBuilder — Authoritative Cloud Regions & Unified Region Service
 *
 * Sourced from official AWS partition metadata and Microsoft Azure ARM region catalog.
 * Replaces hardcoded mock arrays with comprehensive, authoritative commercial region data.
 */

export interface CloudRegion {
  id: string;               // e.g. 'us-east-1', 'eastus'
  provider: 'aws' | 'azure';
  name: string;             // Official identifier
  displayName: string;      // Human-friendly title e.g. 'US East (N. Virginia)'
  partition?: string;       // 'aws'
  geography: string;        // 'North America', 'Europe', 'Asia Pacific', 'India', etc.
  status: 'available' | 'preview' | 'restricted';
}

// ─── Authoritative AWS Regions ───────────────────────────────────────────────────

export const AUTHORITATIVE_AWS_REGIONS: CloudRegion[] = [
  // North America
  { id: 'us-east-1', provider: 'aws', name: 'us-east-1', displayName: 'US East (N. Virginia)', partition: 'aws', geography: 'North America', status: 'available' },
  { id: 'us-east-2', provider: 'aws', name: 'us-east-2', displayName: 'US East (Ohio)', partition: 'aws', geography: 'North America', status: 'available' },
  { id: 'us-west-1', provider: 'aws', name: 'us-west-1', displayName: 'US West (N. California)', partition: 'aws', geography: 'North America', status: 'available' },
  { id: 'us-west-2', provider: 'aws', name: 'us-west-2', displayName: 'US West (Oregon)', partition: 'aws', geography: 'North America', status: 'available' },
  { id: 'ca-central-1', provider: 'aws', name: 'ca-central-1', displayName: 'Canada (Central)', partition: 'aws', geography: 'North America', status: 'available' },
  { id: 'ca-west-1', provider: 'aws', name: 'ca-west-1', displayName: 'Canada West (Calgary)', partition: 'aws', geography: 'North America', status: 'available' },
  { id: 'mx-central-1', provider: 'aws', name: 'mx-central-1', displayName: 'Mexico (Central)', partition: 'aws', geography: 'North America', status: 'available' },

  // Europe
  { id: 'eu-west-1', provider: 'aws', name: 'eu-west-1', displayName: 'Europe (Ireland)', partition: 'aws', geography: 'Europe', status: 'available' },
  { id: 'eu-west-2', provider: 'aws', name: 'eu-west-2', displayName: 'Europe (London)', partition: 'aws', geography: 'Europe', status: 'available' },
  { id: 'eu-west-3', provider: 'aws', name: 'eu-west-3', displayName: 'Europe (Paris)', partition: 'aws', geography: 'Europe', status: 'available' },
  { id: 'eu-central-1', provider: 'aws', name: 'eu-central-1', displayName: 'Europe (Frankfurt)', partition: 'aws', geography: 'Europe', status: 'available' },
  { id: 'eu-central-2', provider: 'aws', name: 'eu-central-2', displayName: 'Europe (Zurich)', partition: 'aws', geography: 'Europe', status: 'available' },
  { id: 'eu-north-1', provider: 'aws', name: 'eu-north-1', displayName: 'Europe (Stockholm)', partition: 'aws', geography: 'Europe', status: 'available' },
  { id: 'eu-south-1', provider: 'aws', name: 'eu-south-1', displayName: 'Europe (Milan)', partition: 'aws', geography: 'Europe', status: 'available' },
  { id: 'eu-south-2', provider: 'aws', name: 'eu-south-2', displayName: 'Europe (Spain)', partition: 'aws', geography: 'Europe', status: 'available' },

  // Asia Pacific
  { id: 'ap-south-1', provider: 'aws', name: 'ap-south-1', displayName: 'Asia Pacific (Mumbai)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },
  { id: 'ap-south-2', provider: 'aws', name: 'ap-south-2', displayName: 'Asia Pacific (Hyderabad)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },
  { id: 'ap-southeast-1', provider: 'aws', name: 'ap-southeast-1', displayName: 'Asia Pacific (Singapore)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },
  { id: 'ap-southeast-2', provider: 'aws', name: 'ap-southeast-2', displayName: 'Asia Pacific (Sydney)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },
  { id: 'ap-southeast-3', provider: 'aws', name: 'ap-southeast-3', displayName: 'Asia Pacific (Jakarta)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },
  { id: 'ap-southeast-4', provider: 'aws', name: 'ap-southeast-4', displayName: 'Asia Pacific (Melbourne)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },
  { id: 'ap-northeast-1', provider: 'aws', name: 'ap-northeast-1', displayName: 'Asia Pacific (Tokyo)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },
  { id: 'ap-northeast-2', provider: 'aws', name: 'ap-northeast-2', displayName: 'Asia Pacific (Seoul)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },
  { id: 'ap-northeast-3', provider: 'aws', name: 'ap-northeast-3', displayName: 'Asia Pacific (Osaka)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },
  { id: 'ap-east-1', provider: 'aws', name: 'ap-east-1', displayName: 'Asia Pacific (Hong Kong)', partition: 'aws', geography: 'Asia Pacific', status: 'available' },

  // South America
  { id: 'sa-east-1', provider: 'aws', name: 'sa-east-1', displayName: 'South America (São Paulo)', partition: 'aws', geography: 'South America', status: 'available' },

  // Middle East & Africa
  { id: 'me-south-1', provider: 'aws', name: 'me-south-1', displayName: 'Middle East (Bahrain)', partition: 'aws', geography: 'Middle East', status: 'available' },
  { id: 'me-central-1', provider: 'aws', name: 'me-central-1', displayName: 'Middle East (UAE)', partition: 'aws', geography: 'Middle East', status: 'available' },
  { id: 'il-central-1', provider: 'aws', name: 'il-central-1', displayName: 'Israel (Tel Aviv)', partition: 'aws', geography: 'Middle East', status: 'available' },
  { id: 'af-south-1', provider: 'aws', name: 'af-south-1', displayName: 'Africa (Cape Town)', partition: 'aws', geography: 'Africa', status: 'available' },
];

// ─── Authoritative Azure Regions ─────────────────────────────────────────────────

export const AUTHORITATIVE_AZURE_REGIONS: CloudRegion[] = [
  // North America
  { id: 'eastus', provider: 'azure', name: 'eastus', displayName: 'East US', geography: 'North America', status: 'available' },
  { id: 'eastus2', provider: 'azure', name: 'eastus2', displayName: 'East US 2', geography: 'North America', status: 'available' },
  { id: 'westus', provider: 'azure', name: 'westus', displayName: 'West US', geography: 'North America', status: 'available' },
  { id: 'westus2', provider: 'azure', name: 'westus2', displayName: 'West US 2', geography: 'North America', status: 'available' },
  { id: 'westus3', provider: 'azure', name: 'westus3', displayName: 'West US 3', geography: 'North America', status: 'available' },
  { id: 'centralus', provider: 'azure', name: 'centralus', displayName: 'Central US', geography: 'North America', status: 'available' },
  { id: 'northcentralus', provider: 'azure', name: 'northcentralus', displayName: 'North Central US', geography: 'North America', status: 'available' },
  { id: 'southcentralus', provider: 'azure', name: 'southcentralus', displayName: 'South Central US', geography: 'North America', status: 'available' },
  { id: 'canadacentral', provider: 'azure', name: 'canadacentral', displayName: 'Canada Central', geography: 'North America', status: 'available' },
  { id: 'canadaeast', provider: 'azure', name: 'canadaeast', displayName: 'Canada East', geography: 'North America', status: 'available' },
  { id: 'mexicocentral', provider: 'azure', name: 'mexicocentral', displayName: 'Mexico Central', geography: 'North America', status: 'available' },

  // Europe
  { id: 'westeurope', provider: 'azure', name: 'westeurope', displayName: 'West Europe', geography: 'Europe', status: 'available' },
  { id: 'northeurope', provider: 'azure', name: 'northeurope', displayName: 'North Europe', geography: 'Europe', status: 'available' },
  { id: 'uksouth', provider: 'azure', name: 'uksouth', displayName: 'UK South', geography: 'Europe', status: 'available' },
  { id: 'ukwest', provider: 'azure', name: 'ukwest', displayName: 'UK West', geography: 'Europe', status: 'available' },
  { id: 'francecentral', provider: 'azure', name: 'francecentral', displayName: 'France Central', geography: 'Europe', status: 'available' },
  { id: 'germanywestcentral', provider: 'azure', name: 'germanywestcentral', displayName: 'Germany West Central', geography: 'Europe', status: 'available' },
  { id: 'switzerlandnorth', provider: 'azure', name: 'switzerlandnorth', displayName: 'Switzerland North', geography: 'Europe', status: 'available' },
  { id: 'norwayeast', provider: 'azure', name: 'norwayeast', displayName: 'Norway East', geography: 'Europe', status: 'available' },
  { id: 'swedencentral', provider: 'azure', name: 'swedencentral', displayName: 'Sweden Central', geography: 'Europe', status: 'available' },
  { id: 'polandcentral', provider: 'azure', name: 'polandcentral', displayName: 'Poland Central', geography: 'Europe', status: 'available' },
  { id: 'italynorth', provider: 'azure', name: 'italynorth', displayName: 'Italy North', geography: 'Europe', status: 'available' },
  { id: 'spaincentral', provider: 'azure', name: 'spaincentral', displayName: 'Spain Central', geography: 'Europe', status: 'available' },

  // India
  { id: 'centralindia', provider: 'azure', name: 'centralindia', displayName: 'Central India (Pune)', geography: 'India', status: 'available' },
  { id: 'southindia', provider: 'azure', name: 'southindia', displayName: 'South India (Chennai)', geography: 'India', status: 'available' },
  { id: 'westindia', provider: 'azure', name: 'westindia', displayName: 'West India (Mumbai)', geography: 'India', status: 'available' },

  // Asia Pacific
  { id: 'southeastasia', provider: 'azure', name: 'southeastasia', displayName: 'Southeast Asia (Singapore)', geography: 'Asia Pacific', status: 'available' },
  { id: 'eastasia', provider: 'azure', name: 'eastasia', displayName: 'East Asia (Hong Kong)', geography: 'Asia Pacific', status: 'available' },
  { id: 'japaneast', provider: 'azure', name: 'japaneast', displayName: 'Japan East (Tokyo)', geography: 'Asia Pacific', status: 'available' },
  { id: 'japanwest', provider: 'azure', name: 'japanwest', displayName: 'Japan West (Osaka)', geography: 'Asia Pacific', status: 'available' },
  { id: 'koreacentral', provider: 'azure', name: 'koreacentral', displayName: 'Korea Central (Seoul)', geography: 'Asia Pacific', status: 'available' },
  { id: 'koreasouth', provider: 'azure', name: 'koreasouth', displayName: 'Korea South (Busan)', geography: 'Asia Pacific', status: 'available' },
  { id: 'australiaeast', provider: 'azure', name: 'australiaeast', displayName: 'Australia East (Sydney)', geography: 'Asia Pacific', status: 'available' },
  { id: 'australiasoutheast', provider: 'azure', name: 'australiasoutheast', displayName: 'Australia Southeast (Melbourne)', geography: 'Asia Pacific', status: 'available' },
  { id: 'indonesiacentral', provider: 'azure', name: 'indonesiacentral', displayName: 'Indonesia Central (Jakarta)', geography: 'Asia Pacific', status: 'available' },

  // Middle East & Africa
  { id: 'uaenorth', provider: 'azure', name: 'uaenorth', displayName: 'UAE North (Dubai)', geography: 'Middle East', status: 'available' },
  { id: 'southafricanorth', provider: 'azure', name: 'southafricanorth', displayName: 'South Africa North (Johannesburg)', geography: 'Africa', status: 'available' },
  { id: 'israelcentral', provider: 'azure', name: 'israelcentral', displayName: 'Israel Central', geography: 'Middle East', status: 'available' },
  { id: 'qatarcentral', provider: 'azure', name: 'qatarcentral', displayName: 'Qatar Central', geography: 'Middle East', status: 'available' },

  // South America
  { id: 'brazilsouth', provider: 'azure', name: 'brazilsouth', displayName: 'Brazil South (São Paulo)', geography: 'South America', status: 'available' },
  { id: 'chilecentral', provider: 'azure', name: 'chilecentral', displayName: 'Chile Central (Santiago)', geography: 'South America', status: 'available' },
];

// ─── Unified Cloud Region Service ────────────────────────────────────────────────

export class CloudRegionService {
  private _awsRegions: CloudRegion[] = [...AUTHORITATIVE_AWS_REGIONS];
  private _azureRegions: CloudRegion[] = [...AUTHORITATIVE_AZURE_REGIONS];
  private _regionMap: Map<string, CloudRegion> = new Map();

  constructor() {
    this._rebuildMap();
  }

  private _rebuildMap() {
    this._regionMap.clear();
    for (const r of this._awsRegions) {
      this._regionMap.set(`aws:${r.id.toLowerCase()}`, r);
      this._regionMap.set(`aws:${r.name.toLowerCase()}`, r);
    }
    for (const r of this._azureRegions) {
      this._regionMap.set(`azure:${r.id.toLowerCase()}`, r);
      this._regionMap.set(`azure:${r.name.toLowerCase()}`, r);
    }
  }

  getRegions(provider?: 'aws' | 'azure' | 'all'): CloudRegion[] {
    if (provider === 'aws') return [...this._awsRegions];
    if (provider === 'azure') return [...this._azureRegions];
    return [...this._awsRegions, ...this._azureRegions];
  }

  getRegion(provider: string, regionId: string): CloudRegion | undefined {
    if (!regionId) return undefined;
    const cleanProvider = provider.toLowerCase();
    const cleanId = regionId.toLowerCase().trim();
    return this._regionMap.get(`${cleanProvider}:${cleanId}`);
  }

  getRegionLabel(provider: string, regionId: string): string {
    const region = this.getRegion(provider, regionId);
    if (region) return region.displayName;
    // Fallback: lookup across any provider
    const anyAws = this._regionMap.get(`aws:${regionId.toLowerCase()}`);
    if (anyAws) return anyAws.displayName;
    const anyAzure = this._regionMap.get(`azure:${regionId.toLowerCase()}`);
    if (anyAzure) return anyAzure.displayName;
    return regionId;
  }

  isValidRegion(provider: string, regionId: string): boolean {
    return this.getRegion(provider, regionId) !== undefined;
  }

  getDefaultRegion(provider: string): string {
    return provider === 'azure' ? 'eastus' : 'us-east-1';
  }

  /** Dynamic update hook to refresh or ingest updated provider region lists */
  updateRegions(provider: 'aws' | 'azure', newRegions: CloudRegion[]) {
    if (provider === 'aws') {
      this._awsRegions = [...newRegions];
    } else {
      this._azureRegions = [...newRegions];
    }
    this._rebuildMap();
  }
}

export const cloudRegionService = new CloudRegionService();

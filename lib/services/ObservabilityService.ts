/**
 * CloudCraft — Real Observability Service
 *
 * Integrates with actual cloud monitoring APIs:
 *  - AWS:   CloudWatch (GetMetricStatistics via @aws-sdk/client-cloudwatch)
 *  - Azure: Azure Monitor REST API (management.azure.com)
 *  - GCP:   Cloud Monitoring (@google-cloud/monitoring MetricServiceClient)
 *
 * Rules:
 *  1. NEVER return Math.random() or synthetic values.
 *  2. If credentials are missing or the API call fails, return status: 'unavailable'.
 *  3. Responses are cached for 60 seconds per resource to limit API calls.
 */

import type { CloudProvider } from '@/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResourceMetrics {
  status: 'healthy' | 'warning' | 'critical' | 'unavailable' | 'unknown';
  cpuUtilization?: number;     // 0-100 percentage
  memoryUtilization?: number;  // 0-100 percentage
  networkInBytes?: number;
  networkOutBytes?: number;
  requestCount?: number;
  errorCount?: number;
  unavailableReason?: string;
  dataSource?: string;         // Which API/service returned this
  retrievedAt?: string;        // ISO timestamp
}

interface CacheEntry {
  metrics: ResourceMetrics;
  expiresAt: number;
}

// ─── In-memory cache (60s TTL) ───────────────────────────────────────────────

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cacheKey(provider: string, resourceId: string, region: string): string {
  return `${provider}::${region}::${resourceId}`;
}

function getCached(key: string): ResourceMetrics | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.metrics;
}

function setCache(key: string, metrics: ResourceMetrics): void {
  _cache.set(key, { metrics, expiresAt: Date.now() + CACHE_TTL_MS });
}

function unavailable(reason: string, dataSource?: string): ResourceMetrics {
  return { status: 'unavailable', unavailableReason: reason, dataSource, retrievedAt: new Date().toISOString() };
}

function deriveStatus(cpu?: number, memory?: number): 'healthy' | 'warning' | 'critical' {
  const c = cpu ?? 0;
  const m = memory ?? 0;
  if (c > 85 || m > 90) return 'critical';
  if (c > 70 || m > 75) return 'warning';
  return 'healthy';
}

// ─── AWS CloudWatch ───────────────────────────────────────────────────────────

async function getAwsMetrics(
  resourceId: string,
  resourceType: string,
  region: string,
  credentials: Record<string, string>
): Promise<ResourceMetrics> {
  const key = cacheKey('aws', resourceId, region);
  const cached = getCached(key);
  if (cached) return cached;

  const accessKeyId = credentials['accessKeyId'] || process.env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = credentials['secretAccessKey'] || process.env['AWS_SECRET_ACCESS_KEY'];

  if (!accessKeyId || !secretAccessKey) {
    const m = unavailable(
      'AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.',
      'aws-cloudwatch'
    );
    setCache(key, m);
    return m;
  }

  try {
    // Dynamic import to avoid loading the SDK when not needed
    const { CloudWatchClient, GetMetricStatisticsCommand } = await import('@aws-sdk/client-cloudwatch');

    const client = new CloudWatchClient({
      region: region || 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
    });

    const now = new Date();
    const startTime = new Date(now.getTime() - 5 * 60 * 1000); // last 5 minutes

    // Determine metric namespace + dimension based on resource type
    let namespace = 'AWS/EC2';
    let dimensionName = 'InstanceId';
    const cpuMetric = 'CPUUtilization';

    if (resourceType === 'aws_rds') {
      namespace = 'AWS/RDS';
      dimensionName = 'DBInstanceIdentifier';
    } else if (resourceType === 'aws_lambda') {
      namespace = 'AWS/Lambda';
      dimensionName = 'FunctionName';
    } else if (resourceType === 'aws_alb') {
      namespace = 'AWS/ApplicationELB';
      dimensionName = 'LoadBalancer';
    }

    const cpuCmd = new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: cpuMetric,
      Dimensions: [{ Name: dimensionName, Value: resourceId }],
      StartTime: startTime,
      EndTime: now,
      Period: 300,
      Statistics: ['Average'],
    });

    const networkInCmd = new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: 'NetworkIn',
      Dimensions: [{ Name: dimensionName, Value: resourceId }],
      StartTime: startTime,
      EndTime: now,
      Period: 300,
      Statistics: ['Sum'],
    });

    const networkOutCmd = new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: 'NetworkOut',
      Dimensions: [{ Name: dimensionName, Value: resourceId }],
      StartTime: startTime,
      EndTime: now,
      Period: 300,
      Statistics: ['Sum'],
    });

    const [cpuRes, netInRes, netOutRes] = await Promise.all([
      client.send(cpuCmd).catch(() => null),
      client.send(networkInCmd).catch(() => null),
      client.send(networkOutCmd).catch(() => null),
    ]);

    const cpuPoints = cpuRes?.Datapoints ?? [];
    const netInPoints = netInRes?.Datapoints ?? [];
    const netOutPoints = netOutRes?.Datapoints ?? [];

    type Datapoint = { Timestamp?: Date; Average?: number; Sum?: number };
    const cpu = cpuPoints.length > 0
      ? (cpuPoints as Datapoint[]).sort((a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0))[0]?.Average
      : undefined;

    const networkIn = netInPoints.length > 0
      ? (netInPoints as Datapoint[]).reduce((sum: number, d: Datapoint) => sum + (d.Sum ?? 0), 0)
      : undefined;

    const networkOut = netOutPoints.length > 0
      ? (netOutPoints as Datapoint[]).reduce((sum: number, d: Datapoint) => sum + (d.Sum ?? 0), 0)
      : undefined;

    const metrics: ResourceMetrics = {
      status: cpu !== undefined ? deriveStatus(cpu) : 'unknown',
      cpuUtilization: cpu !== undefined ? Math.round(cpu * 100) / 100 : undefined,
      networkInBytes: networkIn,
      networkOutBytes: networkOut,
      dataSource: 'aws-cloudwatch',
      retrievedAt: new Date().toISOString(),
    };

    setCache(key, metrics);
    return metrics;
  } catch (err: any) {
    const reason = err?.message ?? 'CloudWatch API call failed';
    console.error('[ObservabilityService] AWS CloudWatch error:', reason);
    const m = unavailable(`CloudWatch error: ${reason}`, 'aws-cloudwatch');
    setCache(key, m);
    return m;
  }
}

// ─── Azure Monitor ────────────────────────────────────────────────────────────

async function getAzureMetrics(
  resourceId: string,
  region: string,
  credentials: Record<string, string>
): Promise<ResourceMetrics> {
  const key = cacheKey('azure', resourceId, region);
  const cached = getCached(key);
  if (cached) return cached;

  const tenantId = credentials['tenantId'] || process.env['AZURE_TENANT_ID'];
  const clientId = credentials['clientId'] || process.env['AZURE_CLIENT_ID'];
  const clientSecret = credentials['clientSecret'] || process.env['AZURE_CLIENT_SECRET'];

  if (!tenantId || !clientId || !clientSecret) {
    const m = unavailable(
      'Azure credentials not configured. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET environment variables.',
      'azure-monitor'
    );
    setCache(key, m);
    return m;
  }

  try {
    // Get access token
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://management.azure.com/.default',
          grant_type: 'client_credentials',
        }),
      }
    );

    if (!tokenRes.ok) {
      const m = unavailable(`Azure auth failed: ${tokenRes.status}`, 'azure-monitor');
      setCache(key, m);
      return m;
    }

    const tokenData = await tokenRes.json() as { access_token: string };
    const accessToken = tokenData.access_token;

    // Query Azure Monitor Metrics API
    const now = new Date();
    const startTime = new Date(now.getTime() - 5 * 60 * 1000);
    const timespan = `${startTime.toISOString()}/${now.toISOString()}`;

    const metricsUrl = `https://management.azure.com${resourceId}/providers/microsoft.insights/metrics?api-version=2019-07-01&timespan=${timespan}&interval=PT5M&metricnames=Percentage%20CPU,Network%20In,Network%20Out&aggregation=Average,Total`;

    const metricsRes = await fetch(metricsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!metricsRes.ok) {
      const m = unavailable(`Azure Monitor API error: ${metricsRes.status}`, 'azure-monitor');
      setCache(key, m);
      return m;
    }

    const metricsData = await metricsRes.json() as { value: Array<{ name: { value: string }; timeseries: Array<{ data: Array<{ average?: number; total?: number }> }> }> };

    let cpu: number | undefined;
    let networkIn: number | undefined;
    let networkOut: number | undefined;

    for (const metric of metricsData.value ?? []) {
      const name = metric.name?.value?.toLowerCase() ?? '';
      const latest = metric.timeseries?.[0]?.data?.slice(-1)?.[0];

      if (name.includes('cpu') && latest?.average !== undefined) {
        cpu = Math.round(latest.average * 100) / 100;
      } else if (name.includes('network in') && latest?.total !== undefined) {
        networkIn = latest.total;
      } else if (name.includes('network out') && latest?.total !== undefined) {
        networkOut = latest.total;
      }
    }

    const metrics: ResourceMetrics = {
      status: cpu !== undefined ? deriveStatus(cpu) : 'unknown',
      cpuUtilization: cpu,
      networkInBytes: networkIn,
      networkOutBytes: networkOut,
      dataSource: 'azure-monitor',
      retrievedAt: new Date().toISOString(),
    };

    setCache(key, metrics);
    return metrics;
  } catch (err: any) {
    const reason = err?.message ?? 'Azure Monitor API call failed';
    console.error('[ObservabilityService] Azure Monitor error:', reason);
    const m = unavailable(`Azure Monitor error: ${reason}`, 'azure-monitor');
    setCache(key, m);
    return m;
  }
}

// ─── GCP Cloud Monitoring ─────────────────────────────────────────────────────

async function getGcpMetrics(
  resourceId: string,
  resourceType: string,
  region: string,
  credentials: Record<string, string>
): Promise<ResourceMetrics> {
  const key = cacheKey('gcp', resourceId, region);
  const cached = getCached(key);
  if (cached) return cached;

  const projectId = credentials['projectId'] || process.env['GCP_PROJECT_ID'] || process.env['GOOGLE_CLOUD_PROJECT'];
  const keyFilePath = process.env['GOOGLE_APPLICATION_CREDENTIALS'];

  if (!projectId) {
    const m = unavailable(
      'GCP credentials not configured. Set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS environment variables.',
      'gcp-monitoring'
    );
    setCache(key, m);
    return m;
  }

  try {
    const monitoring = await import('@google-cloud/monitoring');
    const client = new monitoring.MetricServiceClient(
      keyFilePath ? { keyFilename: keyFilePath } : undefined
    );

    const now = Math.floor(Date.now() / 1000);
    const fiveMinutesAgo = now - 300;

    // Map resource type to GCP metric type
    let metricType = 'compute.googleapis.com/instance/cpu/utilization';
    let resourceTypeFilter = 'gce_instance';
    let resourceLabel = 'instance_id';

    if (resourceType === 'gcp_sql_instance') {
      metricType = 'cloudsql.googleapis.com/database/cpu/utilization';
      resourceTypeFilter = 'cloudsql_database';
      resourceLabel = 'database_id';
    } else if (resourceType === 'gcp_cloud_run') {
      metricType = 'run.googleapis.com/container/cpu/utilizations';
      resourceTypeFilter = 'cloud_run_revision';
      resourceLabel = 'service_name';
    } else if (resourceType === 'gcp_cloud_function') {
      metricType = 'cloudfunctions.googleapis.com/function/execution_count';
      resourceTypeFilter = 'cloud_function';
      resourceLabel = 'function_name';
    }

    const [timeSeries] = await client.listTimeSeries({
      name: `projects/${projectId}`,
      filter: `metric.type="${metricType}" AND resource.labels.${resourceLabel}="${resourceId}"`,
      interval: {
        startTime: { seconds: fiveMinutesAgo },
        endTime: { seconds: now },
      },
      view: 'FULL',
    });

    if (!timeSeries || timeSeries.length === 0) {
      // No data for this resource (may not exist or have no recent activity)
      const m: ResourceMetrics = {
        status: 'unknown',
        unavailableReason: 'No time series data returned from Cloud Monitoring for this resource.',
        dataSource: 'gcp-monitoring',
        retrievedAt: new Date().toISOString(),
      };
      setCache(key, m);
      return m;
    }

    const series = timeSeries[0];
    const points = series.points ?? [];
    const latestPoint = points.sort((a, b) => {
      const ta = Number(a.interval?.endTime?.seconds ?? 0);
      const tb = Number(b.interval?.endTime?.seconds ?? 0);
      return tb - ta;
    })[0];

    const rawValue = latestPoint?.value?.doubleValue ?? latestPoint?.value?.int64Value;
    const cpu = rawValue !== undefined ? Math.round(Number(rawValue) * 10000) / 100 : undefined; // Convert 0-1 to 0-100

    const metrics: ResourceMetrics = {
      status: cpu !== undefined ? deriveStatus(cpu) : 'unknown',
      cpuUtilization: cpu,
      dataSource: 'gcp-monitoring',
      retrievedAt: new Date().toISOString(),
    };

    setCache(key, metrics);
    return metrics;
  } catch (err: any) {
    const reason = err?.message ?? 'GCP Cloud Monitoring API call failed';
    console.error('[ObservabilityService] GCP Monitoring error:', reason);
    const m = unavailable(`GCP Monitoring error: ${reason}`, 'gcp-monitoring');
    setCache(key, m);
    return m;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface MetricsRequest {
  provider: CloudProvider;
  resourceId: string;      // The actual cloud resource ID (instance ID, ARN, Azure resource path, etc.)
  resourceType: string;    // CloudCraft resource type e.g. aws_ec2, azure_vm
  region: string;
  credentials?: Record<string, string>;
}

export class ObservabilityService {
  /**
   * Fetches real cloud metrics for a resource.
   * Returns UNAVAILABLE if credentials are missing — never synthesizes fake data.
   */
  static async getResourceMetrics(req: MetricsRequest): Promise<ResourceMetrics> {
    const creds = req.credentials ?? {};

    if (req.provider === 'aws') {
      return getAwsMetrics(req.resourceId, req.resourceType, req.region, creds);
    }

    if (req.provider === 'azure') {
      return getAzureMetrics(req.resourceId, req.region, creds);
    }

    if (req.provider === 'gcp') {
      return getGcpMetrics(req.resourceId, req.resourceType, req.region, creds);
    }

    return { status: 'unknown', unavailableReason: `Unsupported provider: ${req.provider}` };
  }

  /**
   * Batch fetch metrics for multiple resources.
   */
  static async getBatchMetrics(
    requests: MetricsRequest[]
  ): Promise<Record<string, ResourceMetrics>> {
    const results = await Promise.all(
      requests.map(async (req) => {
        const metrics = await ObservabilityService.getResourceMetrics(req);
        return [req.resourceId, metrics] as [string, ResourceMetrics];
      })
    );
    return Object.fromEntries(results);
  }

  /**
   * Clear the metrics cache (useful for testing).
   */
  static clearCache(): void {
    _cache.clear();
  }
}

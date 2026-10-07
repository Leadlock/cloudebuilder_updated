/**
 * Tests for AwsPricingProvider's live AWS Price List Query API integration
 * (lib/cloud/pricing/AwsPricingProvider.ts). Verifies:
 *  - No credentials configured -> falls back to the static rate table, never calls the SDK.
 *  - Credentials configured + a matching product -> uses the live price, source flips to 'aws-price-list-api'.
 *  - Credentials configured but the call throws/returns nothing -> falls back gracefully, never throws.
 *  - The correct AWS Price List filter attributes are sent for EC2/RDS/S3/EBS/ALB.
 *
 * The pricing client is created lazily and cached at module scope, so every
 * test uses jest.resetModules() + a fresh dynamic import to get an isolated
 * module instance per credential scenario.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-pricing', () => ({
  PricingClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetProductsCommand: jest.fn().mockImplementation((p: unknown) => ({
    ...(p as object),
    constructor: { name: 'GetProductsCommand' },
  })),
}));

function priceListItem(usd: string, unit = 'Hrs') {
  return JSON.stringify({
    product: { productFamily: 'Test', attributes: {} },
    terms: {
      OnDemand: {
        'sku.term': {
          priceDimensions: {
            'sku.term.dim': { unit, pricePerUnit: { USD: usd }, description: 'test dimension' },
          },
        },
      },
    },
  });
}

describe('AwsPricingProvider — live AWS Price List Query API', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    mockSend.mockReset();
    process.env = { ...ORIGINAL_ENV };
    delete process.env['AWS_PRICING_ACCESS_KEY_ID'];
    delete process.env['AWS_PRICING_SECRET_ACCESS_KEY'];
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // The AWS SDK returns each product as a JSON string WRAPPER object (a String object, typeof 'object'), not a primitive string. Reading it as
  // an already-parsed product found no prices, so every live lookup silently fell back to the built-in table.
  test('reads prices from the String wrapper objects the SDK returns', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secret';
    mockSend.mockResolvedValue({ PriceList: [new String(priceListItem('0.0225', 'Hrs'))] });
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const price = await new AwsPricingProvider().getPrice({ provider: 'aws', resourceType: 'aws_alb', region: 'us-east-1', configuration: {} });
    expect(price!.source).toBe('aws-price-list-api');
  });

  test('NAT Gateway prices are looked up under the Amazon EC2 service, where AWS lists them', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secret';
    mockSend.mockResolvedValue({ PriceList: [] });
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    await new AwsPricingProvider().getPrice({ provider: 'aws', resourceType: 'aws_nat', region: 'us-east-1', configuration: {} });
    expect(mockSend.mock.calls[0]![0]).toMatchObject({ ServiceCode: 'AmazonEC2' });
  });

  test('falls back to the static rate table when no credentials are configured, and never calls the SDK', async () => {
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 't3.micro' },
    });
    expect(price).not.toBeNull();
    expect(price!.source).toBe('aws-static-rate-table');
    expect(price!.unitPrice).toBeCloseTo(0.0104, 3);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Regression tests for the "scale up/down the user count, cost stays the
  // same" bug: AdaptiveScaleEngine.ts assigns c6g.xlarge/2xlarge/4xlarge
  // (EC2) and db.r6g.xlarge/2xlarge/4xlarge (RDS) at every scale tier above
  // "Production Small", but EC2_BASE_HOURLY/RDS_BASE_HOURLY — the tables
  // that actually run in this project's dev/test environment, since no
  // AWS_PRICING_ACCESS_KEY_ID is configured — had zero entries for any of
  // them, so they silently fell back to t3.medium/db.t3.micro pricing and
  // the displayed cost never changed no matter how far up the scale went.
  test('EC2: c6g.4xlarge prices differently from (and higher than) t3.medium under the static fallback', async () => {
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const small = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 't3.medium' },
    });
    const scaled = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 'c6g.4xlarge' },
    });
    expect(scaled!.source).toBe('aws-static-rate-table');
    expect(scaled!.unitPrice).toBeCloseTo(0.544, 3);
    expect(scaled!.unitPrice).toBeGreaterThan(small!.unitPrice * 5);
  });

  test('EC2: c6g.xlarge and c6g.2xlarge price distinctly from each other (not all Graviton tiers collapsing to one price)', async () => {
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const xlarge = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 'c6g.xlarge' },
    });
    const twoXlarge = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 'c6g.2xlarge' },
    });
    expect(xlarge!.unitPrice).toBeCloseTo(0.136, 3);
    expect(twoXlarge!.unitPrice).toBeCloseTo(0.272, 3);
    expect(twoXlarge!.unitPrice).toBeCloseTo(xlarge!.unitPrice * 2, 3);
  });

  test('RDS: db.r6g.4xlarge prices differently from (and higher than) db.t3.micro under the static fallback', async () => {
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const small = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_rds', region: 'us-east-1', configuration: { instanceClass: 'db.t3.micro' },
    });
    const scaled = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_rds', region: 'us-east-1', configuration: { instanceClass: 'db.r6g.4xlarge' },
    });
    expect(scaled!.source).toBe('aws-static-rate-table');
    expect(scaled!.unitPrice).toBeCloseTo(1.798, 3);
    expect(scaled!.unitPrice).toBeGreaterThan(small!.unitPrice * 50);
  });

  test('RDS: db.r6g.xlarge/2xlarge/4xlarge each price distinctly (not all collapsing to one price)', async () => {
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const x1 = await provider.getPrice({ provider: 'aws', resourceType: 'aws_rds', region: 'us-east-1', configuration: { instanceClass: 'db.r6g.xlarge' } });
    const x2 = await provider.getPrice({ provider: 'aws', resourceType: 'aws_rds', region: 'us-east-1', configuration: { instanceClass: 'db.r6g.2xlarge' } });
    const x4 = await provider.getPrice({ provider: 'aws', resourceType: 'aws_rds', region: 'us-east-1', configuration: { instanceClass: 'db.r6g.4xlarge' } });
    expect(x1!.unitPrice).toBeCloseTo(0.450, 3);
    expect(x2!.unitPrice).toBeCloseTo(0.899, 3);
    expect(x4!.unitPrice).toBeCloseTo(1.798, 3);
    expect(new Set([x1!.unitPrice, x2!.unitPrice, x4!.unitPrice]).size).toBe(3);
  });

  test('EC2: uses the live price and source when credentials are configured and a product matches', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: [priceListItem('0.0199000000')] });

    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 't3.micro' },
    });
    expect(price).not.toBeNull();
    expect(price!.source).toBe('aws-price-list-api');
    expect(price!.unitPrice).toBeCloseTo(0.0199, 4);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('falls back to the static rate table when the live API call throws', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockRejectedValue(new Error('simulated network failure'));

    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_rds', region: 'us-east-1', configuration: { instanceClass: 'db.t3.micro' },
    });
    expect(price).not.toBeNull();
    expect(price!.source).toBe('aws-static-rate-table');
  });

  test('falls back to the static rate table when the live API returns no matching products', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: [] });

    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_s3', region: 'us-east-1', configuration: { estimatedStorageGb: 100 },
    });
    expect(price).not.toBeNull();
    expect(price!.source).toBe('aws-static-rate-table');
  });

  test('a malformed PriceList entry (unparsable JSON) is skipped, falling back to static', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: ['{not valid json'] });

    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_ebs', region: 'us-east-1', configuration: { sizeGb: 100, type: 'gp3' },
    });
    expect(price).not.toBeNull();
    expect(price!.source).toBe('aws-static-rate-table');
  });

  test('RDS live query filters on the mapped databaseEngine and deploymentOption', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: [priceListItem('0.5000000000')] });

    const { GetProductsCommand } = await import('@aws-sdk/client-pricing');
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    await provider.getPrice({
      provider: 'aws', resourceType: 'aws_rds', region: 'us-east-1',
      configuration: { instanceClass: 'db.m5.large', engine: 'postgres', multiAz: true },
    });

    const call = (GetProductsCommand as unknown as jest.Mock).mock.calls[0]![0] as {
      ServiceCode: string;
      Filters: Array<{ Field: string; Value: string }>;
    };
    expect(call.ServiceCode).toBe('AmazonRDS');
    const byField = Object.fromEntries(call.Filters.map((f) => [f.Field, f.Value]));
    expect(byField['databaseEngine']).toBe('PostgreSQL');
    expect(byField['deploymentOption']).toBe('Multi-AZ');
    expect(byField['instanceType']).toBe('db.m5.large');
    expect(byField['location']).toBe('US East (N. Virginia)');
  });

  test('EBS live query filters on volumeApiName matching the configured volume type', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: [priceListItem('0.1250000000')] });

    const { GetProductsCommand } = await import('@aws-sdk/client-pricing');
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_ebs', region: 'us-east-1', configuration: { sizeGb: 200, type: 'io2' },
    });

    const call = (GetProductsCommand as unknown as jest.Mock).mock.calls[0]![0] as {
      Filters: Array<{ Field: string; Value: string }>;
    };
    const byField = Object.fromEntries(call.Filters.map((f) => [f.Field, f.Value]));
    expect(byField['volumeApiName']).toBe('io2');
    expect(price!.unitPrice).toBeCloseTo(0.125, 4);
    expect(price!.monthlyPrice).toBeCloseTo(200 * 0.125, 2);
  });

  test('ALB live query switches productFamily for Network Load Balancers', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: [priceListItem('0.0225000000')] });

    const { GetProductsCommand } = await import('@aws-sdk/client-pricing');
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    await provider.getPrice({
      provider: 'aws', resourceType: 'aws_alb', region: 'us-east-1', configuration: { lbType: 'network' },
    });

    const call = (GetProductsCommand as unknown as jest.Mock).mock.calls[0]![0] as {
      Filters: Array<{ Field: string; Value: string }>;
    };
    const byField = Object.fromEntries(call.Filters.map((f) => [f.Field, f.Value]));
    expect(byField['productFamily']).toBe('Load Balancer-Network');
  });

  test('a request timeout is treated as a failure and falls back to static (does not hang or throw)', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockImplementation(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })), 10);
    }));

    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({
      provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 't3.micro' },
    });
    expect(price).not.toBeNull();
    expect(price!.source).toBe('aws-static-rate-table');
  });

  test('resource types with no live wiring (Lambda, CloudFront, DynamoDB) always report the static source', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: [priceListItem('9.9900000000')] });

    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    for (const resourceType of ['aws_lambda', 'aws_cloudfront', 'aws_dynamodb']) {
      const price = await provider.getPrice({ provider: 'aws', resourceType, region: 'us-east-1', configuration: {} });
      expect(price).not.toBeNull();
      expect(price!.source).toBe('aws-static-rate-table');
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('NAT Gateway: disambiguates the hourly vs per-GB meter by unit, not by guessing the group attribute', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({
      PriceList: [
        priceListItem('0.0450000000', 'Hrs'),
        priceListItem('0.0450000000', 'GB'),
      ],
    });

    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({ provider: 'aws', resourceType: 'aws_nat', region: 'us-east-1', configuration: {} });
    expect(price).not.toBeNull();
    expect(price!.source).toBe('aws-price-list-api');
    expect(price!.unitPrice).toBeCloseTo(0.045, 4);
  });

  test('NAT Gateway falls back to static when no Hrs-unit meter is found among the results', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: [priceListItem('0.0450000000', 'GB')] });

    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({ provider: 'aws', resourceType: 'aws_nat', region: 'us-east-1', configuration: {} });
    expect(price).not.toBeNull();
    expect(price!.source).toBe('aws-static-rate-table');
  });

  test('EKS: uses the live control plane hourly rate when available', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: [priceListItem('0.1000000000', 'Hrs')] });

    const { GetProductsCommand } = await import('@aws-sdk/client-pricing');
    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    const price = await provider.getPrice({ provider: 'aws', resourceType: 'aws_eks', region: 'us-east-1', configuration: {} });
    expect(price).not.toBeNull();
    expect(price!.source).toBe('aws-price-list-api');
    expect(price!.unitPrice).toBeCloseTo(0.10, 4);

    const call = (GetProductsCommand as unknown as jest.Mock).mock.calls[0]![0] as {
      ServiceCode: string;
      Filters: Array<{ Field: string; Value: string }>;
    };
    expect(call.ServiceCode).toBe('AmazonEKS');
    const byField = Object.fromEntries(call.Filters.map((f) => [f.Field, f.Value]));
    expect(byField['productFamily']).toBe('Kubernetes');
  });
});

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

  describe('ElastiCache', () => {
    const product = (usagetype: string, usd: string) => JSON.stringify({
      product: { productFamily: 'Cache Instance', attributes: { usagetype } },
      terms: { OnDemand: { t: { priceDimensions: { d: { unit: 'Hrs', pricePerUnit: { USD: usd }, description: '' } } } } },
    });
    // Real rows for cache.t3.medium Redis in us-east-1 (2026-10-07): the ordinary node meter and two extended-support meters for old engine versions.
    const T3_MEDIUM = [
      product('USE1-ExtendedSupportYr3-NodeUsage:cache.t3.medium', '0.1090000000'),
      product('NodeUsage:cache.t3.medium', '0.0680000000'),
      product('USE1-ExtendedSupportYr1_Yr2-NodeUsage:cache.t3.medium', '0.0540000000'),
    ];
    const withKey = () => {
      process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
      process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secret';
    };
    const ask = async (config: Record<string, unknown>) => {
      const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
      return new AwsPricingProvider().getPrice({ provider: 'aws', resourceType: 'aws_elasticache', region: 'us-east-1', configuration: config });
    };

    test('prices the ordinary node meter times the node count, never an extended-support meter (hand-checked $99.28 for 2 nodes)', async () => {
      withKey();
      mockSend.mockResolvedValue({ PriceList: T3_MEDIUM });
      const p = await ask({ nodeType: 'cache.t3.medium', numNodes: 2 });
      expect(p!.source).toBe('aws-price-list-api');
      expect(p!.monthlyPrice).toBeCloseTo(0.068 * 2 * 730, 2);
    });

    test('asks for the node type, engine, location and Cache Instance family', async () => {
      withKey();
      mockSend.mockResolvedValue({ PriceList: T3_MEDIUM });
      await ask({ nodeType: 'cache.r6g.large', numNodes: 1 });
      const cmd = mockSend.mock.calls[0]![0] as { ServiceCode: string; Filters: { Field: string; Value: string }[] };
      expect(cmd.ServiceCode).toBe('AmazonElastiCache');
      expect(cmd.Filters).toEqual(expect.arrayContaining([
        { Type: 'TERM_MATCH', Field: 'instanceType', Value: 'cache.r6g.large' },
        { Type: 'TERM_MATCH', Field: 'cacheEngine', Value: 'Redis' },
        { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Cache Instance' },
      ]));
    });

    test('only extended-support rows, or no rows, give null so the built-in estimator prices it', async () => {
      withKey();
      mockSend.mockResolvedValue({ PriceList: [T3_MEDIUM[0]] });
      expect(await ask({ nodeType: 'cache.t3.medium' })).toBeNull();
      mockSend.mockResolvedValue({ PriceList: [] });
      expect(await ask({ nodeType: 'cache.t3.medium' })).toBeNull();
    });

    test('without AWS price list access it returns null and never calls the SDK', async () => {
      expect(await ask({ nodeType: 'cache.t3.medium' })).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('ECS Fargate', () => {
    const row = (usagetype: string, usd: string) => JSON.stringify({
      product: { productFamily: 'Compute', attributes: { usagetype } },
      terms: { OnDemand: { t: { priceDimensions: { d: { unit: 'hours', pricePerUnit: { USD: usd }, description: '' } } } } },
    });
    // Real us-east-1 rows (2026-10-07), with the Spot, ARM, Windows and ephemeral-storage meters that sit in the same family.
    const FARGATE = [
      row('USE1-Fargate-Spot-vCPU-Hours:perCPU', '0.0121440000'),
      row('USE1-Fargate-ARM-vCPU-Hours:perCPU', '0.0323840000'),
      row('USE1-Fargate-Windows-vCPU-Hours:perCPU', '0.0910000000'),
      row('USE1-Fargate-EphemeralStorage-GB-Hours', '0.0001110000'),
      row('USE1-Fargate-vCPU-Hours:perCPU', '0.0404800000'),
      row('USE1-Fargate-GB-Hours', '0.0044450000'),
    ];
    const ask = async (config: Record<string, unknown>) => {
      process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
      process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secret';
      const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
      return new AwsPricingProvider().getPrice({ provider: 'aws', resourceType: 'aws_ecs', region: 'us-east-1', configuration: config });
    };

    // AWS answers each question separately: the per-vCPU meters for cputype=perCPU, the per-GB meters for memorytype=perGB.
    const answerFargate = (rows = FARGATE) => mockSend.mockImplementation(async (cmd: { Filters: { Field: string }[] }) => ({
      PriceList: rows.filter((r) => (cmd.Filters.some((f) => f.Field === 'cputype') ? /vCPU/.test(r) : /GB-Hours/.test(r))),
    }));

    test('1 vCPU / 2 GB x 2 tasks uses only the plain Linux rates (hand-checked $72.08)', async () => {
      answerFargate();
      const p = await ask({ launchType: 'FARGATE', cpu: 1024, memory: 2048, desiredCount: 2 });
      expect(p!.source).toBe('aws-price-list-api');
      expect(p!.monthlyPrice).toBeCloseTo((1 * 0.04048 + 2 * 0.004445) * 2 * 730, 2);
    });

    test('the EC2 launch type has no ECS charge of its own, so it is left to the built-in estimator', async () => {
      answerFargate();
      expect(await ask({ launchType: 'EC2', cpu: 1024, memory: 2048, desiredCount: 2 })).toBeNull();
    });

    test('a missing rate is never guessed (null)', async () => {
      answerFargate([FARGATE[4]!]);
      expect(await ask({ launchType: 'FARGATE', cpu: 1024, memory: 2048 })).toBeNull();
    });
  });

  describe('CloudFront', () => {
    const dim = (unit: string, begin: string, end: string, usd: string) => ({ unit, beginRange: begin, endRange: end, pricePerUnit: { USD: usd }, description: '' });
    const item = (usagetype: string, dims: ReturnType<typeof dim>[]) => JSON.stringify({
      product: { productFamily: 'x', attributes: { usagetype } },
      terms: { OnDemand: { t: { priceDimensions: Object.fromEntries(dims.map((d, i) => [`d${i}`, d])) } } },
    });
    // Real rows (2026-10-07): United States data transfer out in tiers, and HTTPS requests.
    const TRANSFER = item('US-DataTransfer-Out-Bytes', [dim('GB', '0', '10240', '0.085'), dim('GB', '10240', '51200', '0.080'), dim('GB', '51200', 'Inf', '0.060')]);
    const REQUESTS = item('US-Requests-Tier2-HTTPS', [dim('Requests', '0', 'Inf', '0.000001')]);
    const answerByUsage = () => mockSend.mockImplementation(async (cmd: { Filters: { Field: string; Value: string }[] }) => {
      const usage = cmd.Filters.find((f) => f.Field === 'usagetype')?.Value;
      return { PriceList: usage === 'US-DataTransfer-Out-Bytes' ? [TRANSFER] : usage === 'US-Requests-Tier2-HTTPS' ? [REQUESTS] : [] };
    });
    const ask = async (config: Record<string, unknown>) => {
      process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
      process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secret';
      const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
      return new AwsPricingProvider().getPrice({ provider: 'aws', resourceType: 'aws_cloudfront', region: 'us-east-1', configuration: config });
    };

    test('the assumed 1 TB and 10M requests cost $85 + $10 (hand-checked), and the line states the assumption', async () => {
      answerByUsage();
      const p = await ask({ priceClass: 'PriceClass_100' });
      expect(p!.source).toBe('aws-price-list-api');
      expect(p!.monthlyPrice).toBeCloseTo(1000 * 0.085 + 10_000_000 * 0.000001, 2);
      expect(p!.assumptions[0]).toMatch(/^Assumed traffic: 1000 GB/);
    });

    test('data transfer is charged tier by tier: 20,000 GB is 10,240 at $0.085 plus 9,760 at $0.080', async () => {
      answerByUsage();
      const p = await ask({ estimatedDataTransferGb: 20_000, estimatedRequests: 0 });
      expect(p!.monthlyPrice).toBeCloseTo(10_240 * 0.085 + 9_760 * 0.08, 2);
    });

    test('a class other than 100 says the United States rate is a lower bound', async () => {
      answerByUsage();
      const p = await ask({ priceClass: 'PriceClass_All' });
      expect(p!.assumptions.join(' ')).toMatch(/lower bound/);
    });

    test('with no answer from the list it falls back to the built-in estimate, never throws', async () => {
      mockSend.mockResolvedValue({ PriceList: [] });
      const p = await ask({ priceClass: 'PriceClass_100' });
      expect(p!.source).toBe('aws-static-rate-table');
    });
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

  test('resource types with no live wiring (Lambda, DynamoDB) always report the static source', async () => {
    process.env['AWS_PRICING_ACCESS_KEY_ID'] = 'AKIATEST';
    process.env['AWS_PRICING_SECRET_ACCESS_KEY'] = 'secrettest';
    mockSend.mockResolvedValue({ PriceList: [priceListItem('9.9900000000')] });

    const { AwsPricingProvider } = await import('@/lib/cloud/pricing/AwsPricingProvider');
    const provider = new AwsPricingProvider();
    for (const resourceType of ['aws_lambda', 'aws_dynamodb']) {
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

import { detectServiceNotices, describeNotices, SERVICES } from '@/lib/ai/serviceCoverage';
import { CATALOG_TYPES } from '@/lib/ai/architectureSpec';

const names = (p: string, design?: string[]) => detectServiceNotices(p, design).unsupported.map((u) => u.service);

describe('unsupported services', () => {
  it('flags every service CloudCraft cannot model, however the request is worded', () => {
    expect(names('Design a real-time data pipeline on AWS using Kinesis, Glue and Redshift.')).toEqual(['Kinesis', 'Glue', 'Redshift']);
    expect(names('Build an API Gateway and Step Functions workflow on AWS')).toEqual(['API Gateway', 'Step Functions']);
    expect(names('azure event hubs + logic apps + api management')).toEqual(['Event Hubs', 'Logic Apps', 'API Management']);
    expect(names('we use apigateway with cognito')).toEqual(['API Gateway', 'Cognito']);
  });

  it('offers the closest services that DO exist, by their CloudCraft names', () => {
    const [apigw] = detectServiceNotices('API Gateway in front of Lambda').unsupported;
    expect(apigw!.nearest).toEqual(['Load Balancer', 'Lambda']);
    expect(describeNotices({ unsupported: [apigw!], missing: [] })[0]).toBe("API Gateway isn't supported by CloudCraft yet — closest available: Load Balancer, Lambda.");
  });

  it('does not flag services CloudCraft models, including Aurora (an RDS engine option)', () => {
    expect(names('Lambda, DynamoDB, S3, CloudFront, SQS, EKS and Aurora PostgreSQL on AWS')).toEqual([]);
    expect(names('Azure Functions with Cosmos DB, Key Vault and Front Door')).toEqual([]);
  });

  it('does not flag ordinary words that merely contain a service name', () => {
    expect(names('we need some glue code between the web tier and the database')).toEqual([]);
  });

  it('ignores a service mentioned only to exclude it', () => {
    expect(names('a web app without Kinesis or any streaming')).toEqual([]);
    expect(names('no API Gateway please, just a load balancer')).toEqual([]);
  });

  it('stops warning by itself once the catalog gains the type', () => {
    const withApiGateway = new Set([...CATALOG_TYPES, 'aws_api_gateway']);
    expect(detectServiceNotices('API Gateway and Kinesis', undefined, withApiGateway).unsupported.map((u) => u.service)).toEqual(['Kinesis']);
  });
});

describe('services asked for but missing from the design', () => {
  it('reports a supported service the model left out', () => {
    const out = detectServiceNotices('serverless API with DynamoDB and a CDN on CloudFront', ['aws_lambda', 'aws_s3']);
    expect(out.missing.map((m) => m.service)).toEqual(['DynamoDB', 'CloudFront']);
    expect(describeNotices(out)).toContain("You asked for DynamoDB, but it isn't in the design.");
  });

  it('reports nothing when the design contains what was asked for', () => {
    expect(detectServiceNotices('Redis cache and Lambda', ['aws_elasticache', 'aws_lambda']).missing).toEqual([]);
    expect(detectServiceNotices('Redis cache', ['azure_redis']).missing).toEqual([]);   // either cloud's Redis counts
  });

  it('does not check the design at all when no design was produced', () => {
    expect(detectServiceNotices('DynamoDB on AWS').missing).toEqual([]);
  });
});

describe('the service table', () => {
  it('lists each service once', () => {
    const seen = SERVICES.map((s) => s.name);
    expect(new Set(seen).size).toBe(seen.length);
  });
  it('only claims "nearest" alternatives that exist in the catalog', () => {
    for (const s of SERVICES) for (const t of s.nearest ?? []) expect(CATALOG_TYPES).toContain(t);
  });
});

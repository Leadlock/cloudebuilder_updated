/**
 * The connections a data / event pipeline is drawn with must be classified, not "Unclassified Connection (protocol/port not
 * verified)": compute → DynamoDB, CloudWatch monitoring, and S3 event notifications (AWS); compute → Cosmos DB (Azure).
 * And a request for a "data lake" must say CloudBuilder cannot model one (Glue / Athena / Lake Formation are not in the catalog).
 */
import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import { detectServiceNotices, describeNotices } from '@/lib/ai/serviceCoverage';
import { awsEventDriven } from '../scripts/ai-dataset/morePatterns';
import type { Requirements } from '../scripts/ai-dataset/requirements';

const node = (type: string, id = type) => ({ id, type: 'cloudNode', resourceType: type, provider: type.startsWith('azure') ? 'azure' : 'aws', label: type, position: { x: 0, y: 0 }, config: {} }) as never;
const check = (from: string, to: string) => {
  const a = node(from, 'a'); const b = node(to, 'b');
  return relationshipEngine.validateConnection(a, b, [a, b], []);
};
const classified = (r: { label?: string }) => !/Unclassified/i.test(r.label ?? '');

describe('AWS: compute → DynamoDB', () => {
  it.each(['aws_lambda', 'aws_ec2', 'aws_auto_scaling', 'aws_ecs', 'aws_eks'])('%s → DynamoDB is HTTPS/443 authorised by IAM', (src) => {
    const r = check(src, 'aws_dynamodb');
    expect(r).toMatchObject({ isValid: true, relationshipType: 'CONNECTS_TO', protocol: 'HTTPS / IAM', port: 443, label: 'DynamoDB API / IAM' });
  });
  it('direction still matters: a database does not call compute, and the internet cannot reach DynamoDB', () => {
    expect(check('aws_dynamodb', 'aws_lambda')).toMatchObject({ isValid: false, error: { code: 'REVERSE_COMPUTE_CONNECTION' } });
    expect(check('aws_internet', 'aws_dynamodb')).toMatchObject({ isValid: false });
  });
});

describe('AWS: CloudWatch monitoring', () => {
  it.each(['aws_lambda', 'aws_dynamodb', 'aws_rds', 'aws_sqs', 'aws_s3', 'aws_ec2'])('is classified in both directions for %s', (t) => {
    for (const r of [check('aws_cloudwatch', t), check(t, 'aws_cloudwatch')]) {
      expect(r).toMatchObject({ isValid: true, relationshipType: 'ASSOCIATED_WITH', label: 'Alarm / Metric Monitoring' });
    }
  });
});

describe('AWS: S3 event notifications', () => {
  it.each(['aws_lambda', 'aws_sqs'])('S3 → %s is an event trigger', (t) => {
    expect(check('aws_s3', t)).toMatchObject({ isValid: true, relationshipType: 'TRIGGERS', protocol: 'S3 Event Notification', label: 'Trigger / Event' });
  });
  it('is the only exception: S3 still cannot open connections to other compute or databases', () => {
    for (const t of ['aws_ec2', 'aws_ecs', 'aws_eks', 'aws_auto_scaling']) expect(check('aws_s3', t)).toMatchObject({ isValid: false, error: { code: 'REVERSE_COMPUTE_CONNECTION' } });
    expect(check('aws_s3', 'aws_rds').isValid).toBe(true);        // unchanged: no rule either way, as before
  });
  it('the existing rules are untouched', () => {
    expect(check('aws_sqs', 'aws_lambda')).toMatchObject({ relationshipType: 'TRIGGERS', label: 'Trigger / Event' });
    expect(check('aws_lambda', 'aws_s3')).toMatchObject({ relationshipType: 'STORES_IN' });
    expect(check('aws_lambda', 'aws_sqs')).toMatchObject({ label: 'Enqueue Message' });
    expect(check('aws_iam', 'aws_lambda')).toMatchObject({ relationshipType: 'AUTHENTICATES_WITH' });
  });
});

describe('Azure: compute → Cosmos DB', () => {
  it.each(['azure_functions', 'azure_app_service', 'azure_vm', 'azure_vmss', 'azure_aks'])('%s → Cosmos DB is HTTPS/443', (src) => {
    expect(check(src, 'azure_cosmos_db')).toMatchObject({ isValid: true, relationshipType: 'CONNECTS_TO', protocol: 'HTTPS', port: 443, label: 'Cosmos DB / 443' });
  });
});

describe('a serverless data pipeline has no unclassified connection', () => {
  it('S3 → SQS → Lambda → DynamoDB, with the role and the alarms', () => {
    const pipeline: [string, string][] = [
      ['aws_s3', 'aws_sqs'], ['aws_sqs', 'aws_lambda'], ['aws_lambda', 'aws_dynamodb'], ['aws_lambda', 'aws_s3'],
      ['aws_iam', 'aws_lambda'], ['aws_cloudwatch', 'aws_lambda'], ['aws_cloudwatch', 'aws_dynamodb'],
    ];
    for (const [from, to] of pipeline) expect({ pair: `${from} → ${to}`, ok: classified(check(from, to)) }).toEqual({ pair: `${from} → ${to}`, ok: true });
  });

  it('the event-driven pattern in the knowledge base is fully classified, edge by edge', () => {
    const spec = awsEventDriven({ provider: 'aws', pattern: 'aws-event-driven', region: 'us-east-1', scale: 'medium', db: 'nosql', cache: false, cdn: false, regulated: false, queue: false, app: 'etl' } as Requirements);
    const type = new Map(spec.resources.map((r) => [r.id, r.type]));
    const unclassified = spec.connections.filter((c) => !classified(check(type.get(c.from)!, type.get(c.to)!))).map((c) => `${type.get(c.from)} → ${type.get(c.to)}`);
    expect(unclassified).toEqual([]);
  });
});

describe('a request for a data lake', () => {
  const unsupported = (prompt: string) => detectServiceNotices(prompt).unsupported.map((u) => u.service);
  it('says CloudBuilder cannot model one, and offers S3 as the closest thing', () => {
    const n = detectServiceNotices('Design a data lake on AWS for our analytics team, S3 for storage');
    const lake = n.unsupported.find((u) => /data lake/i.test(u.service));
    expect(lake).toBeDefined();
    expect(lake!.nearest.length).toBeGreaterThan(0);
    expect(describeNotices(n).join(' ')).toMatch(/data lake .* isn't supported by CloudBuilder yet — closest available/i);
  });
  it.each(['we need a datalake', 'a Data  Lake on S3', 'lake formation governed storage', 'build a DATA LAKE'])('is noticed in "%s"', (p) => {
    expect(unsupported(p).some((s) => /data lake/i.test(s))).toBe(true);
  });
  it('is not raised when the request excludes it, or does not mention it', () => {
    expect(unsupported('a web app on AWS, no data lake please').some((s) => /data lake/i.test(s))).toBe(false);
    expect(unsupported('an S3 bucket with a Lambda ETL job and DynamoDB').some((s) => /data lake/i.test(s))).toBe(false);
  });
  it('still reports Glue and Athena by name, alongside', () => {
    const names = unsupported('a data lake using Glue and Athena');
    expect(names).toEqual(expect.arrayContaining(['Glue', 'Athena']));
    expect(names.some((s) => /data lake/i.test(s))).toBe(true);
  });
});

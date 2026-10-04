import { renderToStaticMarkup } from 'react-dom/server';
import CreatedResourcesList, { createdResources, maybeCreatedResources, createdListText } from '@/components/panels/CreatedResourcesList';
import { newQueuedRecord, ApplyProgressTracker, type RunProgressRecord } from '@/lib/terraform/execution/applyProgress';

const PLANNED = [
  { address: 'aws_vpc.main', type: 'aws_vpc' }, { address: 'aws_subnet.a', type: 'aws_subnet' },
  { address: 'aws_db_instance.db', type: 'aws_db_instance' }, { address: 'aws_s3_bucket.logs', type: 'aws_s3_bucket' },
];

function record(output: string, status: RunProgressRecord['status'], finish?: boolean): RunProgressRecord {
  const t = new ApplyProgressTracker(PLANNED);
  t.feed(output);
  if (finish !== undefined) t.finish(finish);
  return { ...newQueuedRecord({ runId: 'run-1', orgId: 'o', projectId: 'p' }, PLANNED), status, ...t.snapshot() };
}

const FAILED_RUN = [
  'aws_vpc.main: Creating...', 'aws_vpc.main: Creation complete after 2s [id=vpc-0abc]',
  'aws_s3_bucket.logs: Creating...', 'aws_s3_bucket.logs: Creation complete after 1s [id=logs-bucket]',
  'aws_subnet.a: Creating...', '│ Error: InvalidSubnet.Range', '│   with aws_subnet.a,',
  'aws_db_instance.db: Creating...', 'aws_db_instance.db: Still creating... [30s elapsed]',
].join('\n') + '\n';

describe('what a run created', () => {
  test('lists what Terraform finished creating, with the provider ids', () => {
    const r = record(FAILED_RUN, 'failed', false);
    expect(createdResources(r).map((x) => [x.address, x.id])).toEqual([['aws_vpc.main', 'vpc-0abc'], ['aws_s3_bucket.logs', 'logs-bucket']]);
  });

  test('resources in progress or failed when the run stopped are listed separately as "may exist"', () => {
    const r = record(FAILED_RUN, 'failed', false);
    expect(maybeCreatedResources(r).map((x) => x.address).sort()).toEqual(['aws_db_instance.db', 'aws_subnet.a']);
  });

  test('resources that never started are in neither list', () => {
    const r = record('aws_vpc.main: Creating...\naws_vpc.main: Creation complete after 1s [id=v]\n', 'running');
    expect(createdResources(r)).toHaveLength(1);
    expect(maybeCreatedResources(r)).toEqual([]);
  });

  test('data source reads are not creations', () => {
    const r = record('data.aws_vpc.default: Read complete after 0s [id=vpc-default]\n', 'running');
    expect(createdResources(r)).toEqual([]);
  });

  test('the copyable list has addresses and ids, and the "may exist" section', () => {
    const text = createdListText(record(FAILED_RUN, 'failed', false));
    expect(text).toContain('aws_vpc.main  vpc-0abc');
    expect(text).toContain('aws_s3_bucket.logs  logs-bucket');
    expect(text).toMatch(/May exist:[\s\S]*aws_db_instance\.db/);
  });

  test('renders the ids and the way to remove them; renders nothing when nothing was created', () => {
    const html = renderToStaticMarkup(<CreatedResourcesList progress={record(FAILED_RUN, 'failed', false)} cloud="AWS" />);
    expect(html).toContain('vpc-0abc');
    expect(html).toContain('2 resources created in AWS');
    expect(html).toContain('1 may exist'.replace('1', '2'));
    expect(html).toContain('Teardown');
    expect(renderToStaticMarkup(<CreatedResourcesList progress={record('', 'queued')} cloud="AWS" />)).toBe('');
    expect(renderToStaticMarkup(<CreatedResourcesList progress={null} cloud="AWS" />)).toBe('');
  });
});

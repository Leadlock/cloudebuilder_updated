/**
 * Deleting a state bucket CloudBuilder made: only its own, only when its Terraform record is empty, every version removed, nothing deleted otherwise.
 */
import { deleteAwsStateBackend, StateBackendError } from '@/lib/terraform/execution/stateBackendProvisioner';

type Handler = (input: any) => unknown;   // eslint-disable-line @typescript-eslint/no-explicit-any
function fake(handlers: Record<string, Handler>) {
  const log: Array<{ name: string; input: any }> = [];   // eslint-disable-line @typescript-eslint/no-explicit-any
  return { log, s3: { send: async (command: unknown) => { const c = command as { constructor: { name: string }; input: unknown }; log.push({ name: c.constructor.name, input: c.input }); const h = handlers[c.constructor.name]; if (!h) throw new Error(`no handler for ${c.constructor.name}`); return h(c.input); } } };
}
const err = (name: string, status?: number) => Object.assign(new Error(name), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });
const B = 'cloudcraft-tfstate-123456789012-eu-north-1';
const TAGS = { TagSet: [{ Key: 'ManagedBy', Value: 'CloudCraft' }, { Key: 'Purpose', Value: 'terraform-state' }] };
const state = (resources: unknown[]) => ({ Body: { transformToString: async () => JSON.stringify({ version: 4, resources }) } });
const base = (over: Record<string, Handler> = {}) => fake({
  HeadBucketCommand: () => ({}), GetBucketTaggingCommand: () => TAGS,
  ListObjectVersionsCommand: () => ({ Versions: [{ Key: 'cloudcraft/releases/x.tfstate', VersionId: 'v2', IsLatest: true, Size: 100 }, { Key: 'cloudcraft/releases/x.tfstate', VersionId: 'v1', IsLatest: false }], DeleteMarkers: [{ Key: 'old', VersionId: 'm1' }], IsTruncated: false }),
  GetObjectCommand: () => state([]), DeleteObjectsCommand: () => ({}), DeleteBucketCommand: () => ({}), ...over,
});

describe('deleting a state bucket', () => {
  test('removes every version and delete marker, then the bucket', async () => {
    const t = base();
    const r = await deleteAwsStateBackend({ bucket: B }, { s3: t.s3 });
    expect(r).toMatchObject({ bucket: B, deletedObjects: 3, steps: [{ outcome: 'deleted' }] });
    expect(t.log.find((l) => l.name === 'DeleteObjectsCommand')!.input.Delete.Objects).toEqual([
      { Key: 'cloudcraft/releases/x.tfstate', VersionId: 'v2' }, { Key: 'cloudcraft/releases/x.tfstate', VersionId: 'v1' }, { Key: 'old', VersionId: 'm1' },
    ]);
    expect(t.log.at(-1)!.name).toBe('DeleteBucketCommand');
  });

  test('a bucket that is already gone is a success and nothing else is called', async () => {
    const t = base({ HeadBucketCommand: () => { throw err('NotFound', 404); } });
    expect(await deleteAwsStateBackend({ bucket: B }, { s3: t.s3 })).toMatchObject({ deletedObjects: 0, steps: [{ outcome: 'already-gone' }] });
    expect(t.log.map((l) => l.name)).toEqual(['HeadBucketCommand']);
  });

  test('a name that is not CloudBuilder\'s, or not a bucket name, is refused before any request', async () => {
    const t = base();
    for (const bad of ['my-company-data', 'cloudcraft-tfstate-', 'CLOUDCRAFT-tfstate-x', 'cloudcraft-tfstate-../x']) await expect(deleteAwsStateBackend({ bucket: bad }, { s3: t.s3 })).rejects.toThrow(StateBackendError);
    expect(t.log).toHaveLength(0);
  });

  test('a bucket without CloudBuilder\'s tags is never deleted, even with the right prefix', async () => {
    for (const tags of [{ TagSet: [] }, { TagSet: [{ Key: 'ManagedBy', Value: 'someone' }, { Key: 'Purpose', Value: 'terraform-state' }] }]) {
      const t = base({ GetBucketTaggingCommand: () => tags });
      await expect(deleteAwsStateBackend({ bucket: B }, { s3: t.s3 })).rejects.toThrow(/was not created by CloudBuilder/);
      expect(t.log.some((l) => /Delete/.test(l.name))).toBe(false);
    }
    const untagged = base({ GetBucketTaggingCommand: () => { throw err('NoSuchTagSet', 404); } });
    await expect(deleteAwsStateBackend({ bucket: B }, { s3: untagged.s3 })).rejects.toThrow(/was not created by CloudBuilder/);
  });

  test('state that still records resources blocks it, says which, and deletes nothing', async () => {
    const t = base({ GetObjectCommand: () => state([{ type: 'aws_instance' }, { type: 'aws_s3_bucket' }]) });
    await expect(deleteAwsStateBackend({ bucket: B }, { s3: t.s3 })).rejects.toThrow(/x\.tfstate \(2 resources\).*Remove everything/);
    expect(t.log.some((l) => /Delete/.test(l.name))).toBe(false);
  });

  test('state that cannot be read, or is huge, is not assumed empty', async () => {
    const bad = base({ GetObjectCommand: () => ({ Body: { transformToString: async () => 'not json' } }) });
    await expect(deleteAwsStateBackend({ bucket: B }, { s3: bad.s3 })).rejects.toThrow(/still lists/);
    const big = base({ ListObjectVersionsCommand: () => ({ Versions: [{ Key: 'a.tfstate', VersionId: 'v', IsLatest: true, Size: 50 * 1024 * 1024 }], IsTruncated: false }) });
    await expect(deleteAwsStateBackend({ bucket: B }, { s3: big.s3 })).rejects.toThrow(/too large to check/);
  });

  test('a long listing is followed to the end, and deleted a thousand at a time', async () => {
    let page = 0;
    const t = base({ ListObjectVersionsCommand: () => (++page === 1
      ? { Versions: Array.from({ length: 1000 }, (_, i) => ({ Key: `k${i}`, VersionId: 'v' })), IsTruncated: true, NextKeyMarker: 'k999', NextVersionIdMarker: 'v' }
      : { Versions: [{ Key: 'last', VersionId: 'v' }], IsTruncated: false }) });
    const r = await deleteAwsStateBackend({ bucket: B }, { s3: t.s3 });
    expect(r.deletedObjects).toBe(1001);
    expect(t.log.filter((l) => l.name === 'DeleteObjectsCommand').map((l) => l.input.Delete.Objects.length)).toEqual([1000, 1]);
    expect(t.log.find((l) => l.name === 'ListObjectVersionsCommand' && l.input.KeyMarker)!.input).toMatchObject({ KeyMarker: 'k999', VersionIdMarker: 'v' });
  });

  test('a role that may not delete is told what to do, and nothing is half-hidden', async () => {
    const t = base({ DeleteObjectsCommand: () => { throw err('AccessDenied', 403); } });
    await expect(deleteAwsStateBackend({ bucket: B }, { s3: t.s3 })).rejects.toThrow(/cannot delete a bucket on purpose/);
    const noTags = base({ GetBucketTaggingCommand: () => { throw err('AccessDenied', 403); } });
    await expect(deleteAwsStateBackend({ bucket: B }, { s3: noTags.s3 })).rejects.toThrow(/s3:GetBucketTagging/);
  });
});

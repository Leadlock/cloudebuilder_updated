/**
 * What a release does in AWS that is not Terraform: store a secret in Parameter Store, build an image inside the account (CodeBuild), put the compose
 * file and tag where the server reads them (the release bucket), restart the service on the instance (Systems Manager) and look at the public address.
 * The official AWS SDK clients are used; they are injected, so every step is tested with fakes.
 *
 * Nothing here logs a secret value, a credential or a source archive.
 */
import { randomUUID } from 'crypto';
import { GetParameterCommand, GetCommandInvocationCommand, PutParameterCommand, SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm';
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { DeleteObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface AwsOps {
  /** `path` is the whole name in Parameter Store, for example /shop/JWT_SECRET. */
  secretExists(path: string): Promise<boolean>;
  putSecret(path: string, value: string): Promise<void>;
  /** Builds `image` (registry/name:tag) from the zip inside the account and pushes it. Resolves when it succeeded; throws with what failed otherwise. */
  buildImage(a: { codebuildProject: string; sourceBucket: string; registry: string; image: string; zip: Buffer; onLog?: (line: string) => void }): Promise<void>;
  /** Writes compose.yml and release.env (the tag) to the release bucket: what the server reads every time it starts. */
  putReleaseFiles(bucket: string, a: { compose: string; tag: string }): Promise<void>;
  /** Restarts <project>.service on the instance. */
  restartService(instanceId: string, project: string): Promise<void>;
  /** Whether the bucket is still there (a finished teardown leaves none). */
  bucketExists(bucket: string): Promise<boolean>;
  httpOk(url: string): Promise<boolean>;
}

export class AwsError extends Error {
  constructor(message: string) { super(message); this.name = 'AwsError'; }
}

/** The part of an SDK client these operations use: tests give a fake. */
export interface Sender { send(command: unknown): Promise<unknown> }
export interface AwsClients { ssm: Sender; s3: Sender; codebuild: Sender }

export interface AwsOpsDeps {
  clients: AwsClients;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  buildTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** How long a command is retried while the instance has not yet shown up in Systems Manager (a new instance takes a few minutes). */
  instanceWaitMs?: number;
  fetchImpl?: typeof fetch;
}

const SECRET_PATH = /^\/[a-z0-9][a-z0-9_-]{0,40}\/[A-Z][A-Z0-9_]{0,63}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const INSTANCE = /^i-[0-9a-f]{8,17}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const CB_PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/;
const IMAGE = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const REGISTRY = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errName = (e: unknown) => (e as { name?: string } | null)?.name ?? '';
const short = (e: unknown) => {
  const x = e as { name?: string; message?: string } | null;
  return `${x?.name ? `${x.name}: ` : ''}${String(x?.message ?? e).slice(0, 300)}`;
};

export function createAwsOps(deps: AwsOpsDeps): AwsOps {
  const { ssm, s3, codebuild } = deps.clients;
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 5000;
  const f = deps.fetchImpl ?? fetch;

  return {
    async secretExists(path) {
      if (!SECRET_PATH.test(path)) throw new AwsError('The secret name is not valid.');
      try { await ssm.send(new GetParameterCommand({ Name: path, WithDecryption: false })); return true; }
      catch (e) { if (errName(e) === 'ParameterNotFound') return false; throw new AwsError(`Could not read secret ${path}: ${short(e)}`); }
    },

    async putSecret(path, value) {
      if (!SECRET_PATH.test(path)) throw new AwsError('The secret name is not valid.');
      try { await ssm.send(new PutParameterCommand({ Name: path, Value: value, Type: 'SecureString', Overwrite: false })); }
      catch (e) {
        if (errName(e) === 'ParameterAlreadyExists') return;           // stored in the meantime: the same outcome
        throw new AwsError(`Could not store secret ${path}: ${short(e)}${errName(e) === 'AccessDeniedException' ? ' (the account\'s role needs ssm:PutParameter on it)' : ''}`);
      }
    },

    async buildImage({ codebuildProject, sourceBucket, registry, image, zip, onLog }) {
      if (!CB_PROJECT.test(codebuildProject) || !BUCKET.test(sourceBucket) || !REGISTRY.test(registry) || !IMAGE.test(image)) throw new AwsError('The build project, bucket, registry or image name is not valid.');
      const key = `src/${randomUUID()}.zip`;
      try { await s3.send(new PutObjectCommand({ Bucket: sourceBucket, Key: key, Body: zip, ServerSideEncryption: 'AES256', ContentType: 'application/zip' })); }
      catch (e) { throw new AwsError(`Could not upload the source for ${image}: ${short(e)}`); }
      try {
        let id: string | undefined;
        try {
          const started = await codebuild.send(new StartBuildCommand({
            projectName: codebuildProject, sourceTypeOverride: 'S3', sourceLocationOverride: `${sourceBucket}/${key}`,
            environmentVariablesOverride: [{ name: 'REGISTRY', value: registry, type: 'PLAINTEXT' }, { name: 'IMAGE', value: image, type: 'PLAINTEXT' }],
          })) as { build?: { id?: string } };
          id = started.build?.id;
        } catch (e) { throw new AwsError(`Could not start the build of ${image}: ${short(e)}`); }
        if (!id) throw new AwsError(`The build of ${image} started but AWS did not name it.`);

        const started = Date.now();
        for (;;) {
          const r = await codebuild.send(new BatchGetBuildsCommand({ ids: [id] })) as { builds?: Array<{ buildStatus?: string; currentPhase?: string; phases?: Array<{ phaseType?: string; phaseStatus?: string; contexts?: Array<{ message?: string }> }> }> };
          const b = r.builds?.[0];
          if (!b) throw new AwsError(`AWS has no record of the build of ${image}.`);
          if (b.buildStatus === 'SUCCEEDED') { onLog?.(`${image}: built and pushed`); return; }
          if (b.buildStatus && b.buildStatus !== 'IN_PROGRESS') {
            const why = (b.phases ?? []).filter((p) => p.phaseStatus && p.phaseStatus !== 'SUCCEEDED' && p.phaseStatus !== 'IN_PROGRESS').map((p) => `${p.phaseType}: ${(p.contexts ?? []).map((c) => c.message).filter(Boolean).join('; ') || p.phaseStatus}`).join(' | ');
            throw new AwsError(`The build of ${image} ${b.buildStatus.toLowerCase().replace(/_/g, ' ')}.${why ? ` ${why.slice(0, 600)}` : ''}`);
          }
          if (Date.now() - started > (deps.buildTimeoutMs ?? 30 * 60_000)) throw new AwsError(`The build of ${image} did not finish in time.`);
          onLog?.(`${image}: ${(b.currentPhase ?? 'working').toLowerCase().replace(/_/g, ' ')}…`);
          await sleep(pollMs);
        }
      } finally {
        await s3.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: key })).catch(() => undefined);     // the archive is only needed while it builds
      }
    },

    async putReleaseFiles(bucket, { compose, tag }) {
      if (!BUCKET.test(bucket)) throw new AwsError('The bucket name is not valid.');
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new AwsError('The image tag is not valid.');
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'compose.yml', Body: compose, ServerSideEncryption: 'AES256', ContentType: 'text/yaml' }));
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'release.env', Body: `TAG=${tag}\n`, ServerSideEncryption: 'AES256', ContentType: 'text/plain' }));
      } catch (e) { throw new AwsError(`Could not put the release on the server's bucket: ${short(e)}`); }
    },

    async restartService(instanceId, project) {
      if (!INSTANCE.test(instanceId) || !PROJECT.test(project)) throw new AwsError('The instance or project name is not valid.');
      const waitUntil = Date.now() + (deps.instanceWaitMs ?? 8 * 60_000);
      let commandId: string | undefined;
      for (;;) {
        try {
          const sent = await ssm.send(new SendCommandCommand({ InstanceIds: [instanceId], DocumentName: 'AWS-RunShellScript', Parameters: { commands: [`systemctl restart ${project}.service`] }, TimeoutSeconds: 120 })) as { Command?: { CommandId?: string } };
          commandId = sent.Command?.CommandId;
          break;
        } catch (e) {
          // A new instance is not known to Systems Manager for the first few minutes.
          if (errName(e) === 'InvalidInstanceId' && Date.now() < waitUntil) { await sleep(pollMs); continue; }
          throw new AwsError(`Could not send the command to the instance: ${short(e)}${errName(e) === 'InvalidInstanceId' ? ' (it is not reachable by Systems Manager yet)' : ''}`);
        }
      }
      if (!commandId) throw new AwsError('AWS accepted the command but did not name it.');
      const started = Date.now();
      for (;;) {
        await sleep(pollMs);
        try {
          const r = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId })) as { Status?: string; StandardErrorContent?: string };
          if (r.Status === 'Success') return;
          if (r.Status && ['Failed', 'Cancelled', 'TimedOut', 'Cancelling'].includes(r.Status)) throw new AwsError(`The restart failed on the instance (${r.Status.toLowerCase()}): ${(r.StandardErrorContent ?? '').slice(-300)}`);
        } catch (e) {
          if (e instanceof AwsError) throw e;
          if (errName(e) !== 'InvocationDoesNotExist') throw new AwsError(`Could not read the result of the restart: ${short(e)}`);      // right after sending, it may not exist yet
        }
        if (Date.now() - started > (deps.commandTimeoutMs ?? 5 * 60_000)) throw new AwsError('The restart did not finish in time.');
      }
    },

    async bucketExists(bucket) {
      if (!BUCKET.test(bucket)) throw new AwsError('The bucket name is not valid.');
      try { await s3.send(new HeadBucketCommand({ Bucket: bucket })); return true; }
      catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
        if (errName(e) === 'NotFound' || errName(e) === 'NoSuchBucket' || status === 404) return false;
        throw new AwsError(`Could not look for the bucket: ${short(e)}`);       // 403 and the like: not an answer
      }
    },

    async httpOk(url) {
      try { return (await f(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' })).ok; } catch { return false; }
    },
  };
}

/** Real clients for a region, signing with credentials looked up each time they are needed (so a long release outlives one set of temporary credentials). */
export function createAwsClients(region: string, credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>): AwsClients {
  const cfg = { region, credentials };
  return { ssm: new SSMClient(cfg), s3: new S3Client(cfg), codebuild: new CodeBuildClient(cfg) };
}

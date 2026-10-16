/**
 * What a release does on ECS Fargate that is not Terraform: point each service's task definition at the new images, start the services and wait until
 * they are steady, and look whether the cluster is still there. Secrets, image builds and the address check are the AWS operations in awsOps.ts.
 * The official AWS SDK client is injected, so every step is tested with fakes.
 */
import {
  DescribeClustersCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, RegisterTaskDefinitionCommand, UpdateServiceCommand,
  type ContainerDefinition,
} from '@aws-sdk/client-ecs';
import { AwsError, type Sender } from './awsOps';

export interface EcsOps {
  /** Registers a new revision of each service's task definition that runs `<registry>/<project>-<service>:<tag>` (a service with a ready-made image keeps it). */
  setImageTag(a: { project: string; services: string[]; registry: string; tag: string }): Promise<void>;
  /** Points each service at its newest task definition and gives it `desiredCount` tasks, then waits until every service has finished rolling out. */
  startServices(a: { cluster: string; project: string; services: string[]; desiredCount: number; onLog?: (line: string) => void }): Promise<void>;
  clusterExists(cluster: string): Promise<boolean>;
}

export interface EcsOpsDeps {
  ecs: Sender;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  rolloutTimeoutMs?: number;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SERVICE = /^[a-z][a-z0-9-]{0,30}$/;
const REGISTRY = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (e: unknown) => {
  const x = e as { name?: string; message?: string } | null;
  return `${x?.name ? `${x.name}: ` : ''}${String(x?.message ?? e).slice(0, 300)}`;
};

interface ServiceView {
  serviceName?: string; desiredCount?: number; runningCount?: number;
  deployments?: Array<{ status?: string; rolloutState?: string; rolloutStateReason?: string }>;
}

export function createEcsOps(deps: EcsOpsDeps): EcsOps {
  const { ecs } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 10_000;

  return {
    async setImageTag({ project, services, registry, tag }) {
      if (!NAME.test(project) || !REGISTRY.test(registry) || !TAG.test(tag) || !services.every((s) => SERVICE.test(s))) throw new AwsError('The project, registry, services or tag are not valid.');
      for (const service of services) {
        const family = `${project}-${service}`;
        let current: { taskDefinition?: Record<string, unknown> };
        try { current = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: family })) as typeof current; }
        catch (e) { throw new AwsError(`Could not read the task definition of ${service}: ${short(e)}`); }
        const t = current.taskDefinition as {
          taskRoleArn?: string; executionRoleArn?: string; networkMode?: 'awsvpc'; containerDefinitions?: ContainerDefinition[]; cpu?: string; memory?: string;
          requiresCompatibilities?: Array<'FARGATE'>; runtimePlatform?: { operatingSystemFamily?: 'LINUX'; cpuArchitecture?: 'X86_64' };
        } | undefined;
        if (!t?.containerDefinitions?.length) throw new AwsError(`The task definition of ${service} has no container.`);
        const prefix = `${registry}/${project}-`;
        // Only the images this project's builds produced change; a ready-made image stays as it was.
        const containerDefinitions = t.containerDefinitions.map((c) => (c.image?.startsWith(prefix) ? { ...c, image: `${prefix}${service}:${tag}` } : c));
        try {
          await ecs.send(new RegisterTaskDefinitionCommand({
            family, taskRoleArn: t.taskRoleArn, executionRoleArn: t.executionRoleArn, networkMode: t.networkMode, containerDefinitions, cpu: t.cpu, memory: t.memory,
            requiresCompatibilities: t.requiresCompatibilities, runtimePlatform: t.runtimePlatform,
          }));
        } catch (e) { throw new AwsError(`Could not register the new task definition of ${service}: ${short(e)}`); }
      }
    },

    async startServices({ cluster, project, services, desiredCount, onLog }) {
      if (!NAME.test(cluster) || !NAME.test(project) || !services.every((s) => SERVICE.test(s)) || !Number.isInteger(desiredCount) || desiredCount < 1 || desiredCount > 20) throw new AwsError('The cluster, services or task count are not valid.');
      for (const service of services) {
        try { await ecs.send(new UpdateServiceCommand({ cluster, service, taskDefinition: `${project}-${service}`, desiredCount, forceNewDeployment: true })); }
        catch (e) { throw new AwsError(`Could not start ${service}: ${short(e)}`); }
      }
      const started = Date.now();
      const timeout = deps.rolloutTimeoutMs ?? 20 * 60_000;
      let last = '';
      for (;;) {
        let r: { services?: ServiceView[] };
        try { r = await ecs.send(new DescribeServicesCommand({ cluster, services })) as typeof r; }
        catch (e) { throw new AwsError(`Could not read the services: ${short(e)}`); }
        const views = r.services ?? [];
        const failed = views.find((v) => v.deployments?.some((d) => d.status === 'PRIMARY' && d.rolloutState === 'FAILED'));
        if (failed) {
          const reason = failed.deployments?.find((d) => d.status === 'PRIMARY')?.rolloutStateReason ?? 'no reason given';
          throw new AwsError(`${failed.serviceName} did not start: ${reason.slice(0, 300)}`);
        }
        const done = views.length === services.length && views.every((v) => v.deployments?.length === 1 && v.deployments[0]!.rolloutState === 'COMPLETED' && v.runningCount === v.desiredCount && (v.desiredCount ?? 0) > 0);
        const line = views.map((v) => `${v.serviceName} ${v.runningCount ?? 0}/${v.desiredCount ?? 0}`).join(', ');
        if (line !== last) { last = line; onLog?.(line); }
        if (done) return;
        if (Date.now() - started > timeout) throw new AwsError(`The services did not become steady in time (${line}).`);
        await sleep(pollMs);
      }
    },

    async clusterExists(cluster) {
      if (!NAME.test(cluster)) throw new AwsError('The cluster name is not valid.');
      try {
        const r = await ecs.send(new DescribeClustersCommand({ clusters: [cluster] })) as { clusters?: Array<{ status?: string }>; failures?: Array<{ reason?: string }> };
        return (r.clusters ?? []).some((c) => c.status === 'ACTIVE' || c.status === 'PROVISIONING');
      } catch (e) { throw new AwsError(`Could not look for the cluster: ${short(e)}`); }
    },
  };
}

export const createEcsClient = (region: string, credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>): Sender => new ECSClient({ region, credentials });

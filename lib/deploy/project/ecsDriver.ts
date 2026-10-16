/**
 * The ECS Fargate driver of a release: Parameter Store for secrets, CodeBuild for images (both from awsOps.ts), and ECS itself for the release: a new
 * task definition revision per service, then the services started on it. See driver.ts for what a driver is.
 */
import { buildSourceZip } from './zipWriter';
import type { ReleaseDriver } from './driver';
import type { AwsOps } from './awsOps';
import type { EcsOps } from './ecsOps';
import { isEcsOutputs, type EcsOutputs, type ReleaseOutputs } from './types';

const ecsOf = (o: ReleaseOutputs): EcsOutputs => {
  if (!isEcsOutputs(o)) throw new Error('These are not the outputs of an ECS deployment.');
  return o;
};

export function ecsDriver(aws: AwsOps, ecs: EcsOps): ReleaseDriver {
  return {
    secretExists: (o, name) => aws.secretExists(`${ecsOf(o).ssmPrefix}/${name}`),
    putSecret: (o, name, value) => aws.putSecret(`${ecsOf(o).ssmPrefix}/${name}`, value),
    build: (o, a) => aws.buildImage({
      codebuildProject: ecsOf(o).codebuildProject, sourceBucket: ecsOf(o).sourceBucket, registry: ecsOf(o).registry,
      image: `${ecsOf(o).registry}/${a.project}-${a.layer}:${a.tag}`, zip: buildSourceZip(a.files), onLog: a.onLog,
    }),
    // Nothing runs the new images yet: this only makes the task definitions say which images to run.
    publish: (o, a) => ecs.setImageTag({ project: a.project, services: ecsOf(o).services, registry: ecsOf(o).registry, tag: a.tag }),
    start: (o, a) => ecs.startServices({ cluster: ecsOf(o).cluster, project: a.project, services: ecsOf(o).services, desiredCount: ecsOf(o).desiredCount }),
    exists: (o) => ecs.clusterExists(ecsOf(o).cluster),
    same: (a, b) => isEcsOutputs(a) && isEcsOutputs(b) && a.cluster === b.cluster && a.region === b.region,
    describe: (o) => `the cluster ${ecsOf(o).cluster} in ${ecsOf(o).region}`,
    httpOk: (url) => aws.httpOk(url),
  };
}

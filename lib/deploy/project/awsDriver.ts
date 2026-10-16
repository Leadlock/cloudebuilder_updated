/**
 * The AWS driver of a release: Parameter Store for secrets, CodeBuild for images, the release bucket for the compose file and tag, Systems Manager to
 * restart. See driver.ts for what a driver is.
 */
import { buildSourceZip } from './zipWriter';
import type { ReleaseDriver } from './driver';
import type { AwsOps } from './awsOps';
import { isAwsOutputs, type AwsOutputs, type ReleaseOutputs } from './types';

const aws = (o: ReleaseOutputs): AwsOutputs => {
  if (!isAwsOutputs(o)) throw new Error('These are the outputs of an Azure deployment, not an AWS one.');
  return o;
};

export function awsDriver(ops: AwsOps): ReleaseDriver {
  return {
    secretExists: (o, name) => ops.secretExists(`${aws(o).ssmPrefix}/${name}`),
    putSecret: (o, name, value) => ops.putSecret(`${aws(o).ssmPrefix}/${name}`, value),
    build: (o, a) => ops.buildImage({
      codebuildProject: aws(o).codebuildProject, sourceBucket: aws(o).sourceBucket, registry: aws(o).registry,
      image: `${aws(o).registry}/${a.project}-${a.layer}:${a.tag}`, zip: buildSourceZip(a.files), onLog: a.onLog,
    }),
    // The server reads both files every time it starts, so this is all a release needs to put on it.
    publish: (o, a) => ops.putReleaseFiles(aws(o).releaseBucket, { compose: a.compose, tag: a.tag }),
    start: (o, a) => ops.restartService(aws(o).instanceId, a.project),
    exists: (o) => ops.bucketExists(aws(o).releaseBucket),
    same: (a, b) => isAwsOutputs(a) && isAwsOutputs(b) && a.releaseBucket === b.releaseBucket,
    describe: (o) => `the server ${aws(o).instanceId} in ${aws(o).region}`,
    httpOk: (url) => ops.httpOk(url),
  };
}

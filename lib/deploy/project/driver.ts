/**
 * What a release does in a cloud that is not Terraform, behind one interface, so the steps (and their tests) are the same for every target:
 * store and look for a secret, build an image inside the cloud, put the release on the server, start it, and look at the public address.
 * Azure's is below; AWS's is in awsDriver.ts.
 */
import { buildTar } from './tar';
import { vaultName, type AzureOps } from './azureOps';
import { isAzureOutputs, type AzureOutputs, type ReleaseOutputs } from './types';

export interface ArchiveFile { path: string; content: string | Buffer }

export interface ReleaseDriver {
  secretExists(o: ReleaseOutputs, name: string): Promise<boolean>;
  /** Stores a secret straight in the cloud's secret store. The value is not kept. */
  putSecret(o: ReleaseOutputs, name: string, value: string): Promise<void>;
  /** Builds `<project>-<layer>:<tag>` from the files inside the cloud's own registry and pushes it. */
  build(o: ReleaseOutputs, a: { project: string; layer: string; tag: string; files: ArchiveFile[]; onLog?: (line: string) => void }): Promise<void>;
  /** Puts the image tag and the compose file where the server reads them. */
  publish(o: ReleaseOutputs, a: { project: string; tag: string; compose: string; built: string[] }): Promise<void>;
  /** Restarts the services on the server. */
  start(o: ReleaseOutputs, a: { project: string }): Promise<void>;
  /** Whether what the release created is still there (a finished teardown leaves nothing). */
  exists(o: ReleaseOutputs): Promise<boolean>;
  /** Whether two releases ran in the same deployment (so one teardown marks them all). */
  same(a: ReleaseOutputs, b: ReleaseOutputs): boolean;
  /** A few words for the progress line: what was created. */
  describe(o: ReleaseOutputs): string;
  httpOk(url: string): Promise<boolean>;
}

/** The commands that put a compose file on a VM: written beside the old one and moved over it, so a start never reads half a file. */
export function writeComposeScript(project: string, compose: string): string {
  const b64 = Buffer.from(compose, 'utf8').toString('base64');
  return `mkdir -p /opt/${project} && printf '%s' '${b64}' | base64 -d > /opt/${project}/compose.yml.new && mv /opt/${project}/compose.yml.new /opt/${project}/compose.yml`;
}

const az = (o: ReleaseOutputs): AzureOutputs => {
  if (!isAzureOutputs(o)) throw new Error('These are the outputs of an AWS deployment, not an Azure one.');
  return o;
};

/** The Azure driver: Key Vault, the registry's own build, the VM's tags and run command. */
export function azureDriver(ops: AzureOps): ReleaseDriver {
  return {
    secretExists: (o, name) => ops.secretExists(az(o).vaultName, vaultName(name)),
    putSecret: (o, name, value) => ops.putSecret(az(o).vaultName, vaultName(name), value),
    build: (o, a) => ops.acrBuild({ resourceGroup: az(o).resourceGroup, registry: az(o).acrName, image: `${a.project}-${a.layer}:${a.tag}`, source: buildTar(a.files), onLog: a.onLog }),
    async publish(o, a) {
      await ops.setVmTag(az(o).resourceGroup, az(o).vmName, 'image_tag', a.tag);
      await ops.runShell(az(o).resourceGroup, az(o).vmName, writeComposeScript(a.project, a.compose));
    },
    async start(o, a) { await ops.runShell(az(o).resourceGroup, az(o).vmName, `systemctl restart ${a.project}.service`); },
    exists: (o) => ops.resourceGroupExists(az(o).resourceGroup),
    same: (a, b) => isAzureOutputs(a) && isAzureOutputs(b) && a.resourceGroup === b.resourceGroup,
    describe: (o) => az(o).resourceGroup,
    httpOk: (url) => ops.httpOk(url),
  };
}

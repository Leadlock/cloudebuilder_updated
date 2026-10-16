/**
 * The Azure Container Apps driver of a release: Key Vault for secrets, the registry's own build for images (both from azureOps.ts), and the Container
 * Apps themselves for the release: each built app is pointed at the new image (a new revision), then every app is scaled up and awaited.
 * See driver.ts for what a driver is.
 */
import { buildTar } from './tar';
import { vaultName, type AcaOps, type AzureOps } from './azureOps';
import { acaAppName } from '@/lib/engines/containers/stackAcaDeploy';
import type { ReleaseDriver } from './driver';
import { isAcaOutputs, type AcaOutputs, type ReleaseOutputs } from './types';

const acaOf = (o: ReleaseOutputs): AcaOutputs => {
  if (!isAcaOutputs(o)) throw new Error('These are not the outputs of a Container Apps deployment.');
  return o;
};

export function acaDriver(ops: AzureOps & AcaOps): ReleaseDriver {
  return {
    // A secret that is only the marker Terraform left is not stored yet.
    secretExists: (o, name) => ops.secretHasValue(acaOf(o).vaultName, vaultName(name)),
    putSecret: (o, name, value) => ops.putSecret(acaOf(o).vaultName, vaultName(name), value),
    build: (o, a) => ops.acrBuild({ resourceGroup: acaOf(o).resourceGroup, registry: acaOf(o).acrName, image: `${a.project}-${a.layer}:${a.tag}`, source: buildTar(a.files), onLog: a.onLog }),
    async publish(o, a) {
      const x = acaOf(o);
      // Only the services that are built change image; a ready-made one keeps its own.
      for (const layer of a.built) {
        await ops.containerAppSetImage({ resourceGroup: x.resourceGroup, app: acaAppName(a.project, layer), image: `${x.acrName}.azurecr.io/${a.project}-${layer}:${a.tag}` });
      }
    },
    async start(o) {
      const x = acaOf(o);
      for (const app of x.apps) await ops.containerAppStart({ resourceGroup: x.resourceGroup, app, minReplicas: x.minReplicas });
    },
    exists: (o) => ops.resourceGroupExists(acaOf(o).resourceGroup),
    same: (a, b) => isAcaOutputs(a) && isAcaOutputs(b) && a.resourceGroup === b.resourceGroup,
    describe: (o) => `the resource group ${acaOf(o).resourceGroup}`,
    httpOk: (url) => ops.httpOk(url),
  };
}

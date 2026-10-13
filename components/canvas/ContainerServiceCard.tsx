'use client';
/**
 * Shown at the top of the properties panel for a node that Container Templates can fill in (Docker on EC2, Docker on an Azure VM, Azure
 * Container Apps): what is wrong with its settings, and a way to open that configuration in Container Templates to get the Dockerfile,
 * the compose file and the deploy files.
 */
import clsx from 'clsx';
import { Package, AlertTriangle } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { AZURE_CONTAINER_SERVICE_TYPE, CONTAINER_APPS_TYPE, containerConfigForNode, nodeProblemsFor } from '@/lib/engines/containers/nodeConfig';
import { sendToContainerTemplates } from '@/components/panels/containerHandoff';

const BLURB: Record<string, { title: string; text: string }> = {
  aws_container_service: { title: 'Docker on EC2', text: 'Terraform creates the server, the image repository and the access it needs. Container Templates builds the Dockerfile, the compose file and the workflow that deploys to it.' },
  [AZURE_CONTAINER_SERVICE_TYPE]: { title: 'Docker on an Azure VM', text: 'Terraform creates the VM, a container registry, a Key Vault and the identity that reads them. Container Templates builds the Dockerfile, the compose file and the workflow that deploys to it.' },
  [CONTAINER_APPS_TYPE]: { title: 'Azure Container Apps', text: 'Container Templates builds the Dockerfile and the deploy files for this app (it can also build the image in Azure). Set the Container Image above to the registry address it prints.' },
};

export default function ContainerServiceCard({ nodeId, resourceType, config, isLight }: { nodeId: string; resourceType: string; config: Record<string, unknown>; isLight: boolean }) {
  const { dispatch } = useApp();
  const blurb = BLURB[resourceType];
  if (!blurb) return null;
  const problems = resourceType === CONTAINER_APPS_TYPE ? [] : nodeProblemsFor(resourceType, config);
  return (
    <div className={clsx('p-3 rounded-xl border space-y-2', isLight ? 'bg-white border-slate-200' : 'bg-slate-950/80 border-slate-800')} data-testid="container-service-card">
      <div className="flex items-center gap-2">
        <Package className="w-4 h-4 text-cyan-500" />
        <span className={clsx('text-xs font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{blurb.title}</span>
      </div>
      <p className={clsx('text-[11px]', isLight ? 'text-slate-600' : 'text-slate-400')}>{blurb.text}</p>
      {problems.length > 0 && (
        <ul role="alert" className="text-[11px] text-rose-500 space-y-0.5">
          {problems.map((p) => <li key={p} className="flex gap-1.5"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{p}</li>)}
        </ul>
      )}
      <button type="button" onClick={() => { sendToContainerTemplates(containerConfigForNode(resourceType, config), nodeId); dispatch({ type: 'SET_VIEW', view: 'container-templates' }); }}
        className="w-full text-xs font-medium px-3 py-1.5 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500">
        Open in Container Templates
      </button>
    </div>
  );
}

'use client';
/**
 * Shown at the top of the properties panel for a Container service node: what is wrong with its settings, the findings Container Templates
 * would report for the same configuration, and a way to open that configuration in Container Templates to get the Dockerfile and deploy files.
 */
import clsx from 'clsx';
import { Package, AlertTriangle } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { containerConfigFromNode, nodeProblems } from '@/lib/engines/containers/nodeConfig';
import { sendToContainerTemplates } from '@/components/panels/containerHandoff';

export default function ContainerServiceCard({ nodeId, config, isLight }: { nodeId: string; config: Record<string, unknown>; isLight: boolean }) {
  const { dispatch } = useApp();
  const problems = nodeProblems(config);
  return (
    <div className={clsx('p-3 rounded-xl border space-y-2', isLight ? 'bg-white border-slate-200' : 'bg-slate-950/80 border-slate-800')} data-testid="container-service-card">
      <div className="flex items-center gap-2">
        <Package className="w-4 h-4 text-cyan-500" />
        <span className={clsx('text-xs font-semibold', isLight ? 'text-slate-900' : 'text-white')}>Docker on EC2</span>
      </div>
      <p className={clsx('text-[11px]', isLight ? 'text-slate-600' : 'text-slate-400')}>
        Terraform creates the server, the image repository and the access it needs. Container Templates builds the Dockerfile, the compose file and the workflow that deploys to it.
      </p>
      {problems.length > 0 && (
        <ul role="alert" className="text-[11px] text-rose-500 space-y-0.5">
          {problems.map((p) => <li key={p} className="flex gap-1.5"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{p}</li>)}
        </ul>
      )}
      <button type="button" onClick={() => { sendToContainerTemplates(containerConfigFromNode(config), nodeId); dispatch({ type: 'SET_VIEW', view: 'container-templates' }); }}
        className="w-full text-xs font-medium px-3 py-1.5 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500">
        Open in Container Templates
      </button>
    </div>
  );
}

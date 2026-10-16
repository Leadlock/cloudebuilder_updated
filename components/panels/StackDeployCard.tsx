'use client';
/**
 * Where a project of several services is deployed: nowhere (run it with Docker Compose), or one AWS EC2 server or Azure VM that runs the whole compose file.
 * A single service keeps its own Deploy card with every target; this card appears only when two or more services are ticked.
 */
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';
import type { Ec2Config } from '@/lib/engines/containers/ec2Deploy';
import type { AzVmConfig } from '@/lib/engines/containers/azureVmDeploy';
import type { ProjectDeploy, ProjectTarget } from '@/lib/engines/containers/stackProject';

export default function StackDeployCard({ deploy, onTarget, onEc2, onAzure }: {
  deploy: ProjectDeploy;
  onTarget: (t: ProjectTarget) => void;
  onEc2: <K extends keyof Ec2Config>(k: K, v: Ec2Config[K]) => void;
  onAzure: <K extends keyof AzVmConfig>(k: K, v: AzVmConfig[K]) => void;
}) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const label = clsx('block text-xs font-medium mb-1', isLight ? 'text-slate-700' : 'text-slate-300');
  const input = clsx('w-full rounded-lg border px-3 py-2 text-sm', isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-slate-100');
  const e = deploy.ec2;
  const z = deploy.azvm;
  return (
    <div className={clsx('rounded-2xl border p-5 space-y-3', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800')} data-testid="project-deploy">
      <label className={label} htmlFor="ct-project-target">Deploy to</label>
      <select id="ct-project-target" className={input} value={deploy.target} onChange={(ev) => onTarget(ev.target.value as ProjectTarget)}>
        <option value="none">No deployment files (run with Docker Compose)</option>
        <option value="ec2">AWS EC2 (one server runs everything)</option>
        <option value="azure-vm">Azure VM (one server runs everything)</option>
      </select>
      {deploy.target === 'none' && (
        <p className={clsx('text-xs', muted)}>The services are built and started together: <code>docker compose up --build</code> in the folder you download. Pick EC2 or an Azure VM to also get <code>deploy.sh</code>, <code>destroy.sh</code> and the Terraform that run all of it on one server.</p>
      )}
      {deploy.target === 'ec2' && (
        <>
          <p className={clsx('text-xs', muted)}>One server runs every service with Docker Compose. Only the public service (the Frontend, else the API, else the Backend) is open to the network; the others and the database stay inside the server. One image repository per built service, a private release bucket, secrets in SSM Parameter Store, no SSH.</p>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label} htmlFor="pec2-region">Region</label><input id="pec2-region" className={input} value={e.region} onChange={(ev) => onEc2('region', ev.target.value)} /></div>
            <div><label className={label} htmlFor="pec2-type">Instance type</label><input id="pec2-type" className={input} value={e.instanceType} onChange={(ev) => onEc2('instanceType', ev.target.value)} /></div>
            <div className="col-span-2"><label className={label} htmlFor="pec2-cidr">Who can connect to the public service</label><input id="pec2-cidr" className={input} value={e.allowedCidr} onChange={(ev) => onEc2('allowedCidr', ev.target.value)} /></div>
            <div><label className={label} htmlFor="pec2-disk">Disk (GB)</label><input id="pec2-disk" type="number" className={input} value={e.volumeGb} onChange={(ev) => onEc2('volumeGb', Number(ev.target.value))} /></div>
            <div><label className={label} htmlFor="pec2-tag">Image tag</label><input id="pec2-tag" className={input} value={e.imageTag} onChange={(ev) => onEc2('imageTag', ev.target.value)} /></div>
            <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={e.elasticIp} onChange={(ev) => onEc2('elasticIp', ev.target.checked)} />Keep the same public address (Elastic IP)</label>
          </div>
        </>
      )}
      {deploy.target === 'azure-vm' && (
        <>
          <p className={clsx('text-xs', muted)}>One Azure VM runs every service with Docker Compose. Only the public service (the Frontend, else the API, else the Backend) is open to the network; the others and the database stay inside the VM. One container registry, secrets in Key Vault, no SSH, and no Docker needed on your machine (images are built in Azure).</p>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label} htmlFor="paz-location">Location</label><input id="paz-location" className={input} value={z.location} onChange={(ev) => onAzure('location', ev.target.value)} /></div>
            <div><label className={label} htmlFor="paz-size">VM size</label><input id="paz-size" className={input} value={z.size} onChange={(ev) => onAzure('size', ev.target.value)} /></div>
            <div className="col-span-2"><label className={label} htmlFor="paz-cidr">Who can connect to the public service</label><input id="paz-cidr" className={input} value={z.allowedCidr} onChange={(ev) => onAzure('allowedCidr', ev.target.value)} /></div>
            <div><label className={label} htmlFor="paz-disk">Disk (GB)</label><input id="paz-disk" type="number" className={input} value={z.diskGb} onChange={(ev) => onAzure('diskGb', Number(ev.target.value))} /></div>
            <div><label className={label} htmlFor="paz-tag">Image tag</label><input id="paz-tag" className={input} value={z.imageTag} onChange={(ev) => onAzure('imageTag', ev.target.value)} /></div>
          </div>
        </>
      )}
    </div>
  );
}

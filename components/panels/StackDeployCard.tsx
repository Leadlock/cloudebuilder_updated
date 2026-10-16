'use client';
/**
 * Where a project of several services is deployed: nowhere (run it with Docker Compose), one AWS EC2 server or Azure VM that runs the whole compose file, AWS ECS Fargate (a service per service),
 * a Kubernetes cluster (a Deployment per service), or an Azure Kubernetes Service cluster that is created for it.
 * A single service keeps its own Deploy card with every target; this card appears only when two or more services are ticked.
 */
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';
import type { Ec2Config } from '@/lib/engines/containers/ec2Deploy';
import type { AzVmConfig } from '@/lib/engines/containers/azureVmDeploy';
import type { ProjectDeploy, ProjectTarget } from '@/lib/engines/containers/stackProject';
import type { StackK8sConfig } from '@/lib/engines/containers/stackKubernetesDeploy';
import type { StackAksConfig } from '@/lib/engines/containers/stackAksDeploy';
import { FARGATE_CPU, fargateMemoryOptions } from '@/lib/engines/containers/ecsDeploy';
import type { StackEcsConfig } from '@/lib/engines/containers/stackEcsDeploy';

export default function StackDeployCard({ deploy, onTarget, onEc2, onEcs, onAzure, onK8s, onAks }: {
  deploy: ProjectDeploy;
  onTarget: (t: ProjectTarget) => void;
  onEc2: <K extends keyof Ec2Config>(k: K, v: Ec2Config[K]) => void;
  onEcs: <K extends keyof StackEcsConfig>(k: K, v: StackEcsConfig[K]) => void;
  onAzure: <K extends keyof AzVmConfig>(k: K, v: AzVmConfig[K]) => void;
  onK8s: <K extends keyof StackK8sConfig>(k: K, v: StackK8sConfig[K]) => void;
  onAks: <K extends keyof StackAksConfig>(k: K, v: StackAksConfig[K]) => void;
}) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const label = clsx('block text-xs font-medium mb-1', isLight ? 'text-slate-700' : 'text-slate-300');
  const input = clsx('w-full rounded-lg border px-3 py-2 text-sm', isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-slate-100');
  const e = deploy.ec2;
  const c = deploy.ecs;
  const z = deploy.azvm;
  const k = deploy.k8s;
  const a = deploy.aks;
  return (
    <div className={clsx('rounded-2xl border p-5 space-y-3', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800')} data-testid="project-deploy">
      <label className={label} htmlFor="ct-project-target">Deploy to</label>
      <select id="ct-project-target" className={input} value={deploy.target} onChange={(ev) => onTarget(ev.target.value as ProjectTarget)}>
        <option value="none">No deployment files (run with Docker Compose)</option>
        <option value="ec2">AWS EC2 (one server runs everything)</option>
        <option value="ecs">AWS ECS Fargate (a service per service, behind a load balancer)</option>
        <option value="azure-vm">Azure VM (one server runs everything)</option>
        <option value="kubernetes">Kubernetes (a Deployment per service)</option>
        <option value="aks">Azure Kubernetes Service (AKS cluster created for it)</option>
      </select>
      {deploy.target === 'none' && (
        <p className={clsx('text-xs', muted)}>The services are built and started together: <code>docker compose up --build</code> in the folder you download. Pick EC2, an Azure VM, Kubernetes or AKS to also get <code>deploy.sh</code>, <code>destroy.sh</code> and the Terraform that run all of it on one server.</p>
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
      {deploy.target === 'ecs' && (
        <>
          <p className={clsx('text-xs', muted)}>Every service runs as its own ECS Fargate service (no servers), behind one load balancer that reaches the public service (the Frontend, else the API, else the Backend). The services find each other by name, as in Docker Compose. One image repository per built service, secrets in SSM Parameter Store. A database is not run on Fargate: use RDS and add a secret variable DATABASE_URL.</p>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label} htmlFor="pecs-region">Region</label><input id="pecs-region" className={input} value={c.region} onChange={(ev) => onEcs('region', ev.target.value)} /></div>
            <div><label className={label} htmlFor="pecs-tag">Image tag</label><input id="pecs-tag" className={input} value={c.imageTag} onChange={(ev) => onEcs('imageTag', ev.target.value.trim())} /></div>
            <div><label className={label} htmlFor="pecs-cpu">CPU per task</label>
              <select id="pecs-cpu" className={input} value={c.cpu} onChange={(ev) => { const cpu = Number(ev.target.value); onEcs('cpu', cpu); if (!fargateMemoryOptions(cpu).includes(c.memoryMb)) onEcs('memoryMb', fargateMemoryOptions(cpu)[0]!); }}>
                {FARGATE_CPU.map((n) => <option key={n} value={n}>{n / 1024} vCPU</option>)}
              </select></div>
            <div><label className={label} htmlFor="pecs-mem">Memory per task</label>
              <select id="pecs-mem" className={input} value={c.memoryMb} onChange={(ev) => onEcs('memoryMb', Number(ev.target.value))}>
                {fargateMemoryOptions(c.cpu).map((n) => <option key={n} value={n}>{n / 1024} GB</option>)}
              </select></div>
            <div><label className={label} htmlFor="pecs-count">Tasks per service</label><input id="pecs-count" type="number" className={input} value={c.desiredCount} onChange={(ev) => onEcs('desiredCount', Number(ev.target.value))} /></div>
            <div><label className={label} htmlFor="pecs-cidr">Who can connect</label><input id="pecs-cidr" className={input} value={c.allowedCidr} onChange={(ev) => onEcs('allowedCidr', ev.target.value)} /></div>
            <div className="col-span-2"><label className={label} htmlFor="pecs-cert">ACM certificate ARN (optional, turns on HTTPS)</label><input id="pecs-cert" className={input} value={c.certificateArn} onChange={(ev) => onEcs('certificateArn', ev.target.value.trim())} /></div>
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
      {deploy.target === 'kubernetes' && (
        <>
          <p className={clsx('text-xs', muted)}>Every service becomes a Deployment and a Service in one namespace, applied with Kustomize to the cluster kubectl is pointed at (EKS, AKS, GKE, k3s). Only the public service (the Frontend, else the API, else the Backend) gets an Ingress or a LoadBalancer. A database is not run in the cluster: use your cloud&apos;s managed database and add a secret variable DATABASE_URL.</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><label className={label} htmlFor="pk8s-registry">Image registry</label><input id="pk8s-registry" className={input} placeholder="ghcr.io/yourname" value={k.registry} onChange={(ev) => onK8s('registry', ev.target.value.trim())} /></div>
            <div><label className={label} htmlFor="pk8s-ns">Namespace (empty: the project name)</label><input id="pk8s-ns" className={input} value={k.namespace} onChange={(ev) => onK8s('namespace', ev.target.value.trim())} /></div>
            <div><label className={label} htmlFor="pk8s-tag">Image tag</label><input id="pk8s-tag" className={input} value={k.imageTag} onChange={(ev) => onK8s('imageTag', ev.target.value.trim())} /></div>
            <div><label className={label} htmlFor="pk8s-replicas">Replicas per service</label><input id="pk8s-replicas" type="number" className={input} value={k.replicas} onChange={(ev) => onK8s('replicas', Number(ev.target.value))} /></div>
            <div><label className={label} htmlFor="pk8s-svc">Public service type</label>
              <select id="pk8s-svc" className={input} value={k.serviceType} onChange={(ev) => onK8s('serviceType', ev.target.value as StackK8sConfig['serviceType'])}><option>ClusterIP</option><option>LoadBalancer</option></select></div>
            <div className="col-span-2"><label className={label} htmlFor="pk8s-host">Ingress host (optional)</label><input id="pk8s-host" className={input} placeholder="app.example.com" value={k.ingressHost} onChange={(ev) => onK8s('ingressHost', ev.target.value.trim())} /></div>
            <div><label className={label} htmlFor="pk8s-class">Ingress class</label><input id="pk8s-class" className={input} value={k.ingressClass} onChange={(ev) => onK8s('ingressClass', ev.target.value.trim())} /></div>
            <div><label className={label} htmlFor="pk8s-tls">TLS secret (optional)</label><input id="pk8s-tls" className={input} value={k.tlsSecret} onChange={(ev) => onK8s('tlsSecret', ev.target.value.trim())} /></div>
          </div>
        </>
      )}
      {deploy.target === 'aks' && (
        <>
          <p className={clsx('text-xs', muted)}>An AKS cluster is created for the project, with a container registry (images are built inside Azure, no Docker needed here) and, when a service has secrets, a Key Vault read through workload identity. Every service becomes a Deployment; only the public service (the Frontend, else the API, else the Backend) is reachable from outside. A database is not run in the cluster: use Azure Database for PostgreSQL or MySQL and add a secret variable DATABASE_URL.</p>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label} htmlFor="paks-location">Location</label><input id="paks-location" className={input} value={a.location} onChange={(ev) => onAks('location', ev.target.value)} /></div>
            <div><label className={label} htmlFor="paks-size">Node size</label><input id="paks-size" className={input} value={a.nodeSize} onChange={(ev) => onAks('nodeSize', ev.target.value)} /></div>
            <div><label className={label} htmlFor="paks-min">Minimum nodes</label><input id="paks-min" type="number" className={input} value={a.minNodes} onChange={(ev) => onAks('minNodes', Number(ev.target.value))} /></div>
            <div><label className={label} htmlFor="paks-max">Maximum nodes</label><input id="paks-max" type="number" className={input} value={a.maxNodes} onChange={(ev) => onAks('maxNodes', Number(ev.target.value))} /></div>
            <div><label className={label} htmlFor="paks-ns">Namespace (empty: the project name)</label><input id="paks-ns" className={input} value={a.namespace} onChange={(ev) => onAks('namespace', ev.target.value.trim())} /></div>
            <div><label className={label} htmlFor="paks-tag">Image tag</label><input id="paks-tag" className={input} value={a.imageTag} onChange={(ev) => onAks('imageTag', ev.target.value.trim())} /></div>
            <div><label className={label} htmlFor="paks-replicas">Replicas per service</label><input id="paks-replicas" type="number" className={input} value={a.replicas} onChange={(ev) => onAks('replicas', Number(ev.target.value))} /></div>
            <div><label className={label} htmlFor="paks-svc">Public service type</label>
              <select id="paks-svc" className={input} value={a.serviceType} onChange={(ev) => onAks('serviceType', ev.target.value as StackAksConfig['serviceType'])}><option>ClusterIP</option><option>LoadBalancer</option></select></div>
            <div><label className={label} htmlFor="paks-host">Ingress host (optional)</label><input id="paks-host" className={input} placeholder="app.example.com" value={a.ingressHost} onChange={(ev) => onAks('ingressHost', ev.target.value.trim())} /></div>
            <div><label className={label} htmlFor="paks-tls">TLS secret (optional)</label><input id="paks-tls" className={input} value={a.tlsSecret} onChange={(ev) => onAks('tlsSecret', ev.target.value.trim())} /></div>
          </div>
        </>
      )}
    </div>
  );
}

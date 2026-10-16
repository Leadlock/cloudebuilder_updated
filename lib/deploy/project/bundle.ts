/**
 * The deployment bundle of a project, produced on the server from the project's settings. The browser never supplies generated files: it supplies
 * the project (names, choices, settings) and the server generates the files itself, so what is approved is exactly what runs.
 */
import { createHash } from 'crypto';
import { generateProjectFiles, enabledLayers, projectLayout, type StackProject } from '@/lib/engines/containers/stackProject';
import type { GeneratedFile } from '@/lib/engines/containers/dockerTemplates';
import { buildTar, type TarFile } from './tar';
import type { ZipFile } from './zip';
import type { ReleaseTarget } from './types';

/** The code a person uploaded for a service, as read from their zip. */
export interface SourceInput { sha256: string; files: ZipFile[] }

/** What the generated folder of a service keeps when the person's own code is built instead: the Dockerfile and the settings around it are the hardened ones CloudCraft wrote. */
export const KEPT_FROM_GENERATED = new Set(['Dockerfile', '.dockerignore', 'nginx.conf']);

export interface ProjectBundle {
  target: ReleaseTarget;
  project: string;
  imageTag: string;
  files: GeneratedFile[];
  /** The files of the Terraform project (azvm/* or ec2/*), with their paths relative to that folder. */
  terraform: Array<{ filename: string; content: string }>;
  compose: string;
  built: string[];
  secrets: string[];
  /** The public service's port and health path on the VM (for the health check). */
  entry: { service: string; port: number; path: string };
  /** The services built from the person's own code, by service. */
  sources: Record<string, SourceInput>;
  bundleHash: string;
  warnings: string[];
  cost: { monthlyUsd: number } | null;
}

export class BundleError extends Error {
  constructor(public readonly errors: string[]) { super(errors.join(' ')); this.name = 'BundleError'; }
}

/** One hash over everything a release is made of: the generated files, the target and the tag. A change to any of them is a different release. */
export function hashBundle(target: string, imageTag: string, files: Array<{ path: string; content: string }>): string {
  const h = createHash('sha256');
  h.update(`target:${target}\0tag:${imageTag}\0`);
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`${f.path}\0${f.content.length}\0${f.content}\0`);
  return h.digest('hex');
}

/** The deployment targets a release can run on, and where each keeps its files in the generated project. */
const TARGETS = {
  'azure-vm': { dir: 'azvm', label: 'an Azure VM', tag: (p: StackProject) => p.deploy.azvm.imageTag },
  ec2: { dir: 'ec2', label: 'AWS EC2', tag: (p: StackProject) => p.deploy.ec2.imageTag },
  ecs: { dir: 'ecs', label: 'AWS ECS Fargate', tag: (p: StackProject) => p.deploy.ecs.imageTag },
} as const;

/** Builds the bundle for the project's deployment target. Throws BundleError with the reasons when the project cannot be deployed. */
export function buildBundle(project: StackProject, sources: Record<string, SourceInput> = {}): ProjectBundle {
  const target = project.deploy.target;
  if (target !== 'azure-vm' && target !== 'ec2' && target !== 'ecs') throw new BundleError(['Deploying from CloudCraft is for a project that goes to an Azure VM, AWS EC2 or AWS ECS Fargate.']);
  const t = TARGETS[target];
  if (enabledLayers(project).length < 2) throw new BundleError(['Deploying from CloudCraft needs a project of two or more services; one service has its own deployment.']);
  // On AWS the images are built in the account (CodeBuild), which a person who downloads the files does not need: it is part of the release's Terraform only.
  const r = generateProjectFiles(project, { forRelease: true });
  if (!r.ok) throw new BundleError(r.errors);
  // ECS has no compose file: every service is an ECS service, and a release changes the images its task definitions run.
  const compose = target === 'ecs' ? '' : r.files.find((f) => f.path === `${t.dir}/compose.deploy.yml`)?.content;
  if (compose === undefined) throw new BundleError(['The deployment files are missing the compose file.']);
  const built = enabledLayers(project).filter((l) => l !== 'database' && project.layers[l].config.image === '');
  const secrets = [...new Set(enabledLayers(project).flatMap((l) => project.layers[l].config.env.filter((v) => v.secret).map((v) => v.key)))];
  const entryLayer = enabledLayers(project).includes('frontend') ? 'frontend' : enabledLayers(project).includes('api') ? 'api' : 'backend';
  const entryPort = target === 'ecs' ? project.layers[entryLayer].config.port : (projectLayout(project).hostPort[entryLayer] ?? project.layers[entryLayer].config.port);
  for (const layer of Object.keys(sources)) if (!built.includes(layer as never)) throw new BundleError([`The ${layer} is not built from source, so it cannot have uploaded code.`]);
  const imageTag = t.tag(project);
  return {
    target,
    project: project.name,
    imageTag,
    files: r.files,
    terraform: r.files.filter((f) => f.path.startsWith(`${t.dir}/`) && /\.(tf|sh|yml)$/.test(f.path)).map((f) => ({ filename: f.path.slice(t.dir.length + 1), content: f.content })),
    compose,
    built,
    secrets,
    entry: { service: entryLayer, port: entryPort, path: project.layers[entryLayer].config.healthPath || '/' },
    sources,
    // The hash covers the uploaded code too: a different zip is a different release.
    bundleHash: hashBundle(target, imageTag, [...r.files, ...Object.entries(sources).map(([layer, s]) => ({ path: `@source/${layer}`, content: s.sha256 }))]),
    warnings: r.warnings,
    cost: r.cost ? { monthlyUsd: r.cost.monthlyUsd } : null,
  };
}

/** The Azure VM bundle (the name the first version had). */
export function buildAzureVmBundle(project: StackProject, sources: Record<string, SourceInput> = {}): ProjectBundle {
  if (project.deploy.target !== 'azure-vm') throw new BundleError(['The project is not set to deploy to an Azure VM.']);
  return buildBundle(project, sources);
}

/**
 * The files of one built service for an image build: the generated folder, or, when the person uploaded their code, that code with the generated
 * Dockerfile (and .dockerignore and nginx.conf) in place of any of the same name in the zip.
 */
export function sourceFiles(bundle: ProjectBundle, layer: string): TarFile[] {
  const prefix = `${layer}/`;
  const generated: TarFile[] = bundle.files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), content: f.content }));
  if (!generated.some((f) => f.path === 'Dockerfile')) throw new BundleError([`The ${layer} has no Dockerfile to build.`]);
  const own = bundle.sources[layer];
  if (!own) return generated;
  const kept = generated.filter((f) => KEPT_FROM_GENERATED.has(f.path));
  return [...kept, ...own.files.filter((f) => !KEPT_FROM_GENERATED.has(f.path)).map((f) => ({ path: f.path, content: f.content }))];
}

/** The same files as a gzip-compressed tar archive (what an Azure registry build is given). */
export function sourceArchive(bundle: ProjectBundle, layer: string): Buffer {
  return buildTar(sourceFiles(bundle, layer));
}

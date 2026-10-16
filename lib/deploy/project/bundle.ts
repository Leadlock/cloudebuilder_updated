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
  /** The files of the Terraform project (azvm/*), with their paths relative to that folder. */
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

/** Builds the bundle for an Azure VM deployment. Throws BundleError with the reasons when the project cannot be deployed. */
export function buildAzureVmBundle(project: StackProject, sources: Record<string, SourceInput> = {}): ProjectBundle {
  if (project.deploy.target !== 'azure-vm') throw new BundleError(['The project is not set to deploy to an Azure VM.']);
  if (enabledLayers(project).length < 2) throw new BundleError(['Deploying from CloudCraft needs a project of two or more services; one service has its own deployment.']);
  const r = generateProjectFiles(project);
  if (!r.ok) throw new BundleError(r.errors);
  const get = (p: string) => r.files.find((f) => f.path === p)?.content;
  const compose = get('azvm/compose.deploy.yml');
  if (!compose) throw new BundleError(['The deployment files are missing the compose file.']);
  const built = enabledLayers(project).filter((l) => l !== 'database' && project.layers[l].config.image === '');
  const secrets = [...new Set(enabledLayers(project).flatMap((l) => project.layers[l].config.env.filter((v) => v.secret).map((v) => v.key)))];
  const entryLayer = enabledLayers(project).includes('frontend') ? 'frontend' : enabledLayers(project).includes('api') ? 'api' : 'backend';
  const entryPort = projectLayout(project).hostPort[entryLayer] ?? project.layers[entryLayer].config.port;
  for (const layer of Object.keys(sources)) if (!built.includes(layer as never)) throw new BundleError([`The ${layer} is not built from source, so it cannot have uploaded code.`]);
  const imageTag = project.deploy.azvm.imageTag;
  return {
    target: 'azure-vm',
    project: project.name,
    imageTag,
    files: r.files,
    terraform: r.files.filter((f) => f.path.startsWith('azvm/') && /\.(tf|sh|yml)$/.test(f.path)).map((f) => ({ filename: f.path.slice('azvm/'.length), content: f.content })),
    compose,
    built,
    secrets,
    entry: { service: entryLayer, port: entryPort, path: project.layers[entryLayer].config.healthPath || '/' },
    sources,
    // The hash covers the uploaded code too: a different zip is a different release.
    bundleHash: hashBundle('azure-vm', imageTag, [...r.files, ...Object.entries(sources).map(([layer, s]) => ({ path: `@source/${layer}`, content: s.sha256 }))]),
    warnings: r.warnings,
    cost: r.cost ? { monthlyUsd: r.cost.monthlyUsd } : null,
  };
}

/**
 * The source of one built service as an archive for a registry build: the generated folder, or, when the person uploaded their code, that code with
 * the generated Dockerfile (and .dockerignore and nginx.conf) in place of any of the same name in the zip.
 */
export function sourceArchive(bundle: ProjectBundle, layer: string): Buffer {
  const prefix = `${layer}/`;
  const generated: TarFile[] = bundle.files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), content: f.content }));
  if (!generated.some((f) => f.path === 'Dockerfile')) throw new BundleError([`The ${layer} has no Dockerfile to build.`]);
  const own = bundle.sources[layer];
  if (!own) return buildTar(generated);
  const kept = generated.filter((f) => KEPT_FROM_GENERATED.has(f.path));
  return buildTar([...kept, ...own.files.filter((f) => !KEPT_FROM_GENERATED.has(f.path)).map((f) => ({ path: f.path, content: f.content }))]);
}

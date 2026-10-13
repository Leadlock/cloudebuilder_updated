/**
 * Container templates: turns a short, validated form into the files a service needs to run in Docker
 * (Dockerfile, .dockerignore, docker-compose.yml, .env.example, README.md, plus nginx.conf for a static site).
 *
 * Pure and deterministic, so the panel previews exactly what it downloads and the tests can check every output.
 *
 * Safety:
 *  - Every value that reaches a file is validated first; an invalid form returns errors and no files.
 *  - Nothing is ever spliced in raw. Names, versions, ports, paths and variable names are matched against strict patterns, and
 *    free text (commands, values) may not contain line breaks or control characters, so one field cannot add instructions.
 *  - Commands are written in JSON array form. Values are double-quoted with their quotes, backslashes and `$` escaped.
 *  - A variable marked secret never has its value written: .env.example leaves it blank and compose reads it from the host.
 *  - Images run as a non-root user unless the form explicitly turns that off.
 */

export type ContainerStack = 'node' | 'python' | 'java' | 'go' | 'dotnet' | 'ruby' | 'static';

import { generateSampleApp } from './sampleApps';
import { checkContainer, type ContainerFinding } from './checks';
import { imageIsFloating, validateExistingImage } from './existingImage';
import { caddyfile, companionBlocks, companionDependencies, companionEnv, companionSecrets, companionVolumes, companionServices, PROXY_DOMAIN, dbName } from './companions';
import { defaultEc2, ec2Warnings, estimateEc2Cost, type Ec2Cost, generateEc2Files, validateEc2, type Ec2Config } from './ec2Deploy';
export type { Ec2Config } from './ec2Deploy';
import { defaultEcs, ecsWarnings, estimateEcsCost, generateEcsFiles, validateEcs, type EcsConfig } from './ecsDeploy';
import { defaultAca, acaWarnings, estimateAcaCost, generateAcaFiles, validateAca, type AcaConfig } from './containerAppsDeploy';
import { defaultK8s, k8sWarnings, generateK8sFiles, validateK8s, type K8sConfig } from './kubernetesDeploy';
export type { EcsConfig } from './ecsDeploy';
export type { AcaConfig } from './containerAppsDeploy';
import { defaultAzVm, azVmWarnings, estimateAzVmCost, generateAzVmFiles, validateAzVm, type AzVmConfig } from './azureVmDeploy';
import { defaultAks, aksWarnings, estimateAksCost, generateAksFiles, validateAks, type AksConfig } from './aksDeploy';
export type { K8sConfig } from './kubernetesDeploy';
export type { AzVmConfig } from './azureVmDeploy';
export type { AksConfig } from './aksDeploy';

/** Where the container can be deployed from the generated files. At most one is switched on at a time. */
export type DeployTarget = 'none' | 'ec2' | 'ecs' | 'azure-vm' | 'container-apps' | 'aks' | 'kubernetes';
/** Which cloud a target belongs to; Kubernetes runs on any. */
export type TargetCloud = 'aws' | 'azure' | 'any';
export const TARGET_CLOUD: Record<DeployTarget, TargetCloud | 'none'> = { none: 'none', ec2: 'aws', ecs: 'aws', 'azure-vm': 'azure', 'container-apps': 'azure', aks: 'azure', kubernetes: 'any' };
export const DEPLOY_TARGET_LABEL: Record<DeployTarget, string> = {
  none: 'No deployment files', ec2: 'AWS EC2 (one server)', ecs: 'AWS ECS Fargate (managed containers)', 'azure-vm': 'Azure VM (one server)', 'container-apps': 'Azure Container Apps (managed containers)', aks: 'Azure Kubernetes Service (AKS)', kubernetes: 'Any Kubernetes cluster (manifests and Helm)',
};

export interface EnvVar { key: string; value: string; secret?: boolean }

export interface ContainerConfig {
  stack: ContainerStack;
  appName: string;
  port: number;
  /** Runtime version: Node 18/20/22, Python 3.10–3.13, Java 17/21, nginx 1.27 (ignored for static). */
  version: string;
  env: EnvVar[];
  healthPath: string;
  runAsNonRoot: boolean;
  /** compose */
  restart: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  memoryLimit: string;
  cpuLimit: string;
  postgres: boolean;
  redis: boolean;
  mysql: boolean;
  mongodb: boolean;
  rabbitmq: boolean;
  /** A Caddy reverse proxy in docker-compose.yml that serves HTTPS on proxyDomain and forwards to the app. */
  proxy: boolean;
  proxyDomain: string;
  /** stack options */
  packageManager: 'npm' | 'yarn' | 'pnpm';
  buildCommand: string;
  startCommand: string;
  nextStandalone: boolean;
  pythonFramework: 'fastapi' | 'django' | 'flask' | 'other';
  pythonModule: string;
  javaBuildTool: 'maven' | 'gradle';
  /** Go: the package to build, relative to the module root ("." or "./cmd/server"). */
  goPackage: string;
  /** .NET: the project file to publish, and the name of the assembly it produces (the .dll that is run). */
  dotnetProject: string;
  dotnetAssembly: string;
  rubyFramework: 'rails' | 'rack' | 'other';
  staticBuildDir: string;
  staticSpaFallback: boolean;
  /** Optional "deploy to EC2" bundle (Terraform + start-up script + CI workflow). */
  ec2: Ec2Config;
  /** Optional "deploy to ECS Fargate" bundle. */
  ecs: EcsConfig;
  /** Optional "deploy to Azure Container Apps" bundle. */
  aca: AcaConfig;
  /** Optional Kubernetes manifests and Helm chart. */
  k8s: K8sConfig;
  /** Optional "deploy to an Azure VM" bundle. */
  azvm: AzVmConfig;
  /** Optional "deploy to AKS" bundle (uses the Kubernetes settings for the manifests). */
  aks: AksConfig;
  /** Add a tiny working sample app next to the Dockerfile, so the template runs before you have your own code. */
  includeSample: boolean;
  /**
   * An image that already exists (a public one, for example nginx:1.27 or ghcr.io/you/app:1.0). When set, nothing is built: no Dockerfile, no
   * registry and no build step, and every deployment target runs this image as it is. Empty means "build it from the source".
   */
  image: string;
}

/** Whether the deployment runs a ready-made image instead of building one. */
export { usesExistingImage } from './existingImageUse';
import { usesExistingImage } from './existingImageUse';

export interface GeneratedFile { path: string; content: string; /** Set the executable bit when zipped (shell scripts). */ executable?: boolean }
export type GenerateResult = { ok: true; files: GeneratedFile[]; warnings: string[]; findings: ContainerFinding[]; cost?: Ec2Cost } | { ok: false; errors: string[] };

export const STACK_LABEL: Record<ContainerStack, string> = {
  node: 'Node.js / Next.js', python: 'Python (FastAPI / Django / Flask)', java: 'Java (Spring Boot)', go: 'Go', dotnet: '.NET (ASP.NET Core)', ruby: 'Ruby (Rails / Rack)', static: 'Static site (nginx)',
};
export const STACKS = Object.keys(STACK_LABEL) as ContainerStack[];
export const VERSIONS: Record<ContainerStack, string[]> = {
  node: ['22', '20', '18'], python: ['3.13', '3.12', '3.11', '3.10'], java: ['21', '17'], go: ['1.23', '1.22'], dotnet: ['9.0', '8.0'], ruby: ['3.3', '3.2'], static: ['1.27'],
};
const DEFAULT_PORT: Record<ContainerStack, number> = { node: 3000, python: 8000, java: 8080, go: 8080, dotnet: 8080, ruby: 3000, static: 8080 };

export function defaultConfig(stack: ContainerStack = 'node'): ContainerConfig {
  return {
    stack, appName: 'my-app', port: DEFAULT_PORT[stack],
    version: VERSIONS[stack][0]!, env: [], healthPath: stack === 'java' ? '/actuator/health' : '/', runAsNonRoot: true,
    restart: 'unless-stopped', memoryLimit: '512m', cpuLimit: '1.0', postgres: false, redis: false, mysql: false, mongodb: false, rabbitmq: false, proxy: false, proxyDomain: 'localhost',
    packageManager: 'npm', buildCommand: 'npm run build', startCommand: stack === 'ruby' ? 'bundle exec puma -b tcp://0.0.0.0:3000' : 'npm start', nextStandalone: false,
    pythonFramework: 'fastapi', pythonModule: 'main:app', javaBuildTool: 'maven', goPackage: '.', dotnetProject: 'App.csproj', dotnetAssembly: 'App', rubyFramework: 'rack', staticBuildDir: 'dist', staticSpaFallback: true, ec2: defaultEc2(), ecs: defaultEcs(), aca: defaultAca(), k8s: defaultK8s(), azvm: defaultAzVm(), aks: defaultAks(), includeSample: false, image: '',
  };
}

// ─── validation ──────────────────────────────────────────────────────────────

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PATH = /^\/[A-Za-z0-9._~\-/]{0,200}$/;
const RELDIR = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,100}$/;
const MEM = /^[1-9][0-9]{0,5}[mg]$/;
const CPU = /^(?:[0-9]{1,2})(?:\.[0-9]{1,2})?$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The deployment targets that are switched on (validation allows at most one). */
export function deployTargets(c: ContainerConfig): Exclude<DeployTarget, 'none'>[] {
  return [c.ec2.enabled && 'ec2', c.ecs.enabled && 'ecs', c.azvm.enabled && 'azure-vm', c.aca.enabled && 'container-apps', c.aks.enabled && 'aks', c.k8s.enabled && 'kubernetes'].filter((t): t is Exclude<DeployTarget, 'none'> => !!t);
}

/** Switch on exactly one target (or none), leaving each target's own settings as they were. */
export function withDeployTarget(c: ContainerConfig, target: DeployTarget): ContainerConfig {
  return { ...c, ec2: { ...c.ec2, enabled: target === 'ec2' }, ecs: { ...c.ecs, enabled: target === 'ecs' }, aca: { ...c.aca, enabled: target === 'container-apps' }, k8s: { ...c.k8s, enabled: target === 'kubernetes' }, azvm: { ...c.azvm, enabled: target === 'azure-vm' }, aks: { ...c.aks, enabled: target === 'aks' } };
}

export function validate(c: ContainerConfig): string[] {
  const e: string[] = [];
  if (!NAME.test(c.appName)) e.push('App name: lowercase letters, digits, "-" and "_" only, up to 63 characters.');
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) e.push('Port must be a whole number from 1 to 65535.');
  if (!PATH.test(c.healthPath)) e.push('Health check path must start with "/" and use only letters, digits and "._~-/".');
  if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(c.restart)) e.push('Unknown restart policy.');
  if (!MEM.test(c.memoryLimit)) e.push('Memory limit looks like 512m or 2g.');
  if (!CPU.test(c.cpuLimit) || Number(c.cpuLimit) <= 0) e.push('CPU limit looks like 0.5 or 2.');
  if (c.proxy && !PROXY_DOMAIN.test(c.proxyDomain)) e.push('HTTPS proxy: the domain looks like app.example.com (or localhost).');
  if (c.mysql && dbName(c).length > 32) e.push('MySQL: the app name becomes the database user, which MySQL limits to 32 characters.');
  // What describes how to build the image does not matter when a ready-made one is used (and its fields are hidden).
  if (!usesExistingImage(c)) {
  if (!(c.stack in VERSIONS)) e.push('Choose a stack.');
  if (c.stack === 'static' && c.port < 1024) e.push('A static site runs without root, so its port must be 1024 or higher (for example 8080).');
  if (VERSIONS[c.stack] && !VERSIONS[c.stack].includes(c.version)) e.push(`Version ${c.version} is not offered for this stack.`);
  for (const [label, v] of [['Build command', c.buildCommand], ['Start command', c.startCommand]] as const) {
    if (v.length > 300 || CONTROL.test(v)) e.push(`${label} must be one line of at most 300 characters.`);
  }
  if (c.stack === 'node' && !c.startCommand.trim()) e.push('Start command is required.');
  if (c.stack === 'python' && c.pythonFramework !== 'django' && !MODULE.test(c.pythonModule)) e.push('Python module looks like "main:app".');
  if (c.stack === 'python' && c.pythonFramework === 'django' && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(c.pythonModule.split(':')[0] ?? '')) e.push('Django project name must be a Python module name, e.g. "config".');
  if (c.stack === 'go' && (!/^(?:\.|\.\/[A-Za-z0-9_][A-Za-z0-9_./-]*)$/.test(c.goPackage) || c.goPackage.split('/').includes('..'))) e.push('Go package looks like "." or "./cmd/server".');
  if (c.stack === 'dotnet' && (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*\.csproj$/.test(c.dotnetProject) || c.dotnetProject.split('/').includes('..'))) e.push('.NET project file looks like "App.csproj" or "src/App/App.csproj".');
  if (c.stack === 'dotnet' && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(c.dotnetAssembly)) e.push('.NET assembly name may use letters, digits, "_" and "." (for example "App").');
  if (c.stack === 'ruby' && !['rails', 'rack', 'other'].includes(c.rubyFramework)) e.push('Choose a Ruby framework.');
  if (c.stack === 'ruby' && c.rubyFramework === 'other' && !c.startCommand.trim()) e.push('Start command is required.');
  if (c.stack === 'static' && !RELDIR.test(c.staticBuildDir)) e.push('Build output folder must be a relative folder name such as "dist" or "build".');
  if (c.stack === 'static' && c.staticBuildDir.split('/').includes('..')) e.push('Build output folder cannot go up a level.');
  }
  const seen = new Set<string>();
  if (c.env.length > 50) e.push('At most 50 environment variables.');
  for (const v of c.env) {
    if (!ENV_KEY.test(v.key)) e.push(`Variable name "${v.key.slice(0, 30)}" is not valid (letters, digits and "_", not starting with a digit).`);
    else if (RESERVED_ENV.has(v.key.toUpperCase())) e.push(`${v.key} is reserved by the system and cannot be set here.`);
    else if (seen.has(v.key)) e.push(`${v.key} is listed twice.`);
    seen.add(v.key);
    if (v.value.length > 500 || CONTROL.test(v.value)) e.push(`${v.key}: the value must be one line of at most 500 characters.`);
  }
  e.push(...validateExistingImage(c.image));
  const targets = deployTargets(c);
  if (targets.length > 1) e.push(`Choose one place to deploy to: ${targets.map((t) => DEPLOY_TARGET_LABEL[t]).join(' and ')} are both switched on, and each writes its own deploy.sh.`);
  return [...e, ...validateEc2(c), ...validateEcs(c), ...validateAca(c), ...validateK8s(c), ...validateAzVm(c), ...validateAks(c)];
}

// ─── quoting ─────────────────────────────────────────────────────────────────

/** A YAML double-quoted string: only backslash and quote need escaping. */
const yq = (s: string) => `"${s.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
const json = (s: string) => JSON.stringify(s);
const shCmd = (cmd: string) => `CMD ["sh", "-c", ${json(cmd)}]`;
const plain = (c: ContainerConfig) => c.env.filter((v) => !v.secret);
const secrets = (c: ContainerConfig) => c.env.filter((v) => v.secret);

// ─── Dockerfiles ─────────────────────────────────────────────────────────────

function userBlock(c: ContainerConfig, alpine: boolean): string {
  if (!c.runAsNonRoot) return '# WARNING: the container runs as root. Prefer a non-root user in production.\n';
  return alpine
    ? 'RUN addgroup --system --gid 1001 app && adduser --system --uid 1001 --ingroup app app\nUSER app\n'
    : 'RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app --no-create-home app\nUSER app\n';
}

function healthcheck(c: ContainerConfig, tool: 'wget' | 'curl' | 'node' | 'python' | 'ruby'): string {
  const url = `http://127.0.0.1:${c.port}${c.healthPath}`;
  const cmd = tool === 'wget' ? `wget -q --spider ${url} || exit 1`
    : tool === 'curl' ? `curl -fsS ${url} > /dev/null || exit 1`
      : tool === 'ruby' ? `ruby -rnet/http -e "exit(Net::HTTP.get_response(URI('${url}')).code.to_i < 400 ? 0 : 1)" || exit 1`
      : tool === 'node' ? `node -e "fetch('${url}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`
        : `python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('${url}').status<400 else 1)"`;
  return `HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ${cmd}\n`;
}

function nodeDockerfile(c: ContainerConfig): string {
  const pm = c.packageManager;
  const lock = pm === 'npm' ? 'package-lock.json' : pm === 'yarn' ? 'yarn.lock' : 'pnpm-lock.yaml';
  const install = pm === 'npm' ? 'npm ci' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : 'corepack enable && pnpm install --frozen-lockfile';
  const prune = pm === 'npm' ? 'npm prune --omit=dev' : pm === 'yarn' ? 'yarn install --frozen-lockfile --production' : 'pnpm prune --prod';
  const corepack = pm === 'npm' ? '' : 'RUN corepack enable\n';
  const runtime = c.nextStandalone
    ? `COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
`
    : `COPY --from=build /app ./
`;
  const start = c.nextStandalone ? 'node server.js' : c.startCommand;
  return `# syntax=docker/dockerfile:1
# ${c.appName}: Node.js ${c.version}, multi-stage build
FROM node:${c.version}-alpine AS deps
WORKDIR /app
${corepack}COPY package.json ${lock}* ./
# node_modules may not exist for a project with no dependencies; the next stage copies the folder.
RUN ${install} && mkdir -p node_modules

FROM node:${c.version}-alpine AS build
WORKDIR /app
${corepack}COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN ${c.buildCommand.trim() || 'true'}
${c.nextStandalone ? '' : `RUN ${prune}\n`}
FROM node:${c.version}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${c.port}
ENV HOSTNAME=0.0.0.0
${runtime}${userBlock(c, true)}EXPOSE ${c.port}
${healthcheck(c, 'wget')}${shCmd(start)}
`;
}

function pythonDockerfile(c: ContainerConfig): string {
  const [mod] = c.pythonModule.split(':');
  const cmd = c.pythonFramework === 'fastapi' ? `uvicorn ${c.pythonModule} --host 0.0.0.0 --port ${c.port}`
    : c.pythonFramework === 'django' ? `gunicorn ${mod}.wsgi:application --bind 0.0.0.0:${c.port}`
      : c.pythonFramework === 'flask' ? `gunicorn ${c.pythonModule} --bind 0.0.0.0:${c.port}`
        : c.startCommand;
  return `# syntax=docker/dockerfile:1
# ${c.appName}: Python ${c.version}, ${c.pythonFramework}
FROM python:${c.version}-slim AS build
WORKDIR /app
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt ./
RUN pip install -r requirements.txt

FROM python:${c.version}-slim AS runtime
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:$PATH"
ENV PORT=${c.port}
COPY --from=build /opt/venv /opt/venv
COPY . .
${userBlock(c, false)}EXPOSE ${c.port}
${healthcheck(c, 'python')}${shCmd(cmd)}
`;
}

function javaDockerfile(c: ContainerConfig): string {
  const mvn = c.javaBuildTool === 'maven';
  return `# syntax=docker/dockerfile:1
# ${c.appName}: Spring Boot on Java ${c.version}, ${mvn ? 'Maven' : 'Gradle'}
FROM ${mvn ? `maven:3-eclipse-temurin-${c.version}` : `gradle:8-jdk${c.version}`} AS build
WORKDIR /workspace
COPY . .
RUN ${mvn ? 'mvn -B -q -DskipTests package' : 'gradle --no-daemon -q bootJar -x test'}
RUN cp ${mvn ? 'target' : 'build/libs'}/*.jar /workspace/app.jar

FROM eclipse-temurin:${c.version}-jre-alpine AS runtime
WORKDIR /app
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75"
ENV SERVER_PORT=${c.port}
COPY --from=build /workspace/app.jar ./app.jar
${userBlock(c, true)}EXPOSE ${c.port}
${healthcheck(c, 'wget')}ENTRYPOINT ["java", "-jar", "/app/app.jar"]
`;
}

function goDockerfile(c: ContainerConfig): string {
  return `# syntax=docker/dockerfile:1
# ${c.appName}: Go ${c.version}, static binary
FROM golang:${c.version}-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ${c.goPackage}

FROM alpine:3.20 AS runtime
WORKDIR /app
RUN apk add --no-cache ca-certificates tzdata
ENV PORT=${c.port}
COPY --from=build /out/app ./app
${userBlock(c, true)}EXPOSE ${c.port}
${healthcheck(c, 'wget')}ENTRYPOINT ["/app/app"]
`;
}

function dotnetDockerfile(c: ContainerConfig): string {
  return `# syntax=docker/dockerfile:1
# ${c.appName}: ASP.NET Core ${c.version}
# The runtime image already has a user and group called "app" (uid 1654), so this one is called appuser, with the same uid 1001 as the other stacks.
FROM mcr.microsoft.com/dotnet/sdk:${c.version}-alpine AS build
WORKDIR /src
COPY . .
RUN dotnet publish ${c.dotnetProject} -c Release -o /out /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:${c.version}-alpine AS runtime
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:${c.port} DOTNET_RUNNING_IN_CONTAINER=true DOTNET_EnableDiagnostics=0
COPY --from=build /out ./
${c.runAsNonRoot ? 'RUN addgroup --system --gid 1001 appuser && adduser --system --uid 1001 --ingroup appuser appuser\nUSER appuser\n' : userBlock(c, true)}EXPOSE ${c.port}
${healthcheck(c, 'wget')}ENTRYPOINT ["dotnet", "${c.dotnetAssembly}.dll"]
`;
}

function rubyDockerfile(c: ContainerConfig): string {
  const cmd = c.rubyFramework === 'rails' ? `bin/rails server -b 0.0.0.0 -p ${c.port}`
    : c.rubyFramework === 'rack' ? `bundle exec rackup config.ru -o 0.0.0.0 -p ${c.port}`
      : c.startCommand;
  const rails = c.rubyFramework === 'rails';
  return `# syntax=docker/dockerfile:1
# ${c.appName}: Ruby ${c.version}, ${c.rubyFramework === 'other' ? 'custom start command' : c.rubyFramework}
FROM ruby:${c.version}-slim AS build
WORKDIR /app
ENV BUNDLE_WITHOUT="development:test" BUNDLE_PATH=/usr/local/bundle
RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential git libyaml-dev pkg-config && rm -rf /var/lib/apt/lists/*
COPY Gemfile Gemfile.lock* ./
RUN bundle install --jobs 4 && rm -rf /usr/local/bundle/cache
COPY . .
${rails ? 'RUN SECRET_KEY_BASE_DUMMY=1 bin/rails assets:precompile\n' : ''}
FROM ruby:${c.version}-slim AS runtime
WORKDIR /app
ENV BUNDLE_WITHOUT="development:test" BUNDLE_PATH=/usr/local/bundle RACK_ENV=production${rails ? ' RAILS_ENV=production RAILS_LOG_TO_STDOUT=1 RAILS_SERVE_STATIC_FILES=1' : ''} PORT=${c.port}
COPY --from=build /usr/local/bundle /usr/local/bundle
COPY --from=build /app /app
${userBlock(c, false)}EXPOSE ${c.port}
${healthcheck(c, 'ruby')}${shCmd(cmd)}
`;
}

function staticDockerfile(c: ContainerConfig): string {
  return `# syntax=docker/dockerfile:1
# ${c.appName}: static site served by nginx ${c.version}
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN ${c.buildCommand.trim() || 'npm run build'}

FROM nginxinc/nginx-unprivileged:${c.version}-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/${c.staticBuildDir} /usr/share/nginx/html
EXPOSE ${c.port}
${healthcheck(c, 'wget')}CMD ["nginx", "-g", "daemon off;"]
`;
}

function nginxConf(c: ContainerConfig): string {
  return `server {
  listen ${c.port};
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  gzip on;
  gzip_types text/plain text/css application/javascript application/json image/svg+xml;

  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options SAMEORIGIN always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;

  location / {
    try_files $uri $uri/ ${c.staticSpaFallback ? '/index.html' : '=404'};
  }

  location ~* \\.(?:js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$ {
    expires 30d;
    add_header Cache-Control "public, immutable";
  }
}
`;
}

// ─── compose, env, docker ignore, README ─────────────────────────────────────

function compose(c: ContainerConfig): string {
  const plainVars = plain(c);
  const secretVars = secrets(c);
  const envLines = [
    // Compose treats $ as interpolation, so a literal $ in a value is doubled.
    ...plainVars.map((v) => `${v.key}: ${yq(v.value.replace(/\$/g, '$$$$'))}`),
    ...secretVars.map((v) => `${v.key}: "\${${v.key}:?set ${v.key}}"`),
    ...companionEnv(c),
  ];
  const deps = companionDependencies(c);
  // Behind the proxy only the proxy is published; the app is reachable from it over the compose network.
  const exposure = c.proxy ? `    expose:\n      - "${c.port}"\n` : `    ports:\n      - "${c.port}:${c.port}"\n`;
  return `# Run with: docker compose ${usesExistingImage(c) ? 'up' : 'up --build'}
services:
  ${c.appName}:
${usesExistingImage(c) ? `    image: ${c.image}\n` : `    build: .\n    image: ${c.appName}:latest\n`}    restart: ${c.restart}
${exposure}${envLines.length ? `    environment:\n${envLines.map((l) => `      ${l}`).join('\n')}\n` : ''}${deps.length ? `    depends_on:\n${deps.map((d) => `      ${d}:\n        condition: service_healthy`).join('\n')}\n` : ''}    mem_limit: ${c.memoryLimit}
    cpus: ${c.cpuLimit}
    security_opt:
      - no-new-privileges:true
${companionBlocks(c)}${companionVolumes(c)}`;
}

function envExample(c: ContainerConfig): string {
  const lines = [
    '# Copy to .env and fill in. Never commit .env.',
    ...plain(c).map((v) => `${v.key}=${v.value}`),
    ...secrets(c).map((v) => `${v.key}=`),
    ...companionSecrets(c).map((n) => `${n}=`),
  ];
  return `${lines.join('\n')}\n`;
}

function dockerignore(c: ContainerConfig): string {
  const common = ['.git', '.gitignore', '.env', '.env.*', '!.env.example', 'Dockerfile', 'docker-compose*.yml', '.dockerignore', '*.md', '.vscode', '.idea', '.DS_Store'];
  const per: Record<ContainerStack, string[]> = {
    node: ['node_modules', '.next', 'dist', 'coverage', 'npm-debug.log*'],
    static: ['node_modules', 'dist', 'build', 'coverage'],
    python: ['__pycache__', '*.pyc', '.venv', 'venv', '.pytest_cache', '.mypy_cache'],
    java: ['target', 'build', '.gradle', '.mvn/wrapper/maven-wrapper.jar'],
    go: ['bin', '*.test', '*.out'],
    dotnet: ['bin', 'obj', '.vs', '*.user'],
    ruby: ['log', 'tmp', '.bundle', 'vendor/bundle', 'node_modules', 'storage'],
  };
  const deploy = c.ec2.enabled ? ['ec2', '.github', '.terraform'] : c.ecs.enabled ? ['ecs', '.github', '.terraform'] : c.aca.enabled ? ['aca', '.github', '.terraform'] : c.azvm.enabled ? ['azvm', '.github', '.terraform'] : c.aks.enabled ? ['aks', 'k8s', 'helm', '.terraform', 'deploy.sh', 'destroy.sh'] : c.k8s.enabled ? ['k8s', 'helm', '.github', 'deploy.sh', 'destroy.sh'] : [];
  return `${[...common, ...(c.proxy ? ['Caddyfile'] : []), ...deploy, ...per[c.stack]].join('\n')}\n`;
}

/** The README: for a ready-made image the "Before you build" parts do not apply, and the runtime is the image itself. */
function readme(c: ContainerConfig): string {
  const text = readmeFull(c);
  return usesExistingImage(c) ? `${text.split('## Before you build')[0]!.trimEnd()}\n` : text;
}

function readmeFull(c: ContainerConfig): string {
  const secretNames = secrets(c).map((v) => v.key);
  return `# ${c.appName}

Generated by CloudCraft Container Templates (${usesExistingImage(c) ? 'a ready-made image' : STACK_LABEL[c.stack]}).

## Run locally

\`\`\`bash
cp .env.example .env   # fill in the blank values${secretNames.length ? ` (${secretNames.join(', ')})` : ''}
docker compose up --build
\`\`\`

The service listens on ${c.proxy ? `https://${c.proxyDomain}${c.healthPath} (through the Caddy proxy; the app itself is not published)` : `http://localhost:${c.port}${c.healthPath}`}.

## ${usesExistingImage(c) ? 'Run the image alone' : 'Build and run the image alone'}

\`\`\`bash
${usesExistingImage(c) ? '' : `docker build -t ${c.appName} .\n`}docker run --rm -p ${c.port}:${c.port} --env-file .env ${usesExistingImage(c) ? c.image : c.appName}
\`\`\`

## What is configured

- ${usesExistingImage(c) ? `Image: \`${c.image}\` (used as it is: nothing is built here)` : `Runtime: ${c.stack === 'static' ? `nginx ${c.version}` : `${STACK_LABEL[c.stack]} ${c.version}`}`}
- Port: ${c.port}, health check: \`${c.healthPath}\`
- Runs as ${c.runAsNonRoot ? 'a non-root user' : 'root (not recommended)'}
- Limits: ${c.memoryLimit} memory, ${c.cpuLimit} CPU, restart \`${c.restart}\`
${c.postgres ? '- PostgreSQL 16 (set POSTGRES_PASSWORD in .env; the app gets DATABASE_URL)\n' : ''}${c.redis ? '- Redis 7 (the app gets REDIS_URL)\n' : ''}${c.mysql ? '- MySQL 8.4 (set MYSQL_PASSWORD in .env; the app gets MYSQL_URL)\n' : ''}${c.mongodb ? '- MongoDB 7 (set MONGODB_PASSWORD in .env; the app gets MONGODB_URL)\n' : ''}${c.rabbitmq ? '- RabbitMQ 3.13 (set RABBITMQ_PASSWORD in .env; the app gets RABBITMQ_URL)\n' : ''}${c.proxy ? `- Caddy reverse proxy: HTTPS on ports 80 and 443 for \`${c.proxyDomain}\`${c.proxyDomain === 'localhost' ? ' (a local certificate; run `docker compose exec proxy caddy trust` to stop the browser warning)' : ' (a free Let\'s Encrypt certificate: the domain must point at this machine and ports 80 and 443 must be open)'}\n` : ''}${companionServices(c).length || c.proxy ? '\nUse passwords without special characters (or URL-encode them): they are placed inside connection URLs. The databases are not published to the host.\n' : ''}
${c.stack === 'node' ? `## Before you build\n\nYour project needs a ${c.packageManager === 'npm' ? 'package-lock.json' : c.packageManager === 'yarn' ? 'yarn.lock' : 'pnpm-lock.yaml'}.${c.nextStandalone ? ' Set \`output: "standalone"\` in next.config.' : ''}\n` : ''}${c.stack === 'python' ? '## Before you build\n\nYour project needs a requirements.txt' + (c.pythonFramework === 'fastapi' ? ' that includes uvicorn.' : c.pythonFramework === 'other' ? '.' : ' that includes gunicorn.') + '\n' : ''}${c.stack === 'go' ? `## Before you build\n\nYour project needs a go.mod (and go.sum). \`${c.goPackage}\` must be the main package; the program must listen on the PORT environment variable (${c.port}).\n` : ''}${c.stack === 'dotnet' ? `## Before you build\n\nYour project needs \`${c.dotnetProject}\`, and its assembly must be named \`${c.dotnetAssembly}\` (set <AssemblyName> in the project file). ASP.NET Core listens on port ${c.port} through ASPNETCORE_URLS.\n` : ''}${c.stack === 'ruby' ? `## Before you build\n\nYour project needs a Gemfile (and Gemfile.lock)${c.rubyFramework === 'rack' ? ', a config.ru, and a web server gem such as puma' : c.rubyFramework === 'rails' ? '. Rails 7.1+ answers a health check on /up: set the health check path to it' : ''}.\n` : ''}${c.stack === 'java' ? `## Before you build\n\nYour project needs a Spring Boot ${c.javaBuildTool === 'maven' ? 'pom.xml' : 'build.gradle with the bootJar task'}. The health check path needs Spring Actuator (\`spring-boot-starter-actuator\`).\n` : ''}`;
}

// ─── entry point ─────────────────────────────────────────────────────────────

export function generateContainerFiles(config: ContainerConfig): GenerateResult {
  const errors = validate(config);
  if (errors.length > 0) return { ok: false, errors };
  const c = config;
  const existing = usesExistingImage(c);
  const dockerfile = existing ? '' : ({ node: nodeDockerfile, python: pythonDockerfile, java: javaDockerfile, go: goDockerfile, dotnet: dotnetDockerfile, ruby: rubyDockerfile, static: staticDockerfile } as const)[c.stack](c);
  const sample = existing ? { files: [], warnings: [] } : generateSampleApp(c);
  const files: GeneratedFile[] = [
    ...(existing ? [] : [{ path: 'Dockerfile', content: dockerfile }, { path: '.dockerignore', content: dockerignore(c) }]),
    { path: 'docker-compose.yml', content: compose(c) },
    { path: '.env.example', content: envExample(c) },
    ...(c.stack === 'static' && !existing ? [{ path: 'nginx.conf', content: nginxConf(c) }] : []),
    ...(c.proxy ? [{ path: 'Caddyfile', content: caddyfile(c) }] : []),
    { path: 'README.md', content: readme(c) },
    ...generateEc2Files(c),
    ...generateEcsFiles(c),
    ...generateAcaFiles(c),
    ...generateK8sFiles(c),
    ...generateAzVmFiles(c),
    ...generateAksFiles(c),
    ...sample.files,
  ];
  return { ok: true, files, warnings: [...sample.warnings, ...(existing && imageIsFloating(c.image) ? ['The image has no version tag (or uses :latest). A version tag, or a digest, makes it clear what is running and allows a rollback.'] : []), ...(c.proxy && deployTargets(c).length > 0 ? ['The HTTPS proxy is part of docker-compose.yml only. The deployment target has its own way to serve HTTPS (a load balancer certificate, the ingress, or the platform).'] : []), ...ec2Warnings(c), ...ecsWarnings(c), ...acaWarnings(c), ...k8sWarnings(c), ...azVmWarnings(c), ...aksWarnings(c)], findings: checkContainer(c, files), cost: estimateEc2Cost(c) ?? estimateEcsCost(c) ?? estimateAcaCost(c) ?? estimateAzVmCost(c) ?? estimateAksCost(c) };
}

// ─── starter templates ───────────────────────────────────────────────────────

export interface StarterTemplate { id: string; title: string; blurb: string; /** The starter with a one-command deployment to the chosen target (EC2 when none is given). */ config: (target?: DeployTarget) => ContainerConfig }

const starter = (stack: ContainerStack, appName: string, over: Partial<ContainerConfig> = {}, target: DeployTarget = 'ec2'): ContainerConfig => {
  const d = defaultConfig(stack);
  return withDeployTarget({ ...d, appName, includeSample: true, ...over }, target);
};

/** Ready-made starting points: a stack, a working sample app and a deployment (EC2 unless another target is given) already switched on. */
export const STARTER_TEMPLATES: StarterTemplate[] = [
  { id: 'node-web', title: 'Node.js web app', blurb: 'A small Node.js server with a health check.', config: (t) => starter('node', 'node-web', {}, t) },
  { id: 'fastapi-api', title: 'FastAPI service', blurb: 'A Python FastAPI API with /health.', config: (t) => starter('python', 'fastapi-api', { healthPath: '/health' }, t) },
  { id: 'spring-boot', title: 'Spring Boot service', blurb: 'A minimal Spring Boot app with Actuator health.', config: (t) => starter('java', 'spring-boot', { memoryLimit: '768m' }, t) },
  { id: 'go-api', title: 'Go service', blurb: 'A small Go HTTP service built into a tiny image.', config: (t) => starter('go', 'go-api', {}, t) },
  { id: 'dotnet-api', title: 'ASP.NET Core service', blurb: 'A minimal ASP.NET Core API with /health.', config: (t) => starter('dotnet', 'dotnet-api', { healthPath: '/health', memoryLimit: '768m' }, t) },
  { id: 'ruby-rack', title: 'Ruby Rack service', blurb: 'A small Rack app served by Puma.', config: (t) => starter('ruby', 'ruby-rack', {}, t) },
  { id: 'static-site', title: 'Static website', blurb: 'A one-page website served by nginx.', config: (t) => starter('static', 'static-site', {}, t) },
];

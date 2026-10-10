/**
 * ApiTerraformService — HTTP-backed implementation of ITerraformService.
 *
 * Replaces MockTerraformService with real API-backed Terraform generation.
 * The interface is IDENTICAL to ITerraformService — no frontend changes required.
 *
 * Calls:
 *   POST /api/projects/:id/terraform  — generates Terraform from persisted arch
 *
 * NOTE: The synchronous generateMain/generateFiles methods maintain backward
 * compatibility with the existing TerraformPanel UI. The API methods are
 * async, so this service provides both:
 *   - synchronous fallback (local generation using the existing analysis.ts logic)
 *   - async API method (generateFromApi) for programmatic callers
 */
import type { ITerraformService } from './TerraformService';
import type { CanvasNode, CanvasEdge } from '@/types';
import { generateTerraform } from '@/lib/analysis';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';

// ─── API helpers ─────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

interface ApiSuccess<T> { ok: true; data: T }
interface ApiError { ok: false; error: { code: string; message: string } }
type ApiEnvelope<T> = ApiSuccess<T> | ApiError;

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  });
  const envelope = (await res.json()) as ApiEnvelope<T>;
  if (!envelope.ok) {
    throw new Error(`API ${path} → ${envelope.error.code}: ${envelope.error.message}`);
  }
  return envelope.data;
}

// ─── Response types ───────────────────────────────────────────────────────────

export interface TerraformApiResponse {
  generationId: string | null;
  architectureId: string;
  files: Array<{ filename: string; content: string; provider: string }>;
  warnings: string[];
  resourceMap: Record<string, string>;
  providers: string[];
}

// ─── Active project registry ─────────────────────────────────────────────────

/** Module-level active project ID — set by AppContext when active project changes */
let _activeProjectId: string | null = null;
let _activeEnvironment = 'production';
let _lastWarnings: string[] = [];

/**
 * Set the active project ID so the API service can scope its requests correctly.
 * Called by AppContext whenever the active project changes — no localStorage needed.
 */
export function setActiveProjectId(id: string | null): void {
  _activeProjectId = id;
}

export function setActiveEnvironment(env: string): void {
  _activeEnvironment = env;
}

// ─── ApiTerraformService ──────────────────────────────────────────────────────

class ApiTerraformServiceImpl implements ITerraformService {

  /**
   * Synchronous generation — delegates to the existing local analysis.ts logic.
   * Used by TerraformPanel which calls this synchronously.
   */
  generateMain(nodes: CanvasNode[], edges: CanvasEdge[], provider: string): string {
    if (provider === 'multi') {
      const awsNodes   = nodes.filter((n) => n.provider === 'aws');
      const azureNodes = nodes.filter((n) => n.provider === 'azure');
      return [
        generateTerraform(awsNodes, edges, 'aws'),
        '\n# ─── Azure Resources ──────────────────────────────────────\n',
        generateTerraform(azureNodes, edges, 'azure'),
      ].join('\n');
    }
    return generateTerraform(nodes, edges, provider);
  }

  /**
   * Synchronous multi-file generation using the full TerraformGenerator engine.
   * Generates exact, relationship-aware Terraform HCL from live canvas graph.
   */
  generateFiles(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    provider: string,
    projectName = 'cloudcraft-infra'
  ): Record<string, string> {
    try {
      const resources = nodes.map((n) => ({
        id: n.id,
        resourceType: n.resourceType,
        provider: n.provider || (n.resourceType.startsWith('azure_') ? 'azure' : 'aws'),
        label: n.label,
        positionX: n.position.x,
        positionY: n.position.y,
        configJson: JSON.stringify(n.config || {}),
        region: n.region || null,
        groupId: n.groupId || null,
        locked: !!n.locked,
        architectureId: 'live-draft',
      }));
      const connections = edges.map((e) => ({
        id: e.id,
        sourceId: e.source,
        targetId: e.target,
        label: e.label || null,
        edgeType: (e.relationshipType || e.edgeType || 'network') as string,
        architectureId: 'live-draft',
      }));
      const res = terraformGenerator.generate({
        architectureId: 'live-draft',
        projectId: _activeProjectId || 'draft-project',
        resources: resources as any,
        connections: connections as any,
        projectName,
      });
      const result: Record<string, string> = {};
      for (const f of res.files) {
        result[f.filename] = f.content;
      }
      _lastWarnings = res.warnings;
      return result;
    } catch (err) {
      console.warn('TerraformGenerator fallback to legacy generator:', err);
      _lastWarnings = ['Full TerraformGenerator engine failed — showing output from the legacy generator, which cannot detect unsupported resource types or missing containment.'];
      return {
        'main.tf':          this.generateMain(nodes, edges, provider),
        'providers.tf':     this._providers(provider),
        'variables.tf':     this._variables(provider),
        'outputs.tf':       this._outputs(nodes),
        'terraform.tfvars': this._tfvars(provider),
      };
    }
  }

  /** Same as generateFiles but also returns the generator's warnings (unsupported types, missing containment, etc). */
  generateFilesWithWarnings(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    provider: string,
    projectName = 'cloudcraft-infra'
  ): { files: Record<string, string>; warnings: string[] } {
    const files = this.generateFiles(nodes, edges, provider, projectName);
    return { files, warnings: _lastWarnings };
  }

  /**
   * Async API-backed Terraform generation from persisted architecture.
   * Uses the active project ID set by AppContext (no argument required from UI).
   */
  async generateFromApi(projectId?: string, env?: string): Promise<TerraformApiResponse> {
    const id = projectId ?? _activeProjectId;
    if (!id) {
      throw new Error('No active project context');
    }
    const targetEnv = env ?? _activeEnvironment;
    return await apiFetch<TerraformApiResponse>(
      `/api/projects/${id}/terraform`,
      {
        method: 'POST',
        body: JSON.stringify({ env: targetEnv }),
      },
    );
  }

  /**
   * Async API-backed multi-file generation.
   * Returns Record<filename, content> keyed by filename for the TerraformPanel UI.
   */
  async generateFilesFromApi(env?: string): Promise<Record<string, string>> {
    const { files } = await this.generateFilesFromApiWithWarnings(env);
    return files;
  }

  /** Same as generateFilesFromApi but also returns the server-computed warnings. */
  async generateFilesFromApiWithWarnings(env?: string): Promise<{ files: Record<string, string>; warnings: string[] }> {
    const targetEnv = env ?? _activeEnvironment;
    const response = await this.generateFromApi(undefined, targetEnv);
    if (!response || !response.files || response.files.length === 0) {
      throw new Error('No Terraform files returned from server');
    }
    const result: Record<string, string> = {};
    for (const f of response.files) {
      result[f.filename] = f.content;
    }
    return { files: result, warnings: response.warnings ?? [] };
  }

  // ── Local generation helpers (backward compat) ────────────────────────────

  private _providers(provider: string): string {
    const aws = `terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}`;

    const azure = `terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}`;

    if (provider === 'multi') return `${aws}\n\n${azure}`;
    if (provider === 'azure') return azure;
    return aws;
  }

  private _variables(provider: string): string {
    const common = `variable "environment" {
  type    = string
  default = "production"
}`;
    if (provider === 'aws' || provider === 'multi') {
      return `variable "aws_region" {
  type    = string
  default = "us-east-1"
}

${common}`;
    }
    return `variable "azure_location" {
  type    = string
  default = "eastus"
}

${common}`;
  }

  private _outputs(nodes: CanvasNode[]): string {
    const lines: string[] = [];
    for (const n of nodes) {
      const name = ((n.config['name'] as string) || n.label).replace(/\s+/g, '_').toLowerCase();
      if (n.resourceType === 'aws_alb') {
        lines.push(`output "${name}_dns" { value = aws_lb.${name}.dns_name }`);
      } else if (n.resourceType === 'aws_rds') {
        lines.push(`output "${name}_endpoint" { value = aws_db_instance.${name}.endpoint; sensitive = true }`);
      }
    }
    return lines.length ? lines.join('\n') : '# No outputs defined';
  }

  private _tfvars(provider: string): string {
    if (provider === 'azure') return `azure_location = "eastus"\nenvironment    = "production"`;
    return `aws_region  = "us-east-1"\nenvironment = "production"`;
  }
}

/** Extended interface that adds the async API methods beyond ITerraformService */
export interface IApiTerraformService extends ITerraformService {
  generateFromApi(projectId?: string, env?: string): Promise<TerraformApiResponse>;
  generateFilesFromApi(env?: string): Promise<Record<string, string>>;
  generateFilesFromApiWithWarnings(env?: string): Promise<{ files: Record<string, string>; warnings: string[] }>;
  generateFilesWithWarnings(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    provider: string,
    projectName?: string
  ): { files: Record<string, string>; warnings: string[] };
}

export const apiTerraformService: IApiTerraformService = new ApiTerraformServiceImpl();

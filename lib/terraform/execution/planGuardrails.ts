/**
 * Guardrails applied to the machine-readable plan (`terraform show -json`) BEFORE it can be approved or applied.
 *
 * The input checks in hclSafety.ts keep user text out of the generated code; these checks look at what Terraform would
 * actually do, so they still protect if something unexpected gets through:
 *
 *  - unexpected-types   only resource types CloudBuilder's generator can produce
 *  - iam-admin          no administrator-style IAM (`*` on `*`, AdministratorAccess)
 *  - public-exposure    no world-open admin ports, public databases or public buckets
 *  - region             provider region within CLOUDBUILDER_TERRAFORM_ALLOWED_REGIONS (when that is set)
 *  - size               no more than CLOUDBUILDER_TERRAFORM_MAX_RESOURCES creates/updates per run (default 200)
 *
 * Destroy actions are refused separately by the executor. The result is stored on the plan and shown to the approver.
 */
import { ALLOWED_TERRAFORM_RESOURCE_TYPES } from './allowedResourceTypes';

export interface PlanChangeForGuardrails {
  address: string;
  type: string;
  mode?: string;
  change: { actions: string[]; after?: Record<string, unknown> | null };
}

export interface PlanJsonForGuardrails {
  resource_changes?: PlanChangeForGuardrails[];
  configuration?: { provider_config?: Record<string, { expressions?: { region?: { constant_value?: unknown } } }> };
}

export interface GuardrailCheck { id: string; title: string; passed: boolean; details: string[] }
export interface GuardrailReport { passed: boolean; checks: GuardrailCheck[] }

export class PlanGuardrailError extends Error {
  constructor(public readonly report: GuardrailReport) {
    const failed = report.checks.filter((c) => !c.passed);
    super(`Plan blocked by safety checks: ${failed.map((c) => `${c.title} — ${c.details.slice(0, 3).join('; ')}${c.details.length > 3 ? ` (+${c.details.length - 3} more)` : ''}`).join(' | ')}`);
    this.name = 'PlanGuardrailError';
  }
}

export interface GuardrailOptions { maxResources?: number; allowedRegions?: string[] }

const envList = (name: string): string[] => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export function guardrailOptionsFromEnv(): GuardrailOptions {
  const max = Number(process.env.CLOUDBUILDER_TERRAFORM_MAX_RESOURCES);
  return { maxResources: Number.isFinite(max) && max > 0 ? max : 200, allowedRegions: envList('CLOUDBUILDER_TERRAFORM_ALLOWED_REGIONS') };
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const OPEN_ADMIN_PORTS = [22, 3389];

/** True when [from, to] includes one of the admin ports, or covers everything. */
function coversAdminPort(from: unknown, to: unknown): boolean {
  const f = Number(from); const t = Number(to);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return false;
  return OPEN_ADMIN_PORTS.some((p) => f <= p && p <= t);
}
const worldCidr = (v: unknown): boolean => asArray(v).some((c) => c === '0.0.0.0/0' || c === '::/0');

/** Detail lines for ingress rules that expose admin ports (or everything) to the whole internet. */
function openIngress(rule: Record<string, unknown>): boolean {
  const open = worldCidr(rule['cidr_blocks']) || worldCidr(rule['ipv6_cidr_blocks']) || worldCidr(rule['cidr_ipv4']) || worldCidr(rule['cidr_ipv6']);
  if (!open) return false;
  if (String(rule['protocol'] ?? rule['ip_protocol'] ?? '') === '-1') return true;
  return coversAdminPort(rule['from_port'], rule['to_port']);
}

function policyIsAdmin(policy: unknown): boolean {
  let doc: unknown = policy;
  if (typeof policy === 'string') { try { doc = JSON.parse(policy); } catch { return false; } }
  const statements = asArray(asRecord(doc)['Statement']).map(asRecord);
  return statements.some((s) => s['Effect'] === 'Allow' && asArray(s['Action']).includes('*') && asArray(s['Resource']).includes('*'));
}

export function evaluatePlanGuardrails(plan: PlanJsonForGuardrails, options: GuardrailOptions = guardrailOptionsFromEnv()): GuardrailReport {
  const changes = (plan.resource_changes ?? []).filter((rc) => (rc.mode ?? 'managed') === 'managed' && !(rc.change.actions.length === 1 && (rc.change.actions[0] === 'no-op' || rc.change.actions[0] === 'read')));
  const check = (id: string, title: string, details: string[]): GuardrailCheck => ({ id, title, passed: details.length === 0, details });

  // 1. Only resource types the generator can produce.
  const unexpected = changes.filter((rc) => !ALLOWED_TERRAFORM_RESOURCE_TYPES.has(rc.type)).map((rc) => `${rc.address} (${rc.type})`);

  // 2. Administrator-style IAM.
  const iam: string[] = [];
  for (const rc of changes) {
    const after = asRecord(rc.change.after);
    if (/^aws_iam_(role_|user_|group_)?policy$/.test(rc.type) && policyIsAdmin(after['policy'])) iam.push(`${rc.address} allows every action on every resource`);
    if (/^aws_iam_(role|user|group)_policy_attachment$/.test(rc.type) && /[:/]AdministratorAccess$/.test(String(after['policy_arn'] ?? ''))) iam.push(`${rc.address} attaches AdministratorAccess`);
    if (rc.type === 'azurerm_role_assignment' && ['Owner', 'User Access Administrator'].includes(String(after['role_definition_name'] ?? ''))) iam.push(`${rc.address} grants ${String(after['role_definition_name'])}`);
  }

  // 3. Public exposure.
  const exposure: string[] = [];
  for (const rc of changes) {
    const after = asRecord(rc.change.after);
    if (rc.type === 'aws_security_group') {
      for (const rule of asArray(after['ingress']).map(asRecord)) if (openIngress(rule)) exposure.push(`${rc.address} opens ${String(rule['protocol']) === '-1' ? 'all ports' : `ports ${String(rule['from_port'])}-${String(rule['to_port'])}`} to the internet`);
    }
    if (rc.type === 'aws_security_group_rule' && after['type'] === 'ingress' && openIngress(after)) exposure.push(`${rc.address} opens an admin port or all ports to the internet`);
    if (rc.type === 'aws_vpc_security_group_ingress_rule' && openIngress(after)) exposure.push(`${rc.address} opens an admin port or all ports to the internet`);
    if (rc.type === 'aws_db_instance' && after['publicly_accessible'] === true) exposure.push(`${rc.address} is publicly accessible`);
    if (rc.type === 'aws_s3_bucket_acl' && /^public-read/.test(String(after['acl'] ?? ''))) exposure.push(`${rc.address} makes the bucket public`);
    if (rc.type === 'aws_s3_bucket_public_access_block' && ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets'].some((k) => after[k] === false)) exposure.push(`${rc.address} turns off S3 Block Public Access`);
    if (rc.type === 'azurerm_network_security_rule' || rc.type === 'azurerm_network_security_group') {
      const rules = rc.type === 'azurerm_network_security_group' ? asArray(after['security_rule']).map(asRecord) : [after];
      for (const r of rules) {
        const source = String(r['source_address_prefix'] ?? '');
        const port = String(r['destination_port_range'] ?? '');
        if (r['direction'] === 'Inbound' && r['access'] === 'Allow' && ['*', 'Internet', '0.0.0.0/0'].includes(source) && (port === '*' || OPEN_ADMIN_PORTS.map(String).includes(port))) exposure.push(`${rc.address} allows inbound ${port} from the internet`);
      }
    }
    if (rc.type === 'azurerm_storage_account' && after['allow_nested_items_to_be_public'] === true) exposure.push(`${rc.address} allows public blob access`);
  }

  // 4. Region (only when the operator configured a list).
  const region: string[] = [];
  const allowed = options.allowedRegions ?? [];
  if (allowed.length > 0) {
    for (const [name, cfg] of Object.entries(plan.configuration?.provider_config ?? {})) {
      const value = cfg.expressions?.region?.constant_value;
      if (typeof value !== 'string') { if (name === 'aws') region.push(`provider "${name}" region could not be verified`); continue; }
      if (!allowed.includes(value)) region.push(`provider "${name}" uses ${value}, which is not in the allowed regions`);
    }
  }

  // 5. Size.
  const touched = changes.filter((rc) => rc.change.actions.some((a) => a === 'create' || a === 'update')).length;
  const max = options.maxResources ?? 200;
  const size = touched > max ? [`${touched} resources would be created or changed; the limit is ${max}`] : [];

  const checks = [
    check('unexpected-types', 'Only resource types CloudBuilder generates', unexpected),
    check('iam-admin', 'No administrator-style IAM', iam),
    check('public-exposure', 'No public admin ports, databases or buckets', exposure),
    check('region', 'Allowed regions only', region),
    check('size', 'Within the resource limit', size),
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

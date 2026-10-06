import type { SpecIssue } from './architectureSpec';
import { allResources, getResourceDefinition } from '@/lib/resources';
import { ALL_RULES } from '@/lib/engines/assessment/rules';

/**
 * The parser says a setting does not exist but not which ones do, so a model that guesses
 * snake_case names (cidr_block) repeats the same mistake on every retry. Collapse those issues per
 * (type, wrong key) and list the real setting names, which lets the repair loop actually converge.
 */
export function withSettingHints(issues: SpecIssue[]): SpecIssue[] {
  const grouped = new Map<string, { type: string; key: string; ids: string[] }>();
  const rest: SpecIssue[] = [];
  for (const issue of issues) {
    const m = issue.code === 'UNKNOWN_CONFIG_KEY' ? /\(([a-z0-9_]+)\) has no setting "([^"]+)"/.exec(issue.message) : null;
    if (!m) { rest.push(issue); continue; }
    const k = `${m[1]}|${m[2]}`;
    const g = grouped.get(k) ?? { type: m[1]!, key: m[2]!, ids: [] };
    if (issue.resourceId) g.ids.push(issue.resourceId);
    grouped.set(k, g);
  }
  const hinted = [...grouped.values()].map((g): SpecIssue => {
    const valid = (getResourceDefinition(g.type)?.configSchema ?? []).map((f) => f.key);
    return {
      code: 'UNKNOWN_CONFIG_KEY',
      message: `${g.type} has no setting "${g.key}" (on: ${g.ids.join(', ')}). Valid settings for ${g.type}: ${valid.join(', ') || 'none — omit config'}. Setting names are camelCase; omit any setting you do not need to change.`,
    };
  });
  return [...hinted, ...rest];
}

/**
 * "aws_vpc cannot contain aws_ecs" tells the model it is wrong but not where the resource belongs.
 * Append the container types that ARE allowed to hold it (or say it takes no parent).
 */
export function withContainmentHints(issues: SpecIssue[]): SpecIssue[] {
  return issues.map((issue) => {
    if (/which cannot contain resources.$/.test(issue.message)) {
      const containers = allResources.filter((r) => r.isContainer).map((r) => r.type);
      return { ...issue, message: `${issue.message} Only these types may be a "parent": ${containers.join(', ')}. Never use any other resource (load balancer, WAF, database, compute…) as a parent — attach it to the container its containment rule names, or omit "parent".` };
    }
    const m = /^([a-z0-9_]+) cannot contain ([a-z0-9_]+).$/.exec(issue.message);
    if (!m) return issue;
    const child = m[2]!;
    const parents = allResources.filter((r) => r.isContainer && r.allowedChildren?.includes(child)).map((r) => r.type);
    const where = parents.length ? `${child} must be placed inside one of: ${parents.join(', ')}` : `${child} has no container — omit "parent" for it`;
    return { ...issue, message: `${issue.message} ${where}.` };
  });
}

/**
 * An assessment finding such as "MEDIUM AWS-ELB-003: Internet-facing Application Load Balancer has no AWS WAF web ACL (API ALB)" says WHAT is
 * wrong; the rule itself already knows HOW to fix it. Append its remediation (and the Terraform setting it maps to), so the model
 * changes the right thing instead of guessing.
 */
export function withRuleHints(issues: SpecIssue[]): SpecIssue[] {
  return issues.map((issue) => {
    const id = /\b([A-Z]{2,4}-[A-Z0-9]+-\d{3})\b/.exec(issue.message)?.[1];
    const rule = id ? ALL_RULES.find((r) => r.id === id) : undefined;
    if (!rule || issue.message.includes(' How to fix: ')) return issue;
    const steps = rule.remediation.manualSteps?.length ? ` Steps: ${rule.remediation.manualSteps.join(' ')}` : '';
    const tf = rule.remediation.terraform ? ` (Terraform: ${rule.remediation.terraform})` : '';
    return { ...issue, message: `${issue.message} How to fix: ${rule.remediation.recommendation}${tf}${steps}` };
  });
}

/**
 * Connectivity problems come as one line per resource. Name the rule that settles all of them: every resource is connected from
 * the entry point, caller to callee.
 */
export function withConnectivityHints(issues: SpecIssue[]): SpecIssue[] {
  const loose = issues.filter((i) => i.code === 'CONNECTIVITY');
  if (loose.length === 0) return issues;
  const hint: SpecIssue = { code: 'CONNECTIVITY', message: 'Connection rule: every resource must be reachable from the entry point through connections drawn from caller to callee. Connect DNS → CDN/load balancer, WAF → the load balancer or CDN it protects, internet gateway → load balancer, NAT gateway → internet gateway, load balancer → each service or Auto Scaling group, compute → database / cache / queue / bucket, and each security group or NSG to the one resource or subnet it protects.' };
  return [...issues, hint];
}

export function withHints(issues: SpecIssue[]): SpecIssue[] {
  return withConnectivityHints(withRuleHints(withContainmentHints(withSettingHints(issues))));
}

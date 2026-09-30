import type { SpecIssue } from './architectureSpec';
import { allResources, getResourceDefinition } from '@/lib/resources';

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

export function withHints(issues: SpecIssue[]): SpecIssue[] {
  return withContainmentHints(withSettingHints(issues));
}

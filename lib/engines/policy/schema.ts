/**
 * Validation of an organization policy submitted by a client or read back from storage.
 *
 * The limits keep a policy small enough to evaluate on every canvas change, and the naming pattern must compile — an administrator
 * can never save a pattern that would silently match nothing.
 */
import { z } from 'zod';
import { EMPTY_POLICY_RULES, type OrgPolicyRules } from './types';

const MAX_LIST = 100;

const shortText = (max: number) => z.string().trim().min(1).max(max);

const TagRequirementSchema = z.object({
  key: shortText(128),
  allowedValues: z.array(shortText(256)).max(MAX_LIST).optional(),
});

export const OrgPolicyRulesSchema = z.object({
  approvedRegions: z.array(shortText(64)).max(MAX_LIST),
  allowedInstanceTypes: z.array(shortText(64)).max(MAX_LIST),
  requiredTags: z.array(TagRequirementSchema).max(MAX_LIST),
  namingPattern: z.string().trim().max(200).refine(isValidPattern, 'The naming pattern is not a valid regular expression'),
}).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  rules.requiredTags.forEach((t, i) => {
    if (seen.has(t.key)) ctx.addIssue({ code: 'custom', path: ['requiredTags', i, 'key'], message: `Tag "${t.key}" is listed twice` });
    seen.add(t.key);
  });
});

function isValidPattern(pattern: string): boolean {
  if (pattern === '') return true;
  try { new RegExp(pattern); return true; } catch { return false; }
}

/** Drop repeated entries so the same region or size is never listed twice. */
export function normalizeRules(rules: OrgPolicyRules): OrgPolicyRules {
  const unique = (list: string[]) => [...new Set(list)];
  return {
    approvedRegions: unique(rules.approvedRegions),
    allowedInstanceTypes: unique(rules.allowedInstanceTypes),
    requiredTags: rules.requiredTags.map((t) => (t.allowedValues ? { key: t.key, allowedValues: unique(t.allowedValues) } : { key: t.key })),
    namingPattern: rules.namingPattern,
  };
}

/** Parse stored JSON into rules, falling back to "no restriction" for anything unreadable (a bad row must never break the canvas). */
export function parseStoredRules(json: string | null | undefined): OrgPolicyRules {
  if (!json) return { ...EMPTY_POLICY_RULES };
  try {
    const parsed = OrgPolicyRulesSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : { ...EMPTY_POLICY_RULES };
  } catch {
    return { ...EMPTY_POLICY_RULES };
  }
}

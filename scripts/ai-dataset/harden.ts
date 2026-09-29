/**
 * Greenfield hardening. For a NEW design, the "review required" gate on some fixes exists
 * because changing a deployed resource can interrupt it — that does not apply before
 * anything is deployed. So the dataset builder applies every LOW-severity finding whose fix
 * CloudCraft can verify end to end (rule re-run passes, no new HIGH/CRITICAL finding,
 * Terraform renders the change), and writes the resulting settings back into the spec so the
 * model's target is explicit and self-contained.
 *
 * MEDIUM and above are deliberately NOT auto-fixed: those indicate a blueprint mistake and
 * must surface as a gate failure rather than be silently patched.
 */
import type { CanvasNode } from '@/types';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { applyAutoFix } from '@/lib/engines/assessment/autofix';
import { getResourceDefinition } from '@/lib/resources';
import { compileSpec, type ArchitectureSpec, type SpecResource } from '@/lib/ai/architectureSpec';

export interface HardenResult { spec: ArchitectureSpec; applied: { ruleId: string; resource: string }[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function hardenSpec(spec: ArchitectureSpec): HardenResult {
  const compiled = compileSpec(spec);
  if (compiled.issues.length) return { spec, applied: [] };
  let nodes = compiled.nodes; const edges = compiled.edges;
  const applied: HardenResult['applied'] = [];

  const initial = runAssessment({ nodes, edges }).findings.filter((f) => f.severity === 'LOW' && f.autoFix.available && f.autoFix.safety !== 'MANUAL_ONLY');
  for (const f of initial) {
    const r = applyAutoFix(nodes, edges, f.findingId, { confirmed: true });
    if (r.status === 'RESOLVED') { nodes = r.nodes; applied.push({ ruleId: f.ruleId, resource: f.resourceLabels[0] ?? '' }); }
  }
  if (!applied.length) return { spec, applied };

  const before = new Map(compiled.nodes.map((n) => [n.id, n]));
  const resources: SpecResource[] = spec.resources.map((res) => {
    const a = before.get(res.id); const z = nodes.find((n) => n.id === res.id);
    if (!a || !z) return res;
    const delta: Record<string, string | number | boolean | string[]> = {};
    for (const [k, v] of Object.entries(z.config ?? {})) {
      if (k === 'importState' || k === 'imported') continue;
      if (same(a.config?.[k], v)) continue;
      // Select options are declared as strings; auto-fix may write the number (e.g. 60).
      const field = getResourceDefinition(res.type)?.configSchema.find((f) => f.key === k);
      const stringOptions = field?.type === 'select' && field.options?.every((o) => typeof o.value === 'string');
      delta[k] = stringOptions && typeof v !== 'string' ? String(v) : (v as string | number | boolean | string[]);
    }
    if (!Object.keys(delta).length) return res;
    return { ...res, config: { ...(res.config ?? {}), ...delta } };
  });
  return { spec: { ...spec, resources }, applied };
}

export type { CanvasNode };

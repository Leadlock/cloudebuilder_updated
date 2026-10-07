/**
 * QA helper: generates Terraform for every built-in template and writes it to a folder, so `terraform fmt -check` and
 * `terraform validate` can be run on the real generator output.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/qa-terraform-templates.ts <output-folder>
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { architectureTemplates } from '@/lib/templates';
import { instantiateTemplate } from '@/lib/domain/instantiateTemplate';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

const out = process.argv[2];
if (!out) { console.error('Usage: qa-terraform-templates.ts <output-folder>'); process.exit(2); }

for (const template of architectureTemplates) {
  try {
    const { nodes, edges } = instantiateTemplate(template);
    const resources = nodes.map((n): DbArchitectureResource => ({
      id: n.id, resourceType: n.resourceType, provider: n.provider as string, label: n.label, positionX: n.position?.x ?? 0, positionY: n.position?.y ?? 0,
      configJson: JSON.stringify(n.config ?? {}), region: (n.config?.['region'] as string) ?? null, groupId: n.groupId ?? null, locked: false, architectureId: `arch-${template.id}`,
    } as DbArchitectureResource));
    const connections = edges.map((e): DbArchitectureConnection => ({ id: e.id, label: (e as { label?: string }).label ?? null, edgeType: null, architectureId: `arch-${template.id}`, sourceId: e.source, targetId: e.target }));
    const result = terraformGenerator.generate({ architectureId: `arch-${template.id}`, projectId: `proj-${template.id}`, resources, connections, projectName: template.id });
    const dir = path.join(out, template.id);
    mkdirSync(dir, { recursive: true });
    for (const f of result.files) writeFileSync(path.join(dir, f.filename), f.content, 'utf8');
    console.log(`${template.id}\t${template.provider}\t${nodes.length} nodes\t${result.files.length} files\twarnings=${result.warnings.length}\tblocking=${(result.blocking ?? []).length}`);
  } catch (err) {
    console.log(`${template.id}\tGENERATION FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

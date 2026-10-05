/**
 * Generates Terraform from a saved canvas JSON ({ nodes, edges }) and prints main.tf, the warnings and any blocking problems.
 * For reviewing what a plan would contain without running it:  tsx scripts/gen-from-canvas.ts path/to/canvas.json
 */
import fs from 'fs';
import { terraformGenerator } from '../lib/engines/terraform/TerraformGenerator';

const file = process.argv[2];
if (!file) { console.error('usage: tsx scripts/gen-from-canvas.ts canvas.json'); process.exit(2); }
const canvas = JSON.parse(fs.readFileSync(file, 'utf8')) as {
  nodes: { id: string; resourceType: string; provider: string; label: string; config: Record<string, unknown>; groupId: string | null }[];
  edges: { id: string; source: string; target: string; label: string | null; edgeType: string | null }[];
};

const result = terraformGenerator.generate({
  architectureId: 'a', projectId: 'p', projectName: 'review',
  resources: canvas.nodes.map((n) => ({
    id: n.id, resourceType: n.resourceType, provider: n.provider, label: n.label, positionX: 0, positionY: 0,
    configJson: JSON.stringify(n.config), region: null, groupId: n.groupId, locked: false, architectureId: 'a',
  })),
  connections: canvas.edges.map((e) => ({ id: e.id, label: e.label, edgeType: e.edgeType, sourceId: e.source, targetId: e.target, architectureId: 'a' })),
});

for (const f of result.files) { console.log(`\n######## ${f.filename}\n${f.content}`); }
console.log('\n######## WARNINGS\n' + (result.warnings.join('\n') || '(none)'));
console.log('\n######## BLOCKING\n' + ((result.blocking ?? []).join('\n') || '(none)'));

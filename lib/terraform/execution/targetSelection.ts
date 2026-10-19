/**
 * "Deploy only these resources": turns the canvas resources a person picked into the Terraform addresses to give `terraform plan -target`.
 *
 * Terraform itself adds everything a target depends on (its VPC, subnet, security group...), so the plan lists exactly what would be created.
 * What it does not add is the parts that hang off the resource and exist only for it (an S3 bucket's public-access block, a database's subnet group,
 * an instance's security group rules). CloudBuilder names those after the resource (`name`, `name_something`), so they are included here: a bucket
 * deployed alone must not lose its protections.
 */
import type { TerraformGenerationResult } from '@/lib/engines/terraform/TerraformGenerator';

export const MAX_TARGETS = 25;

export type TargetSelection = { addresses: string[]; error?: undefined } | { addresses?: undefined; error: string };

const RESOURCE_BLOCK = /^resource\s+"([A-Za-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"/gm;
/** What may reach Terraform's command line: an address of a resource we generated, nothing else. */
const SAFE_ADDRESS = /^[A-Za-z0-9_]+\.[A-Za-z0-9_-]+$/;

/** The label of a managed resource's address (`aws_s3_bucket.logs` gives `logs`), or null for a data source or a shape we do not know. */
function labelOf(address: string): string | null {
  if (address.startsWith('data.')) return null;
  const m = /^[A-Za-z0-9_]+\.([A-Za-z0-9_-]+)$/.exec(address);
  return m ? m[1]! : null;
}

export function selectTargets(generated: Pick<TerraformGenerationResult, 'files' | 'resourceMap'>, nodeIds: string[], labelOfNode: (id: string) => string): TargetSelection {
  const ids = [...new Set(nodeIds)];
  if (ids.length === 0) return { error: 'Pick at least one resource to deploy.' };
  if (ids.length > MAX_TARGETS) return { error: `Pick at most ${MAX_TARGETS} resources at a time, or deploy everything.` };

  // Every resource block that was generated: type.label.
  const blocks: string[] = [];
  for (const f of generated.files) {
    if (!f.filename.endsWith('.tf')) continue;
    for (const m of f.content.matchAll(RESOURCE_BLOCK)) blocks.push(`${m[1]}.${m[2]}`);
  }
  // The primary label of every resource on the canvas, so a block named after one resource is never given to another whose name is a prefix of it.
  const primaryLabels = Object.values(generated.resourceMap).map(labelOf).filter((l): l is string => !!l);
  const ownerOf = (blockLabel: string): string | null => {
    let best: string | null = null;
    for (const l of primaryLabels) if ((blockLabel === l || blockLabel.startsWith(`${l}_`)) && (best === null || l.length > best.length)) best = l;
    return best;
  };

  const addresses = new Set<string>();
  for (const id of ids) {
    const address = generated.resourceMap[id];
    const label = address ? labelOf(address) : null;
    if (!address) return { error: `"${labelOfNode(id)}" is not something CloudBuilder creates, so there is nothing to deploy for it.` };
    if (!label) return { error: `"${labelOfNode(id)}" is an existing resource that was imported, not created here, so there is nothing to deploy for it.` };
    if (!SAFE_ADDRESS.test(address)) return { error: `"${labelOfNode(id)}" cannot be deployed on its own.` };
    addresses.add(address);
    for (const b of blocks) {
      const blockLabel = b.slice(b.indexOf('.') + 1);
      if (ownerOf(blockLabel) === label && SAFE_ADDRESS.test(b)) addresses.add(b);
    }
  }
  return { addresses: [...addresses].sort() };
}

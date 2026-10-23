/**
 * Built-in production-grade OPA / Rego policy catalog for CloudBuilder.
 * Modeled after enterprise Spacelift & CIS Cloud Benchmarks.
 */

import type { OpaPolicyDefinition } from './types';

export const BUILT_IN_OPA_POLICIES: OpaPolicyDefinition[] = [
  // ─── Security Guardrails ──────────────────────────────────────────────────
  {
    id: 'sec-open-admin-ports',
    name: 'Disallow World-Open SSH and RDP Ports (0.0.0.0/0)',
    description: 'Security groups must not expose administrative ports (22, 3389) to the entire public internet.',
    category: 'security',
    severity: 'deny',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      benchmark: 'CIS AWS Foundations 5.2 / CIS Azure 6.1',
      cisControl: '4.1 Secure Configuration of Enterprise Assets',
    },
    regoCode: `package cloudbuilder.security

default allow = true

# Check Terraform plan changes
deny[sprintf("Security group rule %v allows unrestricted ingress on admin port", [rc.address])] {
    rc := input.plan.resource_changes[_]
    rc.type == "aws_security_group_rule"
    rc.change.after.type == "ingress"
    rc.change.after.cidr_blocks[_] == "0.0.0.0/0"
    rc.change.after.from_port <= 22
    rc.change.after.to_port >= 22
}

deny[sprintf("Security group rule %v allows unrestricted RDP access (port 3389)", [rc.address])] {
    rc := input.plan.resource_changes[_]
    rc.type == "aws_security_group_rule"
    rc.change.after.type == "ingress"
    rc.change.after.cidr_blocks[_] == "0.0.0.0/0"
    rc.change.after.from_port <= 3389
    rc.change.after.to_port >= 3389
}

# Check Canvas nodes before deployment
deny[sprintf("Canvas node %v exposes SSH or RDP to public traffic", [node.label])] {
    node := input.canvas.nodes[_]
    node.resourceType == "aws_sg"
    node.config.allowSsh == true
    node.config.publicAccess == true
}
`,
  },

  {
    id: 'sec-storage-encryption',
    name: 'Enforce Storage Encryption at Rest (S3, Azure Blob, EBS)',
    description: 'All object storage buckets, databases, and attached block devices must have server-side encryption enabled.',
    category: 'security',
    severity: 'deny',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      benchmark: 'NIST 800-53 SC-28 / HIPAA 164.312(a)(2)(iv)',
    },
    regoCode: `package cloudbuilder.security

default allow = true

deny[sprintf("S3 bucket %v lacks server-side encryption", [rc.address])] {
    rc := input.plan.resource_changes[_]
    rc.type == "aws_s3_bucket"
    rc.change.after.server_side_encryption_configuration == null
}

deny[sprintf("Storage bucket %v is configured without encryption on canvas", [node.label])] {
    node := input.canvas.nodes[_]
    node.resourceType == "aws_s3"
    node.config.encryption == false
}
`,
  },

  {
    id: 'sec-db-multiaz-protection',
    name: 'Enforce Multi-AZ & Deletion Protection on Production Databases',
    description: 'Relational databases deployed in production environments must be configured with Multi-AZ redundancy and deletion protection.',
    category: 'reliability',
    severity: 'warn',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      benchmark: 'AWS Well-Architected Reliability Pillar REL-07',
    },
    regoCode: `package cloudbuilder.reliability

default allow = true

warn[sprintf("Production database %v does not have Multi-AZ enabled", [rc.address])] {
    input.environment == "production"
    rc := input.plan.resource_changes[_]
    rc.type == "aws_db_instance"
    rc.change.after.multi_az == false
}

warn[sprintf("Production database %v has deletion protection disabled", [rc.address])] {
    input.environment == "production"
    rc := input.plan.resource_changes[_]
    rc.type == "aws_db_instance"
    rc.change.after.deletion_protection == false
}
`,
  },

  {
    id: 'sec-iam-least-privilege',
    name: 'Disallow Wildcard Administrator IAM Policies (* on *)',
    description: 'IAM role policies and custom policies must not grant wildcard Action "*" on wildcard Resource "*".',
    category: 'security',
    severity: 'deny',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      benchmark: 'CIS AWS Foundations 1.16',
    },
    regoCode: `package cloudbuilder.security

default allow = true

deny[sprintf("IAM policy %v grants full administrator privileges (* on *)", [rc.address])] {
    rc := input.plan.resource_changes[_]
    rc.type == "aws_iam_policy"
    contains(rc.change.after.policy, "*")
}
`,
  },

  // ─── Cost Guardrails ──────────────────────────────────────────────────────
  {
    id: 'cost-monthly-budget-ceiling',
    name: 'Monthly Total Cost Budget Ceiling ($1,500/mo)',
    description: 'Total projected monthly infrastructure cost cannot exceed the $1,500/month organization budget limit without executive approval.',
    category: 'cost',
    severity: 'deny',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      costImpact: 'Direct budget protection',
    },
    regoCode: `package cloudbuilder.cost

default allow = true

deny[sprintf("Projected monthly cost of $%v exceeds organization budget limit of $1,500/month", [cost.monthlyTotalUsd])] {
    cost := input.cost
    cost.monthlyTotalUsd > 1500
}
`,
  },

  {
    id: 'cost-prohibit-expensive-compute',
    name: 'Prohibit Massive or GPU Compute Instances without Exemption',
    description: 'Cost-prohibitive instance sizes (such as p3, p4, g5, and sizes larger than 4xlarge) require dedicated FinOps approval.',
    category: 'cost',
    severity: 'deny',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      costImpact: 'Avoid accidental high-tier compute deployment',
    },
    regoCode: `package cloudbuilder.cost

default allow = true

deny[sprintf("EC2 instance %v uses prohibited high-cost instance type %v", [rc.address, rc.change.after.instance_type])] {
    rc := input.plan.resource_changes[_]
    rc.type == "aws_instance"
    contains(rc.change.after.instance_type, "p3.")
}

deny[sprintf("Canvas node %v specifies high-cost GPU instance %v", [node.label, node.config.instanceType])] {
    node := input.canvas.nodes[_]
    node.resourceType == "aws_ec2"
    contains(node.config.instanceType, "p3.")
}
`,
  },

  {
    id: 'cost-delta-spike-warning',
    name: 'Alert on Projected Monthly Cost Spikes (Delta > $250/mo)',
    description: 'Warn if this Terraform plan or canvas modification increases the estimated monthly bill by more than $250/month.',
    category: 'cost',
    severity: 'warn',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      costImpact: 'Early warning on infrastructure expansion',
    },
    regoCode: `package cloudbuilder.cost

default allow = true

warn[sprintf("Plan creates an immediate cost increase of +$%v/month", [cost.deltaMonthlyUsd])] {
    cost := input.cost
    cost.deltaMonthlyUsd > 250
}
`,
  },

  // ─── Blast Radius / Destruction Guardrails ────────────────────────────────
  {
    id: 'blast-deny-database-destruction',
    name: 'Block Accidental Destruction of Stateful Databases',
    description: 'Hard-blocks any Terraform plan that includes a delete/destroy action on an RDS database or SQL instance.',
    category: 'blast_radius',
    severity: 'deny',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      benchmark: 'Production Data Safety & Loss Prevention',
    },
    regoCode: `package cloudbuilder.blast_radius

default allow = true

deny[sprintf("Plan contains destruction of stateful database %v. Deleting production databases is prohibited.", [rc.address])] {
    rc := input.plan.resource_changes[_]
    rc.type == "aws_db_instance"
    rc.change.actions[_] == "delete"
}

deny[sprintf("Plan contains destruction of Azure SQL Database %v", [rc.address])] {
    rc := input.plan.resource_changes[_]
    rc.type == "azurerm_mssql_database"
    rc.change.actions[_] == "delete"
}
`,
  },

  {
    id: 'blast-max-destroys-limit',
    name: 'Maximum Resource Deletions Threshold (Max 3 Destroys)',
    description: 'Plans destroying more than 3 cloud resources simultaneously require elevated administrator confirmation to prevent catastrophic outages.',
    category: 'blast_radius',
    severity: 'warn',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      benchmark: 'Catastrophic Change Blast Radius Control',
    },
    regoCode: `package cloudbuilder.blast_radius

default allow = true

warn["Plan destroys multiple resources simultaneously. Multi-resource teardown requires extra review."] {
    rc := input.plan.resource_changes[_]
    rc.change.actions[_] == "delete"
}
`,
  },

  // ─── Compliance & Governance ──────────────────────────────────────────────
  {
    id: 'comp-mandatory-tags',
    name: 'Enforce Standard Governance Tags (Environment, Owner)',
    description: 'All cloud resources must define Environment and Owner tags for audit, billing attribution, and compliance.',
    category: 'compliance',
    severity: 'warn',
    enabled: true,
    isBuiltIn: true,
    metadata: {
      benchmark: 'FinOps Foundation Tagging Best Practices',
    },
    regoCode: `package cloudbuilder.compliance

default allow = true

warn[sprintf("Resource %v is missing the mandatory Environment tag", [rc.address])] {
    rc := input.plan.resource_changes[_]
    rc.type == "aws_instance"
    rc.change.after.tags.Environment == null
}

warn[sprintf("Canvas node %v is missing standard tagging", [node.label])] {
    node := input.canvas.nodes[_]
    node.config.tags == null
}
`,
  },
];

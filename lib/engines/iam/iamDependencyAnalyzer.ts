/**
 * IAM Dependency Analyzer & Auto-Connector Engine
 *
 * Detects missing mandatory IAM roles, instance profiles, and permission links across:
 * 1. Compute resources (EC2, ECS, Lambda, Container Services) needing instance profiles & target permissions (Bedrock, Secrets, KMS, CloudWatch, S3)
 * 2. S3 Cross-Region Replication (CRR) needing S3 replication roles
 * 3. AWS Config needing compliance recorder service roles
 * 4. Amazon RDS needing Enhanced Monitoring roles
 * 5. Generic/Unconnected IAM placeholder nodes on the canvas
 *
 * Generates concrete IAM Role nodes and connects them with labeled directional edges to designated resources.
 */

import { CanvasNode, CanvasEdge } from '@/types';

export interface MissingIamRoleRequirement {
  id: string;
  category:
    | 'compute-instance-profile'
    | 's3-replication'
    | 'config-service-role'
    | 'rds-monitoring'
    | 'lambda-execution'
    | 'azure-managed-identity'
    | 'azure-role-assignment'
    | 'iam-user-access';
  title: string;
  suggestedRoleName: string;
  servicePrincipal: string;
  mandatory: boolean;
  reason: string;
  provider?: 'aws' | 'azure';
  roleType?: 'role' | 'user' | 'managed-identity';
  description?: string;
  path?: string;
  permissionsBoundary?: string;
  createInstanceProfile?: boolean;
  createAccessKey?: boolean;
  designatedResources: Array<{ id: string; label: string; resourceType: string; description?: string }>;
  selectedResourceIds: string[];
  targetPermissions: Array<{
    resourceId: string;
    resourceLabel: string;
    resourceType: string;
    permissionAction: string;
    edgeLabel: string;
    description?: string;
  }>;
  selectedTargetIds: string[];
}

export interface IamAnalysisReport {
  hasMissingRequirements: boolean;
  totalMissing: number;
  hasGenericPlaceholder: boolean;
  genericPlaceholderId?: string;
  detectedProvider: 'aws' | 'azure' | 'multi';
  requirements: MissingIamRoleRequirement[];
}

/**
 * Analyze an architecture canvas and identify missing mandatory IAM roles and connections.
 */
export function analyzeCanvasIamDependencies(nodes: CanvasNode[], edges: CanvasEdge[]): IamAnalysisReport {
  const requirements: MissingIamRoleRequirement[] = [];

  // Index nodes
  const ec2Nodes = nodes.filter((n) => n.resourceType === 'aws_ec2' || n.resourceType === 'aws_instance');
  const rdsNodes = nodes.filter((n) => n.resourceType === 'aws_rds' || n.resourceType === 'aws_db_instance');
  const s3Nodes = nodes.filter((n) => n.resourceType === 'aws_s3' || n.resourceType === 'aws_s3_bucket');
  const configNodes = nodes.filter((n) => n.resourceType === 'aws_config');
  const lambdaNodes = nodes.filter((n) => n.resourceType === 'aws_lambda' || n.resourceType === 'aws_lambda_function');
  const bedrockNodes = nodes.filter((n) => n.resourceType.includes('bedrock'));
  const secretsNodes = nodes.filter((n) => n.resourceType.includes('secrets'));
  const kmsNodes = nodes.filter((n) => n.resourceType === 'aws_kms' || n.resourceType === 'aws_kms_key');
  const cwNodes = nodes.filter((n) => n.resourceType.includes('cloudwatch'));

  // Existing IAM role nodes
  const existingIamNodes = nodes.filter((n) => n.resourceType === 'aws_iam' || n.resourceType === 'aws_iam_role');
  const genericPlaceholder = existingIamNodes.find(
    (n) => n.id === 'iam' && (!n.config?.roleName || n.config?.description === 'EC2 instance role')
  );

  // Helper to test if a node is already connected to an IAM role
  const isConnectedToIam = (nodeId: string) =>
    edges.some(
      (e) =>
        ((e.source === nodeId && existingIamNodes.some((iam) => iam.id === e.target)) ||
          (e.target === nodeId && existingIamNodes.some((iam) => iam.id === e.source))) &&
        e.source !== 'vpc' && e.target !== 'vpc'
    );

  // 1. Compute Instances: EC2 Application Instance Profile
  const unattachedEc2 = ec2Nodes.filter((n) => !isConnectedToIam(n.id));
  if (unattachedEc2.length > 0) {
    const targets: MissingIamRoleRequirement['targetPermissions'] = [];

    bedrockNodes.forEach((b) => {
      targets.push({
        resourceId: b.id,
        resourceLabel: b.label || 'Amazon Bedrock',
        resourceType: b.resourceType,
        permissionAction: 'bedrock:InvokeModel',
        edgeLabel: 'InvokeModel',
        description: 'Allows EC2 backend to call generative AI foundational models',
      });
    });

    secretsNodes.forEach((s) => {
      targets.push({
        resourceId: s.id,
        resourceLabel: s.label || 'AWS Secrets Manager',
        resourceType: s.resourceType,
        permissionAction: 'secretsmanager:GetSecretValue',
        edgeLabel: 'GetSecretValue',
        description: 'Allows EC2 application to securely retrieve database & API credentials',
      });
    });

    kmsNodes.forEach((k) => {
      targets.push({
        resourceId: k.id,
        resourceLabel: k.label || 'AWS KMS',
        resourceType: k.resourceType,
        permissionAction: 'kms:Decrypt, GenerateDataKey',
        edgeLabel: 'KMS Decrypt',
        description: 'Permits decryption of RDS/EBS envelope keys',
      });
    });

    cwNodes.forEach((cw) => {
      targets.push({
        resourceId: cw.id,
        resourceLabel: cw.label || 'Amazon CloudWatch',
        resourceType: cw.resourceType,
        permissionAction: 'logs:PutLogEvents, cloudwatch:PutMetricData',
        edgeLabel: 'PutLogEvents',
        description: 'Permits pushing application logs and custom telemetry metrics',
      });
    });

    requirements.push({
      id: 'ec2-app-profile',
      category: 'compute-instance-profile',
      title: 'EC2 Application Instance Profile Role',
      suggestedRoleName: 'prism-ec2-backend-instance-role',
      servicePrincipal: 'ec2.amazonaws.com',
      mandatory: true,
      reason: `${unattachedEc2.length} backend EC2 instances require an IAM role to authorize calls to Bedrock, Secrets Manager, KMS, and CloudWatch.`,
      designatedResources: unattachedEc2.map((n) => ({
        id: n.id,
        label: n.label,
        resourceType: n.resourceType,
        description: (n.config?.description as string) || 'Backend API Instance',
      })),
      selectedResourceIds: unattachedEc2.map((n) => n.id),
      targetPermissions: targets,
      selectedTargetIds: targets.map((t) => t.resourceId),
    });
  }

  // 2. S3 Cross-Region Replication (CRR) Role
  // Look for paired DR buckets or CRR edges
  const crrEdges = edges.filter((e) => (e.label || '').toUpperCase().includes('CRR'));
  const drS3Buckets = s3Nodes.filter((n) => n.id.includes('crr') || (n.label || '').includes('CRR') || n.groupId === 'dr');
  const sourceS3Buckets = s3Nodes.filter((n) => !drS3Buckets.some((dr) => dr.id === n.id));

  const hasCrrConfig = crrEdges.length > 0 || (drS3Buckets.length > 0 && sourceS3Buckets.length > 0);
  const existingCrrRole = existingIamNodes.find(
    (n) => n.id.includes('crr') || (n.config?.description as string || '').toLowerCase().includes('crr')
  );

  if (hasCrrConfig && !existingCrrRole) {
    const primaryBucket = sourceS3Buckets[0] || s3Nodes[0];
    const drBucket = drS3Buckets[0] || s3Nodes[1];

    requirements.push({
      id: 's3-replication-role',
      category: 's3-replication',
      title: 'S3 Cross-Region Replication (CRR) Role',
      suggestedRoleName: 'prism-s3-replication-role',
      servicePrincipal: 's3.amazonaws.com',
      mandatory: true,
      reason: 'S3 asynchronous cross-region replication to the Osaka DR region requires an IAM role with s3:ReplicateObject permissions.',
      designatedResources: sourceS3Buckets.map((n) => ({
        id: n.id,
        label: n.label,
        resourceType: n.resourceType,
        description: (n.config?.description as string) || 'Primary Region Source Bucket',
      })),
      selectedResourceIds: sourceS3Buckets.map((n) => n.id),
      targetPermissions: drS3Buckets.map((dr) => ({
        resourceId: dr.id,
        resourceLabel: dr.label,
        resourceType: dr.resourceType,
        permissionAction: 's3:ReplicateObject, s3:ReplicateTags',
        edgeLabel: 'ReplicateObject (Osaka)',
        description: 'Replicates versioned objects into Osaka DR S3 bucket',
      })),
      selectedTargetIds: drS3Buckets.map((dr) => dr.id),
    });
  }

  // 3. AWS Config Recorder Role
  const unattachedConfig = configNodes.filter((n) => !isConnectedToIam(n.id));
  if (unattachedConfig.length > 0) {
    const s3ConfigBucket = s3Nodes.find((n) => n.id.includes('config') || (n.label || '').toLowerCase().includes('config'));
    const targets: MissingIamRoleRequirement['targetPermissions'] = [];

    if (s3ConfigBucket) {
      targets.push({
        resourceId: s3ConfigBucket.id,
        resourceLabel: s3ConfigBucket.label || 'Config S3 Bucket',
        resourceType: s3ConfigBucket.resourceType,
        permissionAction: 's3:PutObject, s3:GetBucketAcl',
        edgeLabel: 'PutObject snapshots',
        description: 'Permits writing resource snapshots and compliance history',
      });
    }

    requirements.push({
      id: 'config-recorder-role',
      category: 'config-service-role',
      title: 'AWS Config Compliance Service Role',
      suggestedRoleName: 'prism-aws-config-role',
      servicePrincipal: 'config.amazonaws.com',
      mandatory: true,
      reason: 'AWS Config requires an IAM service role to record resource changes and deliver configuration snapshots to S3.',
      designatedResources: unattachedConfig.map((n) => ({
        id: n.id,
        label: n.label,
        resourceType: n.resourceType,
        description: (n.config?.description as string) || 'Compliance Recorder',
      })),
      selectedResourceIds: unattachedConfig.map((n) => n.id),
      targetPermissions: targets,
      selectedTargetIds: targets.map((t) => t.resourceId),
    });
  }

  // 4. RDS Enhanced Monitoring Role
  const unattachedRds = rdsNodes.filter((n) => !isConnectedToIam(n.id));
  if (unattachedRds.length > 0 && cwNodes.length > 0) {
    const cwTarget = cwNodes[0];
    requirements.push({
      id: 'rds-monitoring-role',
      category: 'rds-monitoring',
      title: 'Amazon RDS Enhanced Monitoring Role',
      suggestedRoleName: 'prism-rds-enhanced-monitoring-role',
      servicePrincipal: 'monitoring.rds.amazonaws.com',
      mandatory: false,
      reason: 'Captures detailed real-time OS metrics (CPU per process, memory, disk I/O) and streams them to CloudWatch Logs.',
      designatedResources: unattachedRds.map((n) => ({
        id: n.id,
        label: n.label,
        resourceType: n.resourceType,
        description: (n.config?.description as string) || 'PostgreSQL Database',
      })),
      selectedResourceIds: unattachedRds.map((n) => n.id),
      targetPermissions: [
        {
          resourceId: cwTarget.id,
          resourceLabel: cwTarget.label || 'Amazon CloudWatch',
          resourceType: cwTarget.resourceType,
          permissionAction: 'logs:CreateLogGroup, logs:PutLogEvents',
          edgeLabel: 'Streams DB metrics',
          description: 'Streams 1-second OS metrics to CloudWatch Logs group',
        },
      ],
      selectedTargetIds: [cwTarget.id],
    });
  }

  // 5. Lambda Execution Role
  const unattachedLambda = lambdaNodes.filter((n) => !isConnectedToIam(n.id));
  if (unattachedLambda.length > 0) {
    requirements.push({
      id: 'lambda-execution-role',
      category: 'lambda-execution',
      title: 'AWS Lambda Execution Role',
      suggestedRoleName: 'prism-lambda-basic-execution-role',
      servicePrincipal: 'lambda.amazonaws.com',
      mandatory: true,
      provider: 'aws',
      roleType: 'role',
      description: 'AWS Lambda execution role with CloudWatch logs and VPC execution permissions',
      path: '/service-roles/',
      reason: 'Serverless functions require an execution role to write execution logs and access VPC network interfaces.',
      designatedResources: unattachedLambda.map((n) => ({
        id: n.id,
        label: n.label,
        resourceType: n.resourceType,
        description: 'Serverless function',
      })),
      selectedResourceIds: unattachedLambda.map((n) => n.id),
      targetPermissions: cwNodes.map((cw) => ({
        resourceId: cw.id,
        resourceLabel: cw.label,
        resourceType: cw.resourceType,
        permissionAction: 'logs:CreateLogStream, logs:PutLogEvents',
        edgeLabel: 'Lambda Logs',
        description: 'Writes function runtime logs',
      })),
      selectedTargetIds: cwNodes.map((cw) => cw.id),
    });
  }

  // 6. Azure Compute: User-Assigned Managed Identity
  const azureVmNodes = nodes.filter(
    (n) =>
      n.resourceType === 'azure_vm' ||
      n.resourceType.includes('virtual_machine') ||
      n.resourceType === 'azure_functions' ||
      n.resourceType === 'azure_app_service' ||
      n.resourceType === 'azure_container_app'
  );
  const azureKeyVaultNodes = nodes.filter((n) => n.resourceType.includes('key_vault'));
  const azureStorageNodes = nodes.filter(
    (n) => n.resourceType === 'azure_storage' || n.resourceType.includes('storage_account')
  );
  const existingManagedIdentities = nodes.filter(
    (n) => n.resourceType === 'azure_user_assigned_identity' || n.resourceType === 'azurerm_user_assigned_identity'
  );
  const existingEntraUsers = nodes.filter((n) => n.resourceType === 'azure_ad_user' || n.resourceType === 'azuread_user');
  const existingIamUsers = nodes.filter((n) => n.resourceType === 'aws_iam_user');

  const isConnectedToManagedIdentity = (nodeId: string) =>
    edges.some(
      (e) =>
        (e.source === nodeId && existingManagedIdentities.some((m) => m.id === e.target)) ||
        (e.target === nodeId && existingManagedIdentities.some((m) => m.id === e.source))
    );

  const unattachedAzureCompute = azureVmNodes.filter((n) => !isConnectedToManagedIdentity(n.id));
  if (unattachedAzureCompute.length > 0 && (azureKeyVaultNodes.length > 0 || azureStorageNodes.length > 0)) {
    const targets: MissingIamRoleRequirement['targetPermissions'] = [];

    azureKeyVaultNodes.forEach((kv) => {
      targets.push({
        resourceId: kv.id,
        resourceLabel: kv.label || 'Azure Key Vault',
        resourceType: kv.resourceType,
        permissionAction: 'Key Vault Secrets User',
        edgeLabel: 'GetSecret / KeyVault User',
        description: 'Allows VM / App to read application secrets directly via managed identity without credentials',
      });
    });

    azureStorageNodes.forEach((st) => {
      targets.push({
        resourceId: st.id,
        resourceLabel: st.label || 'Azure Storage Account',
        resourceType: st.resourceType,
        permissionAction: 'Storage Blob Data Contributor',
        edgeLabel: 'Blob Read/Write',
        description: 'Grants managed identity RBAC data access to blobs and tables',
      });
    });

    requirements.push({
      id: 'azure-managed-identity',
      category: 'azure-managed-identity',
      title: 'Azure User-Assigned Managed Identity',
      suggestedRoleName: 'prism-azure-app-identity',
      servicePrincipal: 'Microsoft.ManagedIdentity',
      mandatory: true,
      provider: 'azure',
      roleType: 'managed-identity',
      description: 'User-assigned managed identity granting zero-trust access to Key Vault and Storage',
      reason: `${unattachedAzureCompute.length} Azure compute resources require a Managed Identity to securely access Key Vault and Storage without secrets.`,
      designatedResources: unattachedAzureCompute.map((n) => ({
        id: n.id,
        label: n.label,
        resourceType: n.resourceType,
        description: 'Azure Compute Resource',
      })),
      selectedResourceIds: unattachedAzureCompute.map((n) => n.id),
      targetPermissions: targets,
      selectedTargetIds: targets.map((t) => t.resourceId),
    });
  }

  // 7. IAM User / Entra ID User check
  const hasAws = nodes.some((n) => n.provider === 'aws' || n.resourceType.startsWith('aws_'));
  const hasAzure = nodes.some(
    (n) => n.provider === 'azure' || n.resourceType.startsWith('azure_') || n.resourceType.startsWith('azurerm_')
  );
  const detectedProvider: 'aws' | 'azure' | 'multi' = hasAws && hasAzure ? 'multi' : hasAzure ? 'azure' : 'aws';

  if (hasAws && existingIamUsers.length === 0 && (s3Nodes.length > 0 || ec2Nodes.length > 0)) {
    requirements.push({
      id: 'aws-app-user',
      category: 'iam-user-access',
      title: 'AWS IAM User (CI/CD & Developer Access)',
      suggestedRoleName: 'developer-deployer-user',
      servicePrincipal: 'AWS IAM User',
      mandatory: false,
      provider: 'aws',
      roleType: 'user',
      description: 'Dedicated IAM User for automated CI/CD deployment pipelines and administrative access',
      path: '/engineering/',
      createAccessKey: true,
      reason: 'Optional: Add an IAM User to your canvas with programmatic access keys to connect to services or assume roles.',
      designatedResources: [],
      selectedResourceIds: [],
      targetPermissions: s3Nodes.slice(0, 1).map((s) => ({
        resourceId: s.id,
        resourceLabel: s.label,
        resourceType: s.resourceType,
        permissionAction: 's3:PutObject, s3:GetObject',
        edgeLabel: 'CI/CD Deploy / S3 Access',
        description: 'Deploy builds and static assets to S3',
      })),
      selectedTargetIds: s3Nodes.slice(0, 1).map((s) => s.id),
    });
  } else if (hasAzure && existingEntraUsers.length === 0 && azureVmNodes.length > 0) {
    requirements.push({
      id: 'azure-entra-user',
      category: 'azure-role-assignment',
      title: 'Microsoft Entra ID User',
      suggestedRoleName: 'admin@company.onmicrosoft.com',
      servicePrincipal: 'Microsoft Entra ID',
      mandatory: false,
      provider: 'azure',
      roleType: 'user',
      description: 'Directory user with assigned Azure RBAC roles',
      reason: 'Optional: Model an Entra ID User on your canvas with RBAC role assignments to resources or Resource Groups.',
      designatedResources: [],
      selectedResourceIds: [],
      targetPermissions: azureKeyVaultNodes.map((kv) => ({
        resourceId: kv.id,
        resourceLabel: kv.label,
        resourceType: kv.resourceType,
        permissionAction: 'Key Vault Administrator',
        edgeLabel: 'RBAC Role Assignment',
        description: 'Manage keys, secrets, and certificates',
      })),
      selectedTargetIds: azureKeyVaultNodes.map((kv) => kv.id),
    });
  }

  return {
    hasMissingRequirements: requirements.length > 0,
    totalMissing: requirements.length,
    hasGenericPlaceholder: !!genericPlaceholder,
    genericPlaceholderId: genericPlaceholder?.id,
    detectedProvider,
    requirements,
  };
}

/**
 * Apply the user's completed IAM requirements directly onto the canvas.
 * Creates discrete IAM role nodes with custom names and wires up all designated edges.
 */
export function applyCompletedIamRolesToCanvas(
  currentNodes: CanvasNode[],
  currentEdges: CanvasEdge[],
  userSubmissions: Record<
    string,
    {
      roleName: string;
      description?: string;
      path?: string;
      permissionsBoundary?: string;
      createInstanceProfile?: boolean;
      createAccessKey?: boolean;
      selectedResourceIds: string[];
      selectedTargetIds: string[];
      provider?: 'aws' | 'azure';
      roleType?: 'role' | 'user' | 'managed-identity';
    }
  >,
  removeGenericPlaceholder = true
): { nodes: CanvasNode[]; edges: CanvasEdge[]; newlyCreatedRoles: number; newlyCreatedEdges: number } {
  let updatedNodes = [...currentNodes];
  let updatedEdges = [...currentEdges];

  // If requested and exists, remove the generic placeholder node "iam"
  if (removeGenericPlaceholder) {
    updatedNodes = updatedNodes.filter(
      (n) => !(n.id === 'iam' && (!n.config?.roleName || n.config?.description === 'EC2 instance role'))
    );
    updatedEdges = updatedEdges.filter((e) => e.source !== 'iam' && e.target !== 'iam');
  }

  // Find security / governance container if present
  const secContainer = updatedNodes.find(
    (n) =>
      n.id === 'secgrp' ||
      (n.type === 'containerNode' &&
        ((n.label || '').toLowerCase().includes('security') ||
          (n.label || '').toLowerCase().includes('governance')))
  );

  let newRolesCount = 0;
  let newEdgesCount = 0;

  // Track layout coordinates in the security container
  let startX = secContainer ? secContainer.position.x + 40 : 1650;
  let startY = secContainer ? secContainer.position.y + 190 : 280;

  Object.entries(userSubmissions).forEach(([reqId, sub], idx) => {
    const isAzure = sub.provider === 'azure' || reqId.startsWith('azure');
    const isUser = sub.roleType === 'user' || reqId.includes('user');
    const isManagedIdentity = sub.roleType === 'managed-identity' || reqId.includes('managed-identity');

    const prefix = isAzure ? (isUser ? 'entra_user' : 'identity') : (isUser ? 'iam_user' : 'iam');
    const roleNodeId = `${prefix}_${reqId.replace(/-/g, '_')}`;

    // Don't duplicate if node ID already exists
    if (updatedNodes.some((n) => n.id === roleNodeId)) return;

    let roleDescription = sub.description || 'IAM Role';
    if (!sub.description) {
      if (reqId === 'ec2-app-profile') roleDescription = 'EC2 App Profile';
      else if (reqId === 's3-replication-role') roleDescription = 'S3 CRR (Osaka)';
      else if (reqId === 'config-recorder-role') roleDescription = 'Config Recorder';
      else if (reqId === 'rds-monitoring-role') roleDescription = 'RDS Monitoring';
      else if (reqId === 'lambda-execution-role') roleDescription = 'Lambda Execution';
      else if (reqId === 'azure-managed-identity') roleDescription = 'Managed Identity';
      else if (reqId === 'aws-app-user') roleDescription = 'CI/CD Deployer User';
      else if (reqId === 'azure-entra-user') roleDescription = 'Entra ID User';
    }

    let resourceType = 'aws_iam';
    let provider: 'aws' | 'azure' = 'aws';
    let roleLabel = 'AWS IAM Role';

    if (isUser && isAzure) {
      resourceType = 'azure_ad_user';
      provider = 'azure';
      roleLabel = sub.roleName || 'Entra ID User';
    } else if (isUser) {
      resourceType = 'aws_iam_user';
      provider = 'aws';
      roleLabel = sub.roleName || 'IAM User';
    } else if (isManagedIdentity || isAzure) {
      resourceType = 'azure_user_assigned_identity';
      provider = 'azure';
      roleLabel = sub.roleName || 'Managed Identity';
    } else {
      roleLabel = sub.roleName || 'AWS IAM Role';
    }

    // Position in a neat grid row
    const posX = startX + (idx % 3) * 190;
    const posY = startY + Math.floor(idx / 3) * 130;

    const newRoleNode: CanvasNode = {
      id: roleNodeId,
      type: 'cloudNode',
      resourceType,
      provider,
      label: roleLabel,
      position: { x: posX, y: posY },
      groupId: secContainer?.id,
      config: {
        roleName: sub.roleName,
        name: sub.roleName,
        userPrincipalName: isUser && isAzure ? sub.roleName : undefined,
        description: roleDescription,
        path: sub.path || '/',
        permissionsBoundaryArn: sub.permissionsBoundary || '',
        createInstanceProfile: sub.createInstanceProfile ?? true,
        createAccessKey: sub.createAccessKey ?? true,
        mandatory: true,
        configured: true,
        importState: 'new',
      },
      importState: 'new',
    };

    updatedNodes.push(newRoleNode);
    newRolesCount++;

    // 1. Connect Role -> Designated Resources (Instance profile attachment / Assumer)
    sub.selectedResourceIds.forEach((targetId) => {
      const edgeId = `edge-${roleNodeId}-${targetId}`;
      if (!updatedEdges.some((e) => e.source === roleNodeId && e.target === targetId)) {
        let label = 'Attached Role';
        if (reqId === 'ec2-app-profile') label = 'Instance Profile';
        else if (reqId === 's3-replication-role') label = 'Source S3 (CRR)';
        else if (reqId === 'config-recorder-role') label = 'Assumed by Config';
        else if (reqId === 'rds-monitoring-role') label = 'OS Monitoring';
        else if (isManagedIdentity) label = 'Assigned Identity';
        else if (isUser) label = 'Assumes / Manages';

        updatedEdges.push({
          id: edgeId,
          source: roleNodeId,
          target: targetId,
          edgeType: 'network',
          label,
        });
        newEdgesCount++;
      }
    });

    // 2. Connect Role -> Target Permissions (InvokeModel, Secrets, KMS, CloudWatch, KeyVault, Storage)
    sub.selectedTargetIds.forEach((targetId) => {
      const edgeId = `edge-${roleNodeId}-${targetId}-perm`;
      if (!updatedEdges.some((e) => e.source === roleNodeId && e.target === targetId)) {
        const targetNode = updatedNodes.find((n) => n.id === targetId);
        let label = 'Allows Access';
        const tType = targetNode?.resourceType || '';

        if (tType.includes('bedrock')) label = 'InvokeModel';
        else if (tType.includes('secrets')) label = 'GetSecretValue';
        else if (tType.includes('kms')) label = 'KMS Decrypt';
        else if (tType.includes('cloudwatch')) label = 'PutLogEvents';
        else if (tType.includes('key_vault')) label = 'Key Vault Secrets User';
        else if (tType.includes('storage')) label = 'Storage Blob Data Contributor';
        else if (tType.includes('s3') && reqId === 's3-replication-role') label = 'ReplicateObject (Osaka)';
        else if (tType.includes('s3') && reqId === 'config-recorder-role') label = 'PutObject snapshots';

        updatedEdges.push({
          id: edgeId,
          source: roleNodeId,
          target: targetId,
          edgeType: 'data',
          label,
        });
      }
    });
  });

  return {
    nodes: updatedNodes,
    edges: updatedEdges,
    newlyCreatedRoles: newRolesCount,
    newlyCreatedEdges: newEdgesCount,
  };
}

import { z } from 'zod';

/**
 * Validation for the caller-supplied remote state backend. These names are written into backend.tf, so each one is
 * restricted to the characters the cloud provider itself allows — nothing that could close a string or add HCL.
 */
const bucket = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid S3 bucket name');
const stateKey = z.string().min(1).max(1024).regex(/^[A-Za-z0-9!_.*'()/-]+$/, 'Invalid state key');
const awsRegion = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'Invalid AWS region');

export const AwsBackendSchema = z.object({
  provider: z.literal('aws'),
  bucket,
  key: stateKey,
  region: awsRegion,
  dynamodbTable: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/, 'Invalid DynamoDB table name').optional(),
});

export const AzureBackendSchema = z.object({
  provider: z.literal('azure'),
  resourceGroupName: z.string().regex(/^[A-Za-z0-9_.()-]{1,90}$/, 'Invalid resource group name'),
  storageAccountName: z.string().regex(/^[a-z0-9]{3,24}$/, 'Invalid storage account name'),
  containerName: z.string().regex(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/, 'Invalid container name'),
  key: stateKey,
});

export const StateBackendSchema = z.discriminatedUnion('provider', [AwsBackendSchema, AzureBackendSchema]);

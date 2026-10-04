import { z } from 'zod';

/**
 * Validation for the caller-supplied remote state backend. These names are written into backend.tf, so each one is
 * restricted to the characters the cloud provider itself allows — nothing that could close a string or add HCL.
 */
// Every text field is trimmed first: a name pasted with a trailing space is the same name, not an error.
const bucket = z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid S3 bucket name: 3-63 lowercase letters, digits, dots or hyphens, no spaces');
const stateKey = z.string().trim().min(1).max(1024).regex(/^[A-Za-z0-9!_.*'()/-]+$/, 'Invalid state key: letters, digits and / _ - . only, no spaces');
const awsRegion = z.string().trim().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'Invalid AWS region (for example eu-north-1)');

export const AwsBackendSchema = z.object({
  provider: z.literal('aws'),
  bucket,
  key: stateKey,
  region: awsRegion,
  dynamodbTable: z.string().trim().regex(/^[A-Za-z0-9_.-]{3,255}$/, 'Invalid DynamoDB table name: 3-255 letters, digits, _ - . only').optional(),
});

export const AzureBackendSchema = z.object({
  provider: z.literal('azure'),
  resourceGroupName: z.string().trim().regex(/^[A-Za-z0-9_.()-]{1,90}$/, 'Invalid resource group name'),
  storageAccountName: z.string().trim().regex(/^[a-z0-9]{3,24}$/, 'Invalid storage account name: 3-24 lowercase letters and digits only'),
  containerName: z.string().trim().regex(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/, 'Invalid container name'),
  key: stateKey,
});

export const StateBackendSchema = z.discriminatedUnion('provider', [AwsBackendSchema, AzureBackendSchema]);

#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/3aaa06d161686128ac112d46e2d67aba9a42fd6fa35e53401eafc3314366eddd/contract';
import endContract from '../../snapshots/3aaa06d161686128ac112d46e2d67aba9a42fd6fa35e53401eafc3314366eddd/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/6d64572a0d0c10f4b6eae901755a22f7f7186a9f2d5ef5458799f969be8caf88/contract';
import startContract from '../../snapshots/6d64572a0d0c10f4b6eae901755a22f7f7186a9f2d5ef5458799f969be8caf88/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'readinessControl',
        columns: [
          col('controlId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('naReason', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('owner', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reviewedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reviewer', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'readinessEvidence',
        columns: [
          col('collectedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('controlsJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('deletedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('deletedBy', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('description', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('fileName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('mimeType', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('origin', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sealed', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('sha256', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('sizeBytes', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('uploadedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('url', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('validUntil', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'readinessFinding',
        columns: [
          col('acceptedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('controlId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('managementResponse', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('owner', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('retestedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('retestedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('targetDate', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'readinessReport',
        columns: [
          col('asOf', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('generatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('generatedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('readiness', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reportId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('summaryJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('version', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'readinessSetting',
        columns: [
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('settingsJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'readinessSignoff',
        columns: [
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reportHash', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('role', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('signedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessControl',
        index: 'readinessControl_projectId_framework_idx_b5cffbad',
        columns: ['projectId', 'framework'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessControl',
        index: 'readinessControl_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessEvidence',
        index: 'readinessEvidence_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessFinding',
        index: 'readinessFinding_projectId_framework_idx_b5cffbad',
        columns: ['projectId', 'framework'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessFinding',
        index: 'readinessFinding_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessReport',
        index: 'readinessReport_projectId_framework_idx_b5cffbad',
        columns: ['projectId', 'framework'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessReport',
        index: 'readinessReport_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessSetting',
        index: 'readinessSetting_projectId_framework_idx_b5cffbad',
        columns: ['projectId', 'framework'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessSetting',
        index: 'readinessSetting_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessSignoff',
        index: 'readinessSignoff_projectId_framework_idx_b5cffbad',
        columns: ['projectId', 'framework'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessSignoff',
        index: 'readinessSignoff_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'readinessControl',
        foreignKey: {
          name: 'readinessControl_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'readinessEvidence',
        foreignKey: {
          name: 'readinessEvidence_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'readinessFinding',
        foreignKey: {
          name: 'readinessFinding_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'readinessReport',
        foreignKey: {
          name: 'readinessReport_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'readinessSetting',
        foreignKey: {
          name: 'readinessSetting_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'readinessSignoff',
        foreignKey: {
          name: 'readinessSignoff_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

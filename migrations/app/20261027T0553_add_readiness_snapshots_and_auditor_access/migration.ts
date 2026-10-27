#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/3aaa06d161686128ac112d46e2d67aba9a42fd6fa35e53401eafc3314366eddd/contract';
import startContract from '../../snapshots/3aaa06d161686128ac112d46e2d67aba9a42fd6fa35e53401eafc3314366eddd/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/afc22488d844c97bf2fb3e1cb982272e97bcc89e2b82ddf32b202f557d5a3845/contract';
import endContract from '../../snapshots/afc22488d844c97bf2fb3e1cb982272e97bcc89e2b82ddf32b202f557d5a3845/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'readinessAuditorAccess',
        columns: [
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('lastUsedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('revokedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('tokenHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('tokenPrefix', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('useCount', 'float8', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/float8@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'readinessSnapshot',
        columns: [
          col('controlsJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('factsJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('readiness', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('summaryJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('takenAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('trigger', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'readinessAuditorAccess',
        constraint: 'readinessAuditorAccess_tokenHash_key',
        columns: ['tokenHash'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessAuditorAccess',
        index: 'readinessAuditorAccess_projectId_framework_idx_b5cffbad',
        columns: ['projectId', 'framework'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessAuditorAccess',
        index: 'readinessAuditorAccess_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessSnapshot',
        index: 'readinessSnapshot_projectId_framework_takenAt_idx_eb088961',
        columns: ['projectId', 'framework', 'takenAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessSnapshot',
        index: 'readinessSnapshot_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'readinessAuditorAccess',
        foreignKey: {
          name: 'readinessAuditorAccess_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'readinessSnapshot',
        foreignKey: {
          name: 'readinessSnapshot_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

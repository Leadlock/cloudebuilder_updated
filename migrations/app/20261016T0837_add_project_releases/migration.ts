#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/7026e520b55815ed9b2dd462a902005bfc4ec6e2f94db01e5a69a17ebeac2be9/contract';
import endContract from '../../snapshots/7026e520b55815ed9b2dd462a902005bfc4ec6e2f94db01e5a69a17ebeac2be9/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/7167758b68498480ae8b67247dcd88f5f04cbab50f57ff8d1e97cd9713263e29/contract';
import startContract from '../../snapshots/7167758b68498480ae8b67247dcd88f5f04cbab50f57ff8d1e97cd9713263e29/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'projectRelease',
        columns: [
          col('bundleHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAtMs', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('createdBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('dataJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('environment', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('imageTag', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('planHash', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('planId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('project', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('target', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAtMs', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'projectRelease',
        index: 'projectRelease_orgId_status_idx_f07aed73',
        columns: ['orgId', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'projectRelease',
        index: 'projectRelease_projectId_environment_updatedAtMs_idx_6c402eb8',
        columns: ['projectId', 'environment', 'updatedAtMs'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

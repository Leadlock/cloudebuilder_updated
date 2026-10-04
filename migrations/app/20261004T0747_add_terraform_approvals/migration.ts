#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/6b0817c3a48172f0fa480046ff296c943318a81e2601a56eebfd035ce7808563/contract';
import endContract from '../../snapshots/6b0817c3a48172f0fa480046ff296c943318a81e2601a56eebfd035ce7808563/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/9a378bfb3956a6c13c2d39384fbf698f46960cc34c36f05733459ec1ece6b866/contract';
import startContract from '../../snapshots/9a378bfb3956a6c13c2d39384fbf698f46960cc34c36f05733459ec1ece6b866/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'terraformApproval',
        columns: [
          col('action', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('comment', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('decidedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('decidedBy', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAtMs', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('planHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('planId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('requestedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('summary', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('usedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'terraformApproval',
        index: 'terraformApproval_orgId_status_idx_f07aed73',
        columns: ['orgId', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'terraformApproval',
        index: 'terraformApproval_projectId_createdAt_idx_d2d6484f',
        columns: ['projectId', 'createdAt'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

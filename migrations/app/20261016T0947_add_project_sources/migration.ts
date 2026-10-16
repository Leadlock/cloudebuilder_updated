#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/5d5e21b651aa807330e6db3599f64737318a18eedcf3607abd46a30c059bd72e/contract';
import endContract from '../../snapshots/5d5e21b651aa807330e6db3599f64737318a18eedcf3607abd46a30c059bd72e/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/7026e520b55815ed9b2dd462a902005bfc4ec6e2f94db01e5a69a17ebeac2be9/contract';
import startContract from '../../snapshots/7026e520b55815ed9b2dd462a902005bfc4ec6e2f94db01e5a69a17ebeac2be9/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'projectSource',
        columns: [
          col('createdAtMs', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('dataB64', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAtMs', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('layer', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sha256', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sizeBytes', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'projectSource',
        index: 'projectSource_projectId_expiresAtMs_idx_981fcd13',
        columns: ['projectId', 'expiresAtMs'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

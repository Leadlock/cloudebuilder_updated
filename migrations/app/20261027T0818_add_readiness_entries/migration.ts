#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/a797a6e3ac3ec09ef317c5ae3b8465f4b7491465b429f15b4e53d0e743c0140d/contract';
import endContract from '../../snapshots/a797a6e3ac3ec09ef317c5ae3b8465f4b7491465b429f15b4e53d0e743c0140d/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/afc22488d844c97bf2fb3e1cb982272e97bcc89e2b82ddf32b202f557d5a3845/contract';
import startContract from '../../snapshots/afc22488d844c97bf2fb3e1cb982272e97bcc89e2b82ddf32b202f557d5a3845/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'readinessEntry',
        columns: [
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('dataJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('key', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessEntry',
        index: 'readinessEntry_projectId_framework_kind_idx_e213b5e9',
        columns: ['projectId', 'framework', 'kind'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'readinessEntry',
        index: 'readinessEntry_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'readinessEntry',
        foreignKey: {
          name: 'readinessEntry_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/41d6dd89b711ca9453fcaf4c65d30fed941c2f1ca1b9d63af3850088ba333b78/contract';
import startContract from '../../snapshots/41d6dd89b711ca9453fcaf4c65d30fed941c2f1ca1b9d63af3850088ba333b78/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/5bfc0e6cb4dfb9a61d46c15ac5c67599c20ce0fe4d876b35682e0becec40ef84/contract';
import endContract from '../../snapshots/5bfc0e6cb4dfb9a61d46c15ac5c67599c20ce0fe4d876b35682e0becec40ef84/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'containerTemplate',
        columns: [
          col('configJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'containerTemplate',
        index: 'containerTemplate_orgId_idx_c5e5aabe',
        columns: ['orgId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

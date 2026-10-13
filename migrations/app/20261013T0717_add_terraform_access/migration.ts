#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/5bfc0e6cb4dfb9a61d46c15ac5c67599c20ce0fe4d876b35682e0becec40ef84/contract';
import startContract from '../../snapshots/5bfc0e6cb4dfb9a61d46c15ac5c67599c20ce0fe4d876b35682e0becec40ef84/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/7167758b68498480ae8b67247dcd88f5f04cbab50f57ff8d1e97cd9713263e29/contract';
import endContract from '../../snapshots/7167758b68498480ae8b67247dcd88f5f04cbab50f57ff8d1e97cd9713263e29/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'terraformAccess',
        columns: [
          col('checksJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('decidedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('decidedBy', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('requestedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('requestedBy', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'terraformAccess',
        constraint: 'terraformAccess_orgId_key',
        columns: ['orgId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/a61af368dd73848610d6d33b031dca54c99a49efe389a9c56e1793d9ea894270/contract';
import startContract from '../../snapshots/a61af368dd73848610d6d33b031dca54c99a49efe389a9c56e1793d9ea894270/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/e93966cf06f92708de12b9327127d88570069c17c200b479d2ce101bf690e4ad/contract';
import endContract from '../../snapshots/e93966cf06f92708de12b9327127d88570069c17c200b479d2ce101bf690e4ad/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'terraformAuditEvent',
        columns: [
          col('action', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('detail', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('outcome', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('planHash', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('planId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'terraformAuditEvent',
        index: 'terraformAuditEvent_orgId_createdAt_idx_e5d9317b',
        columns: ['orgId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'terraformAuditEvent',
        index: 'terraformAuditEvent_projectId_createdAt_idx_d2d6484f',
        columns: ['projectId', 'createdAt'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

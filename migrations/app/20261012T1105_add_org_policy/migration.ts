#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/41d6dd89b711ca9453fcaf4c65d30fed941c2f1ca1b9d63af3850088ba333b78/contract';
import endContract from '../../snapshots/41d6dd89b711ca9453fcaf4c65d30fed941c2f1ca1b9d63af3850088ba333b78/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/4f0f69f79ba0235bc1df2e06f1ce92bfff27139e160880dab8676128a94ad853/contract';
import startContract from '../../snapshots/4f0f69f79ba0235bc1df2e06f1ce92bfff27139e160880dab8676128a94ad853/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'orgPolicy',
        columns: [
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('policyJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('version', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'orgPolicy',
        constraint: 'orgPolicy_orgId_key',
        columns: ['orgId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

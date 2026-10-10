#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/4f0f69f79ba0235bc1df2e06f1ce92bfff27139e160880dab8676128a94ad853/contract';
import endContract from '../../snapshots/4f0f69f79ba0235bc1df2e06f1ce92bfff27139e160880dab8676128a94ad853/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/f880b368b4088ede3fae698d420b09a3339cb1c2f203415e0cb0197745bc6dd8/contract';
import startContract from '../../snapshots/f880b368b4088ede3fae698d420b09a3339cb1c2f203415e0cb0197745bc6dd8/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'accountControlEvidence',
        columns: [
          col('accountLabel', 'text', {
            notNull: true,
            default: lit(''),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('checkedBy', 'text', {
            notNull: true,
            default: lit(''),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('cloudAccountId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('controlId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('observation', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('observedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'accountControlEvidence',
        constraint: 'accountControlEvidence_projectId_controlId_key',
        columns: ['projectId', 'controlId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'accountControlEvidence',
        index: 'accountControlEvidence_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'accountControlEvidence',
        foreignKey: {
          name: 'accountControlEvidence_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

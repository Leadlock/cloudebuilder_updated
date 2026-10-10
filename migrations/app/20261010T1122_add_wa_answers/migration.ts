#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/81440819645ba36dfa5a0446ae8f8e2e9bd27b1ec43c4eae9856d942174b5e9a/contract';
import startContract from '../../snapshots/81440819645ba36dfa5a0446ae8f8e2e9bd27b1ec43c4eae9856d942174b5e9a/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/f880b368b4088ede3fae698d420b09a3339cb1c2f203415e0cb0197745bc6dd8/contract';
import endContract from '../../snapshots/f880b368b4088ede3fae698d420b09a3339cb1c2f203415e0cb0197745bc6dd8/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'wellArchitectedAnswer',
        columns: [
          col('answer', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('answeredBy', 'text', {
            notNull: true,
            default: lit(''),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', {
            notNull: true,
            default: lit(''),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('questionId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'wellArchitectedAnswer',
        constraint: 'wellArchitectedAnswer_projectId_questionId_key',
        columns: ['projectId', 'questionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'wellArchitectedAnswer',
        index: 'wellArchitectedAnswer_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'wellArchitectedAnswer',
        foreignKey: {
          name: 'wellArchitectedAnswer_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

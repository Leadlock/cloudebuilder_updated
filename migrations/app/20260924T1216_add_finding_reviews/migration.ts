#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/a61af368dd73848610d6d33b031dca54c99a49efe389a9c56e1793d9ea894270/contract';
import endContract from '../../snapshots/a61af368dd73848610d6d33b031dca54c99a49efe389a9c56e1793d9ea894270/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/a9f4a309c0b3e053bf48a5172aa8e2285b8d3113b2fc0b93bb01616856d0462c/contract';
import startContract from '../../snapshots/a9f4a309c0b3e053bf48a5172aa8e2285b8d3113b2fc0b93bb01616856d0462c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'findingReview',
        columns: [
          col('approvedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('approvedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('findingId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reason', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('revokedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('revokedBy', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('ruleId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'findingReview',
        index: 'findingReview_projectId_findingId_idx_2df325f5',
        columns: ['projectId', 'findingId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'findingReview',
        index: 'findingReview_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'findingReview',
        foreignKey: {
          name: 'findingReview_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

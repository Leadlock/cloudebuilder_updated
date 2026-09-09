#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/37af7a77321ba4fe2da02a7c7c754bc56e5e6122ee58aa1b340d9f58245c2525/contract';
import startContract from '../../snapshots/37af7a77321ba4fe2da02a7c7c754bc56e5e6122ee58aa1b340d9f58245c2525/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/3b1979b05f8b997dd13b64880391a3ef0559fa1090c4b37fd4d932653e984d7c/contract';
import endContract from '../../snapshots/3b1979b05f8b997dd13b64880391a3ef0559fa1090c4b37fd4d932653e984d7c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'cloudAccount',
        columns: [
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('credentialsJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('identityJson', 'text', {
            notNull: true,
            default: lit('{}'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('lastValidatedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('provider', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('pending'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'discoveryRun',
        columns: [
          col('cloudAccountId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('completedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('error', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('resourcesJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('startedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('pending'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('summaryJson', 'text', {
            notNull: true,
            default: lit('{}'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'cloudAccount',
        index: 'cloudAccount_orgId_idx_c5e5aabe',
        columns: ['orgId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'discoveryRun',
        index: 'discoveryRun_cloudAccountId_idx_b72ac661',
        columns: ['cloudAccountId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'cloudAccount',
        foreignKey: {
          name: 'cloudAccount_orgId_fkey',
          columns: ['orgId'],
          references: { schema: 'public', table: 'organization', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'discoveryRun',
        foreignKey: {
          name: 'discoveryRun_cloudAccountId_fkey',
          columns: ['cloudAccountId'],
          references: { schema: 'public', table: 'cloudAccount', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/53667c3a3c43a309729c004a3b6991da16e28bfad2f8bd2431a4a9ad79c68e9f/contract';
import endContract from '../../snapshots/53667c3a3c43a309729c004a3b6991da16e28bfad2f8bd2431a4a9ad79c68e9f/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d420dc7309251c8c6148cb90ba225b02bb817acd63f6e912bd7c950c070074b1/contract';
import startContract from '../../snapshots/d420dc7309251c8c6148cb90ba225b02bb817acd63f6e912bd7c950c070074b1/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'apiKey',
        columns: [
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('includeBuiltin', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('includeOwn', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('keyHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('keyPrefix', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('lastUsedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('revokedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('scope', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'apiKey',
        constraint: 'apiKey_keyHash_key',
        columns: ['keyHash'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'apiKey',
        index: 'apiKey_orgId_idx_c5e5aabe',
        columns: ['orgId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

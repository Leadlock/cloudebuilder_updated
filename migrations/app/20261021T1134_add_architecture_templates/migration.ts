#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/5d5e21b651aa807330e6db3599f64737318a18eedcf3607abd46a30c059bd72e/contract';
import startContract from '../../snapshots/5d5e21b651aa807330e6db3599f64737318a18eedcf3607abd46a30c059bd72e/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d420dc7309251c8c6148cb90ba225b02bb817acd63f6e912bd7c950c070074b1/contract';
import endContract from '../../snapshots/d420dc7309251c8c6148cb90ba225b02bb817acd63f6e912bd7c950c070074b1/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'architectureTemplate',
        columns: [
          col('category', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('complexity', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('contentHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdBy', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('description', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('estimatedCost', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('featuresJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('graphJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('metaJson', 'text', {
            notNull: true,
            default: lit('{}'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('provider', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('resourceCount', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('tagsJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'architectureTemplate',
        index: 'architectureTemplate_orgId_idx_c5e5aabe',
        columns: ['orgId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'architectureTemplate',
        index: 'architectureTemplate_source_idx_c937a07d',
        columns: ['source'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

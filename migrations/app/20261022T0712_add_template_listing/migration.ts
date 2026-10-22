#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/53667c3a3c43a309729c004a3b6991da16e28bfad2f8bd2431a4a9ad79c68e9f/contract';
import startContract from '../../snapshots/53667c3a3c43a309729c004a3b6991da16e28bfad2f8bd2431a4a9ad79c68e9f/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/6d64572a0d0c10f4b6eae901755a22f7f7186a9f2d5ef5458799f969be8caf88/contract';
import endContract from '../../snapshots/6d64572a0d0c10f4b6eae901755a22f7f7186a9f2d5ef5458799f969be8caf88/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'templateListing',
        columns: [
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('listingJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('templateId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedBy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'templateListing',
        index: 'templateListing_orgId_idx_c5e5aabe',
        columns: ['orgId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/9a378bfb3956a6c13c2d39384fbf698f46960cc34c36f05733459ec1ece6b866/contract';
import endContract from '../../snapshots/9a378bfb3956a6c13c2d39384fbf698f46960cc34c36f05733459ec1ece6b866/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e93966cf06f92708de12b9327127d88570069c17c200b479d2ce101bf690e4ad/contract';
import startContract from '../../snapshots/e93966cf06f92708de12b9327127d88570069c17c200b479d2ce101bf690e4ad/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'rateLimitBucket',
        columns: [
          col('count', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('expiresAtMs', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('key', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('windowStartMs', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
        ],
        constraints: [primaryKey(['key'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'revokedSession',
        columns: [
          col('expiresAtMs', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('revokedAtMs', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('userId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'rateLimitBucket',
        index: 'rateLimitBucket_expiresAtMs_idx_89d46aa4',
        columns: ['expiresAtMs'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'revokedSession',
        index: 'revokedSession_expiresAtMs_idx_89d46aa4',
        columns: ['expiresAtMs'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

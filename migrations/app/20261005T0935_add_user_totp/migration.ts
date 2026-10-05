#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/4e52db63200a9cef1691eaad77e0cbda346bc475db35c372e4f1e551ef7a5984/contract';
import endContract from '../../snapshots/4e52db63200a9cef1691eaad77e0cbda346bc475db35c372e4f1e551ef7a5984/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/5ec0a56099dc1f3c7a677c934b3a57b5744dffd268a580996ec1194aa3378e76/contract';
import startContract from '../../snapshots/5ec0a56099dc1f3c7a677c934b3a57b5744dffd268a580996ec1194aa3378e76/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'userTotp',
        columns: [
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('enabled', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('lastStep', 'float8', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/float8@1' },
          }),
          col('recoveryJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('secretEnc', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['userId'])],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

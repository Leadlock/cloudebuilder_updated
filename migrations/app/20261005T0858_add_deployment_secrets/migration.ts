#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/5ec0a56099dc1f3c7a677c934b3a57b5744dffd268a580996ec1194aa3378e76/contract';
import endContract from '../../snapshots/5ec0a56099dc1f3c7a677c934b3a57b5744dffd268a580996ec1194aa3378e76/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/6b0817c3a48172f0fa480046ff296c943318a81e2601a56eebfd035ce7808563/contract';
import startContract from '../../snapshots/6b0817c3a48172f0fa480046ff296c943318a81e2601a56eebfd035ce7808563/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'deploymentSecret',
        columns: [
          col('cloudAccountId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('valueEnc', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'deploymentSecret',
        index: 'deploymentSecret_cloudAccountId_idx_b72ac661',
        columns: ['cloudAccountId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

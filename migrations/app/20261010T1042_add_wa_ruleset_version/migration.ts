#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/4e52db63200a9cef1691eaad77e0cbda346bc475db35c372e4f1e551ef7a5984/contract';
import startContract from '../../snapshots/4e52db63200a9cef1691eaad77e0cbda346bc475db35c372e4f1e551ef7a5984/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/81440819645ba36dfa5a0446ae8f8e2e9bd27b1ec43c4eae9856d942174b5e9a/contract';
import endContract from '../../snapshots/81440819645ba36dfa5a0446ae8f8e2e9bd27b1ec43c4eae9856d942174b5e9a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'wellArchitectedAssessment',
        column: col('rulesetVersion', 'text', {
          notNull: true,
          default: lit(''),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

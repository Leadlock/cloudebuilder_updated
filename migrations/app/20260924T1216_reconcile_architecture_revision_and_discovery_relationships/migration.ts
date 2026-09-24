#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/79268ef74b521df6aac080e5fbab8fcb1cf14a15e9ed96dc1c117ef4c3721607/contract';
import startContract from '../../snapshots/79268ef74b521df6aac080e5fbab8fcb1cf14a15e9ed96dc1c117ef4c3721607/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/a9f4a309c0b3e053bf48a5172aa8e2285b8d3113b2fc0b93bb01616856d0462c/contract';
import endContract from '../../snapshots/a9f4a309c0b3e053bf48a5172aa8e2285b8d3113b2fc0b93bb01616856d0462c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'architecture',
        column: col('revision', 'int4', {
          notNull: true,
          default: lit(1),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'discoveryRun',
        column: col('relationshipsJson', 'text', {
          notNull: true,
          default: lit('[]'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

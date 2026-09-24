# `db migrate` MARKER_MISMATCH: cause and fix

## Symptom

```
MIGRATION.MARKER_MISMATCH — Database marker is not reachable in the on-disk migration graph
DB marker is a9f4a309…, but the on-disk migration graph reaches: 37af…, 3b19…, 23bb…, 4680…, 7926…, empty.
```

## Cause

In commit `497a342` the migration `20260918T0538_reconcile_untracked_tables` was planned
(graph tip `79268ef7…`). The contract was then edited again, adding
`architecture.revision` and `discoveryRun.relationshipsJson`, without planning another
migration. The databases were brought up to date with `prisma db update` / `db init`.
Those commands write the **contract** hash as the database marker and advanced the `db`
ref to it, so both became `a9f4a309…`. No migration produced `a9f4…`, and `db migrate`
refuses to run against a marker outside the graph.

## Fix (no data reset)

The unshipped branch migration `add_finding_reviews` (`7926… → a61a…`) was replaced by a
linear pair:

1. `20260924T1216_reconcile_architecture_revision_and_discovery_relationships`:
   `7926… → a9f4…`. Adds the two drifted columns, both NOT NULL with defaults
   (`revision` default 1, `relationshipsJson` default `'[]'`).
2. `20260924T1216_add_finding_reviews`: `a9f4… → a61a…`. Adds the `findingReview` table
   and its indexes and foreign key.

`a9f4…` is now a graph node, so every database state has a path to the current contract.

| Database state | `db migrate` result (verified on PostgreSQL 16) |
|---|---|
| Empty | All 7 migrations; `db verify` ok |
| Created or synced with `db init`/`db update` at `a9f4…` (with data) | Applies only `add_finding_reviews`; rows preserved; `db verify` ok |
| Migrated to the old tip `7926…` (with data) | Applies both new migrations; rows preserved; `db verify` ok |
| At `a61a…` (ran the replaced migration) | Already up to date; `db verify` ok |

## Prevention

`__tests__/migrationGraph.test.ts` fails CI when:

- the contract hash is not a graph node;
- the `db` ref is not the contract hash;
- the graph forks;
- a snapshot is missing.

When editing `contract.prisma`, run `prisma migration plan` and commit the migration together
with the contract. Use `db update` only for local experiments.

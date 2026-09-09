#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/23bb7d5a29f34f260fe2e9debd7c874ef71935cf2f3d3410789bef7a87c3a9ae/contract';
import endContract from '../../snapshots/23bb7d5a29f34f260fe2e9debd7c874ef71935cf2f3d3410789bef7a87c3a9ae/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/3b1979b05f8b997dd13b64880391a3ef0559fa1090c4b37fd4d932653e984d7c/contract';
import startContract from '../../snapshots/3b1979b05f8b997dd13b64880391a3ef0559fa1090c4b37fd4d932653e984d7c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'archOptimization',
        columns: [
          col('architectureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('recommendationsJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('scoreJson', 'text', {
            notNull: true,
            default: lit('{}'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('versionId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'costEstimate',
        columns: [
          col('architectureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('assumptionsJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('confidence', 'text', {
            notNull: true,
            default: lit('estimate'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('currency', 'text', {
            notNull: true,
            default: lit('USD'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('itemsJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('pricingSource', 'text', {
            notNull: true,
            default: lit('static-list-price'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('totalHourly', 'float8', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/float8@1' },
          }),
          col('totalMonthly', 'float8', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/float8@1' },
          }),
          col('versionId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'securityFinding',
        columns: [
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('description', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('metaJson', 'text', {
            notNull: true,
            default: lit('{}'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('provider', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('remediation', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('resourceId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('resourceType', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('ruleId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('scanId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('severity', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'securityScan',
        columns: [
          col('architectureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('completedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('findingsJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('score', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('completed'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('versionId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'terraformGeneration',
        columns: [
          col('architectureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('filesJson', 'text', {
            notNull: true,
            default: lit('{}'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('resourceMapJson', 'text', {
            notNull: true,
            default: lit('{}'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('versionId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('warningsJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'archOptimization',
        index: 'archOptimization_architectureId_idx_a096837f',
        columns: ['architectureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'archOptimization',
        index: 'archOptimization_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'costEstimate',
        index: 'costEstimate_architectureId_idx_a096837f',
        columns: ['architectureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'costEstimate',
        index: 'costEstimate_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'securityFinding',
        index: 'securityFinding_scanId_idx_7c201901',
        columns: ['scanId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'securityScan',
        index: 'securityScan_architectureId_idx_a096837f',
        columns: ['architectureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'securityScan',
        index: 'securityScan_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'terraformGeneration',
        index: 'terraformGeneration_architectureId_idx_a096837f',
        columns: ['architectureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'terraformGeneration',
        index: 'terraformGeneration_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'archOptimization',
        foreignKey: {
          name: 'archOptimization_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'archOptimization',
        foreignKey: {
          name: 'archOptimization_architectureId_fkey',
          columns: ['architectureId'],
          references: { schema: 'public', table: 'architecture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'costEstimate',
        foreignKey: {
          name: 'costEstimate_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'costEstimate',
        foreignKey: {
          name: 'costEstimate_architectureId_fkey',
          columns: ['architectureId'],
          references: { schema: 'public', table: 'architecture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'securityFinding',
        foreignKey: {
          name: 'securityFinding_scanId_fkey',
          columns: ['scanId'],
          references: { schema: 'public', table: 'securityScan', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'securityScan',
        foreignKey: {
          name: 'securityScan_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'securityScan',
        foreignKey: {
          name: 'securityScan_architectureId_fkey',
          columns: ['architectureId'],
          references: { schema: 'public', table: 'architecture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'terraformGeneration',
        foreignKey: {
          name: 'terraformGeneration_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'terraformGeneration',
        foreignKey: {
          name: 'terraformGeneration_architectureId_fkey',
          columns: ['architectureId'],
          references: { schema: 'public', table: 'architecture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

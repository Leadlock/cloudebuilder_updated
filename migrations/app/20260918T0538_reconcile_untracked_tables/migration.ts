#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/4680ce61201a4fbea2cfd440bd095427c8858086471463489fc783b7bc71e33f/contract';
import startContract from '../../snapshots/4680ce61201a4fbea2cfd440bd095427c8858086471463489fc783b7bc71e33f/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/79268ef74b521df6aac080e5fbab8fcb1cf14a15e9ed96dc1c117ef4c3721607/contract';
import endContract from '../../snapshots/79268ef74b521df6aac080e5fbab8fcb1cf14a15e9ed96dc1c117ef4c3721607/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'aIGenerationHistory',
        columns: [
          col('architectureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('architectureJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('completedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model', 'text', {
            notNull: true,
            default: lit('gemini-1.5-pro'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('prompt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('provider', 'text', {
            notNull: true,
            default: lit('gemini'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('completed'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'complianceAssessment',
        columns: [
          col('architectureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('completedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('findingsJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('overallScore', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('completed'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'complianceFinding',
        columns: [
          col('affectedResourceIds', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('assessmentId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('controlId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('description', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('recommendation', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('remediation', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('ruleId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('severity', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'exportJob',
        columns: [
          col('architectureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('format', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('completed'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('url', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'gitOperation',
        columns: [
          col('commitSha', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('operationType', 'text', {
            notNull: true,
            default: lit('commit'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('prUrl', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('pending'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'githubConnection',
        columns: [
          col('branch', 'text', {
            notNull: true,
            default: lit('main'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('githubOrg', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('githubRepo', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('installationId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('active'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'aIGenerationHistory',
        index: 'aIGenerationHistory_architectureId_idx_a096837f',
        columns: ['architectureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'aIGenerationHistory',
        index: 'aIGenerationHistory_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'architectureResource',
        index: 'architectureResource_architectureId_resourceType_idx_762fe503',
        columns: ['architectureId', 'resourceType'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'complianceAssessment',
        index: 'complianceAssessment_architectureId_idx_a096837f',
        columns: ['architectureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'complianceAssessment',
        index: 'complianceAssessment_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'complianceFinding',
        index: 'complianceFinding_assessmentId_idx_1fe05216',
        columns: ['assessmentId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'exportJob',
        index: 'exportJob_architectureId_idx_a096837f',
        columns: ['architectureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'exportJob',
        index: 'exportJob_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'gitOperation',
        index: 'gitOperation_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'githubConnection',
        index: 'githubConnection_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'aIGenerationHistory',
        foreignKey: {
          name: 'aIGenerationHistory_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'aIGenerationHistory',
        foreignKey: {
          name: 'aIGenerationHistory_architectureId_fkey',
          columns: ['architectureId'],
          references: { schema: 'public', table: 'architecture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'complianceAssessment',
        foreignKey: {
          name: 'complianceAssessment_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'complianceAssessment',
        foreignKey: {
          name: 'complianceAssessment_architectureId_fkey',
          columns: ['architectureId'],
          references: { schema: 'public', table: 'architecture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'complianceFinding',
        foreignKey: {
          name: 'complianceFinding_assessmentId_fkey',
          columns: ['assessmentId'],
          references: { schema: 'public', table: 'complianceAssessment', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'exportJob',
        foreignKey: {
          name: 'exportJob_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'exportJob',
        foreignKey: {
          name: 'exportJob_architectureId_fkey',
          columns: ['architectureId'],
          references: { schema: 'public', table: 'architecture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'gitOperation',
        foreignKey: {
          name: 'gitOperation_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'githubConnection',
        foreignKey: {
          name: 'githubConnection_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

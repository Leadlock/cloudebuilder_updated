#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/23bb7d5a29f34f260fe2e9debd7c874ef71935cf2f3d3410789bef7a87c3a9ae/contract';
import startContract from '../../snapshots/23bb7d5a29f34f260fe2e9debd7c874ef71935cf2f3d3410789bef7a87c3a9ae/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/4680ce61201a4fbea2cfd440bd095427c8858086471463489fc783b7bc71e33f/contract';
import endContract from '../../snapshots/4680ce61201a4fbea2cfd440bd095427c8858086471463489fc783b7bc71e33f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'currencyExchangeRate',
        columns: [
          col('baseCurrency', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('rate', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('retrievedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('targetCurrency', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'orgInvite',
        columns: [
          col('acceptedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('invitedByUserId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orgId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('role', 'text', {
            notNull: true,
            default: lit('member'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('token', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'wellArchitectedAssessment',
        columns: [
          col('architectureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('completedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('confidence', 'text', {
            notNull: true,
            default: lit('design-time'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('createdAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('findingsJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('framework', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('frameworkVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('isStale', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('overallScore', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('pillarScoresJson', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('projectId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('provider', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sourceLabel', 'text', {
            notNull: true,
            default: lit('Design-time assessment'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'wellArchitectedFinding',
        columns: [
          col('affectedResourceIds', 'text', {
            notNull: true,
            default: lit('[]'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('assessmentId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('description', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('detectedAt', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('evidenceJson', 'text', {
            notNull: true,
            default: lit('{}'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('frameworkReference', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('pillar', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('pillarLabel', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('pillarRef', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('provider', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('recommendation', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('remediation', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('resourceState', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('ruleId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('severity', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sourceLabel', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'user',
        column: col('passwordHash', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addUnique({
        schema: 'public',
        table: 'currencyExchangeRate',
        constraint: 'currencyExchangeRate_baseCurrency_targetCurrency_key',
        columns: ['baseCurrency', 'targetCurrency'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'orgInvite',
        constraint: 'orgInvite_token_key',
        columns: ['token'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'currencyExchangeRate',
        index: 'currencyExchangeRate_baseCurrency_targetCurrency_idx_7672893a',
        columns: ['baseCurrency', 'targetCurrency'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orgInvite',
        index: 'orgInvite_email_idx_46df9cad',
        columns: ['email'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orgInvite',
        index: 'orgInvite_orgId_idx_c5e5aabe',
        columns: ['orgId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'wellArchitectedAssessment',
        index: 'wellArchitectedAssessment_architectureId_idx_a096837f',
        columns: ['architectureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'wellArchitectedAssessment',
        index: 'wellArchitectedAssessment_projectId_idx_a96e4d92',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'wellArchitectedFinding',
        index: 'wellArchitectedFinding_assessmentId_idx_1fe05216',
        columns: ['assessmentId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orgInvite',
        foreignKey: {
          name: 'orgInvite_orgId_fkey',
          columns: ['orgId'],
          references: { schema: 'public', table: 'organization', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'wellArchitectedAssessment',
        foreignKey: {
          name: 'wellArchitectedAssessment_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'public', table: 'project', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'wellArchitectedAssessment',
        foreignKey: {
          name: 'wellArchitectedAssessment_architectureId_fkey',
          columns: ['architectureId'],
          references: { schema: 'public', table: 'architecture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'wellArchitectedFinding',
        foreignKey: {
          name: 'wellArchitectedFinding_assessmentId_fkey',
          columns: ['assessmentId'],
          references: { schema: 'public', table: 'wellArchitectedAssessment', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

/**
 * WellArchitectedAnswerRepository — answers to the Well-Architected questionnaire.
 *
 * Answers describe how the WORKLOAD is run (backups restored, on-call, who owns the budget), so they belong to the project and are
 * shared by every environment of it. One row per project and question.
 *
 * Rules (same as the other repositories): callers authorise first; this only touches rows of the project it is given.
 */
import { db } from '@/src/prisma/db';
import { randomUUID as uuidv4 } from 'crypto';
import type { QuestionAnswer, QuestionnaireAnswers } from '@/lib/engines/assessment/questionnaire/questions';

export interface AnswerChange {
  questionId: string;
  /** null clears the answer (the question is unanswered again). */
  answer: QuestionAnswer | null;
  note?: string;
}

export interface StoredAnswerRow {
  questionId: string;
  answer: QuestionAnswer;
  note: string;
  answeredBy: string;
  updatedAt: string;
}

const now = () => new Date().toISOString();

export const wellArchitectedAnswerRepository = {
  /** Every answer of the project. */
  async list(projectId: string): Promise<StoredAnswerRow[]> {
    const rows = await db.orm.public.WellArchitectedAnswer.where({ projectId }).all();
    return rows.map((r) => ({
      questionId: r.questionId, answer: r.answer as QuestionAnswer, note: r.note ?? '', answeredBy: r.answeredBy ?? '', updatedAt: r.updatedAt,
    }));
  },

  /** The answers in the shape the engine takes. */
  async answersFor(projectId: string): Promise<QuestionnaireAnswers> {
    const out: QuestionnaireAnswers = {};
    for (const r of await this.list(projectId)) out[r.questionId] = { answer: r.answer, ...(r.note ? { note: r.note } : {}) };
    return out;
  },

  /** When the questionnaire was last changed, or null when nothing has been answered. Lets a saved review be marked stale. */
  async lastChangedAt(projectId: string): Promise<string | null> {
    const rows = await this.list(projectId);
    return rows.length === 0 ? null : rows.map((r) => r.updatedAt).sort().at(-1)!;
  },

  /** Save a batch. Question ids must already have been validated against the catalog by the caller. */
  async apply(projectId: string, changes: AnswerChange[], userId: string): Promise<void> {
    const ts = now();
    for (const c of changes) {
      const existing = await db.orm.public.WellArchitectedAnswer.where({ projectId, questionId: c.questionId }).first();
      if (c.answer === null) {
        if (existing) await db.orm.public.WellArchitectedAnswer.where({ projectId, questionId: c.questionId }).delete();
        continue;
      }
      if (existing) {
        await db.orm.public.WellArchitectedAnswer.where({ projectId, questionId: c.questionId }).update({
          answer: c.answer, note: c.note ?? existing.note ?? '', answeredBy: userId, updatedAt: ts,
        });
      } else {
        await db.orm.public.WellArchitectedAnswer.create({
          id: uuidv4(), projectId, questionId: c.questionId, answer: c.answer, note: c.note ?? '', answeredBy: userId, createdAt: ts, updatedAt: ts,
        });
      }
    }
  },
};

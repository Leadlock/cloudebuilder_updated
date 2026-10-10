import { z } from 'zod';
import { QUESTION_ANSWERS } from '@/lib/engines/assessment/questionnaire/questions';

/** Body of PUT /api/projects/:id/well-architected/questions. `answer: null` clears an answer. */
export const AnswersSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().min(1).max(40),
    answer: z.enum(QUESTION_ANSWERS as unknown as [string, ...string[]]).nullable(),
    note: z.string().max(500).optional(),
  })).min(1).max(100),
});

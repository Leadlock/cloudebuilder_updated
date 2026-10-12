/**
 * The questionnaire answers a Well-Architected analysis should include, for the routes that run one.
 *
 * Returns undefined when nothing has been answered, so a project that has not started the questionnaire is assessed exactly as before
 * (and a database problem here never stops a review from running: it just runs without the questionnaire).
 */
import { wellArchitectedAnswerRepository } from '@/lib/repositories/wellArchitectedAnswerRepository';
import type { WaAnalysisInput } from '@/lib/engines/wellArchitected/types';

export async function loadQuestionnaire(projectId: string): Promise<WaAnalysisInput['questionnaire']> {
  try {
    const answers = await wellArchitectedAnswerRepository.answersFor(projectId);
    return Object.keys(answers).length > 0 ? { answers } : undefined;
  } catch (err) {
    console.warn('[WA questionnaire] could not load answers; analysing without them:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

'use client';
/**
 * Well-Architected questionnaire: the practices a diagram cannot show (backups restored, on-call, who owns the budget).
 *
 * Answers save as you click, and the review re-runs shortly after you stop. A selected option can be clicked again to clear it.
 * Until the first answer the review uses automated checks only; after that every unanswered question counts as "not evaluated"
 * (lowering coverage), never as a pass.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, ClipboardList, Loader2 } from 'lucide-react';
import { apiWellArchitectedService, type QuestionnaireData, type QuestionnaireQuestion } from '@/lib/services/ApiWellArchitectedService';
import { ANSWER_LABEL, QUESTION_ANSWERS, type QuestionAnswer } from '@/lib/engines/assessment/questionnaire/questions';

const PILLAR_ORDER = ['operational_excellence', 'security', 'reliability', 'performance_efficiency', 'cost_optimization', 'sustainability'];
const RERUN_AFTER_MS = 900;

interface Props {
  /** Clouds the design uses; decides which questions apply (Sustainability is an AWS pillar only). */
  providers: Array<'aws' | 'azure'>;
  isLight: boolean;
  /** Called a moment after the person stops answering, so the review can be re-run. */
  onAnswered: () => void;
  /** Why the questionnaire cannot be used (for example an unsaved draft). */
  disabledReason?: string;
}

const SEVERITY_STYLE: Record<QuestionnaireQuestion['severity'], { label: string; light: string; dark: string }> = {
  HIGH: { label: 'High impact', light: 'text-rose-700 bg-rose-50 border-rose-200', dark: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
  MEDIUM: { label: 'Medium impact', light: 'text-amber-700 bg-amber-50 border-amber-200', dark: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  LOW: { label: 'Low impact', light: 'text-slate-600 bg-slate-50 border-slate-200', dark: 'text-slate-300 bg-slate-500/10 border-slate-500/30' },
};

export default function WaQuestionnaire({ providers, isLight, onAnswered, disabledReason }: Props) {
  const [data, setData] = useState<QuestionnaireData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [openPillar, setOpenPillar] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    if (disabledReason) return; // nothing to load; the disabled message is shown instead
    void apiWellArchitectedService.getQuestionnaire().then((d) => {
      if (!alive) return;
      setData(d);
      setLoading(false);
      if (!d) setError('The questionnaire could not be loaded.');
    });
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [disabledReason]);

  const questions = useMemo(
    () => (data?.questions ?? []).filter((q) => q.providers.some((p) => providers.includes(p))),
    [data, providers],
  );
  const byPillar = useMemo(() => {
    const m = new Map<string, QuestionnaireQuestion[]>();
    for (const q of questions) m.set(q.pillar, [...(m.get(q.pillar) ?? []), q]);
    return PILLAR_ORDER.filter((p) => m.has(p)).map((p) => ({ pillar: p, label: m.get(p)![0]!.pillarLabel, items: m.get(p)! }));
  }, [questions]);

  const answered = questions.filter((q) => data?.answers[q.id]).length;

  async function save(questionId: string, answer: QuestionAnswer | null, note?: string) {
    setError(null);
    setSaving((s) => ({ ...s, [questionId]: true }));
    // Show the choice at once; the server's reply replaces it.
    setData((d) => d && ({
      ...d,
      answers: answer === null
        ? Object.fromEntries(Object.entries(d.answers).filter(([k]) => k !== questionId))
        : { ...d.answers, [questionId]: { answer, note: note ?? d.answers[questionId]?.note ?? '', updatedAt: new Date().toISOString() } },
    }));
    try {
      const fresh = await apiWellArchitectedService.saveAnswers([{ questionId, answer, ...(note !== undefined ? { note } : {}) }]);
      setData(fresh);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(onAnswered, RERUN_AFTER_MS);
    } catch (e) {
      setError(e instanceof Error ? `That answer was not saved: ${e.message}` : 'That answer was not saved.');
      const reload = await apiWellArchitectedService.getQuestionnaire();
      if (reload) setData(reload);
    } finally {
      setSaving((s) => ({ ...s, [questionId]: false }));
    }
  }

  const card = clsx('rounded-2xl border p-5', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800');
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';

  if (disabledReason) {
    return (
      <div className={card}>
        <div className="flex items-center gap-2"><ClipboardList className="w-4 h-4 text-cyan-500" /><h2 className={clsx('text-base font-bold', isLight ? 'text-slate-900' : 'text-white')}>Questionnaire</h2></div>
        <p className={clsx('text-xs mt-2', muted)}>{disabledReason}</p>
      </div>
    );
  }

  return (
    <div className={card}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex flex-wrap items-center justify-between gap-2 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-cyan-500" />
          <span className={clsx('text-base font-bold', isLight ? 'text-slate-900' : 'text-white')}>Questionnaire</span>
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin opacity-60" />}
        </span>
        <span className={clsx('flex items-center gap-2 text-xs', muted)}>
          {!loading && data && <span><b className={isLight ? 'text-slate-800' : 'text-slate-200'}>{answered}</b> of {questions.length} answered</span>}
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
      </button>

      {!loading && data && questions.length > 0 && (
        <div className={clsx('mt-3 w-full rounded-full h-1.5 overflow-hidden', isLight ? 'bg-slate-100' : 'bg-slate-800')} aria-hidden="true">
          <div className="h-full bg-cyan-500 transition-all" style={{ width: `${Math.round((answered / questions.length) * 100)}%` }} />
        </div>
      )}

      <p className={clsx('text-[11px] mt-2', muted)}>
        These are the practices a diagram can&apos;t show, such as whether backups have been restored, who is on call and who owns the budget. Each answer becomes a check in its pillar.
        {answered === 0
          ? ' Until you answer one, the review uses the automated checks only.'
          : ' Unanswered questions now count as not evaluated (they lower coverage) and are never treated as passes.'}
      </p>
      {error && <p className={clsx('text-xs mt-2', isLight ? 'text-rose-700' : 'text-rose-300')} role="alert">{error}</p>}

      {open && data && (
        <div className="mt-4 space-y-3">
          {byPillar.map(({ pillar, label, items }) => {
            const done = items.filter((q) => data.answers[q.id]).length;
            const expanded = openPillar === pillar;
            return (
              <div key={pillar} className={clsx('rounded-xl border', isLight ? 'border-slate-200' : 'border-slate-800')}>
                <button type="button" onClick={() => setOpenPillar(expanded ? null : pillar)} aria-expanded={expanded}
                  className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left">
                  <span className={clsx('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{label}</span>
                  <span className={clsx('flex items-center gap-2 text-xs', muted)}>
                    {done} of {items.length}
                    {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </span>
                </button>

                {expanded && (
                  <ul className={clsx('divide-y', isLight ? 'divide-slate-100 border-t border-slate-100' : 'divide-slate-800 border-t border-slate-800')}>
                    {items.map((q) => {
                      const current = data.answers[q.id];
                      const sev = SEVERITY_STYLE[q.severity];
                      return (
                        <li key={q.id} className="px-4 py-4 space-y-2.5">
                          <div className="flex flex-wrap items-start gap-2">
                            <p className={clsx('text-sm flex-1 min-w-[16rem]', isLight ? 'text-slate-900' : 'text-slate-100')}>{q.question}</p>
                            <span className={clsx('text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border', isLight ? sev.light : sev.dark)}>{sev.label}</span>
                          </div>
                          <p className={clsx('text-[11px]', muted)}>{q.why}</p>

                          <div role="radiogroup" aria-label={q.question} className="flex flex-wrap gap-1.5">
                            {QUESTION_ANSWERS.map((a) => {
                              const selected = current?.answer === a;
                              return (
                                <button
                                  key={a} type="button" role="radio" aria-checked={selected}
                                  onClick={() => void save(q.id, selected ? null : a)}
                                  className={clsx(
                                    'px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                                    selected
                                      ? (isLight ? 'bg-cyan-600 border-cyan-600 text-white' : 'bg-cyan-500/20 border-cyan-400 text-cyan-200')
                                      : (isLight ? 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50' : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'),
                                  )}
                                >
                                  {ANSWER_LABEL[a]}
                                </button>
                              );
                            })}
                            {saving[q.id] && <Loader2 className="w-3.5 h-3.5 animate-spin self-center opacity-60" />}
                          </div>

                          {(current?.answer === 'partial' || current?.answer === 'no') && (
                            <div className={clsx('text-[11px] rounded-lg border px-3 py-2', isLight ? 'bg-amber-50/60 border-amber-200 text-amber-900' : 'bg-amber-500/5 border-amber-500/20 text-amber-200')}>
                              <b>What good looks like:</b> {q.recommendation}
                            </div>
                          )}

                          {current && (
                            <textarea
                              aria-label={`Note for: ${q.question}`}
                              maxLength={500} rows={2} placeholder="Optional note (who owns it, link to the runbook, why it does not apply)…"
                              value={notes[q.id] ?? current.note ?? ''}
                              onChange={(e) => setNotes((n) => ({ ...n, [q.id]: e.target.value }))}
                              onBlur={() => { const v = (notes[q.id] ?? current.note ?? '').trim(); if (v !== (current.note ?? '').trim()) void save(q.id, current.answer, v); }}
                              className={clsx('w-full rounded-lg border px-3 py-2 text-xs resize-y', isLight ? 'bg-white border-slate-300 text-slate-800' : 'bg-slate-950 border-slate-700 text-slate-200')}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

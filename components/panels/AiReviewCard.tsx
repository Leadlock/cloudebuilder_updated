'use client';
import { useState } from 'react';
import { Sparkles, Loader2, AlertTriangle, CheckCircle2, Send, BookOpen, Lightbulb } from 'lucide-react';
import clsx from 'clsx';
import type { CanvasNode, CanvasEdge } from '@/types';
import type { AiReviewResult, AiSecurityReview, AiSecurityPriority, AiWellArchitectedReview, AiReviewMode } from '@/lib/services/AiReviewService';
import { useApp } from '@/context/AppContext';

const SEVERITY_STYLE_DARK: Record<string, string> = {
  critical: 'text-red-300 bg-red-900/30 border-red-800',
  high: 'text-orange-300 bg-orange-900/30 border-orange-800',
  medium: 'text-yellow-300 bg-yellow-900/30 border-yellow-800',
  low: 'text-blue-300 bg-blue-900/30 border-blue-800',
  informational: 'text-slate-300 bg-slate-800 border-slate-700',
};

const SEVERITY_STYLE_LIGHT: Record<string, string> = {
  critical: 'text-red-700 bg-red-50 border-red-200',
  high: 'text-orange-700 bg-orange-50 border-orange-200',
  medium: 'text-amber-700 bg-amber-50 border-amber-200',
  low: 'text-blue-700 bg-blue-50 border-blue-200',
  informational: 'text-slate-700 bg-slate-100 border-slate-200',
};

const sevClass = (s: string, isLight = false) => {
  const styles = isLight ? SEVERITY_STYLE_LIGHT : SEVERITY_STYLE_DARK;
  return styles[s] ?? styles.informational;
};

const COPY: Record<AiReviewMode, { title: string; button: string; placeholder: string; footer: string }> = {
  general: {
    title: 'AI Architecture Review', button: 'Review with AI',
    placeholder: 'Ask about this architecture, e.g. why is my security score low?',
    footer: 'the AI explains and prioritises them using the knowledge base.',
  },
  security: {
    title: 'AI Security Review', button: 'Review security with AI',
    placeholder: 'Ask about security, e.g. what should I fix before going live?',
    footer: 'the AI explains, groups and prioritises the findings; it does not change them.',
  },
  'well-architected': {
    title: 'AI Well-Architected Review', button: 'Review pillars with AI',
    placeholder: 'Ask about the pillars, e.g. why is reliability weak?',
    footer: 'the AI explains each pillar and orders the fixes; it does not change scores.',
  },
};

export type AnyReview = AiReviewResult | AiSecurityReview | AiWellArchitectedReview;

export default function AiReviewCard({ nodes, edges, mode = 'general', onReview }: { nodes: CanvasNode[]; edges: CanvasEdge[]; mode?: AiReviewMode; /** Called with each completed review (and the nodes it was run on) so a parent can reuse it, e.g. in an export. */ onReview?: (review: AnyReview, nodes: CanvasNode[]) => void }) {
  // useApp never throws: outside the provider it returns the initial state, so no try/catch is needed (and a hook inside one is flagged).
  const { state } = useApp();
  const isLight = state?.theme === 'light';
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<AnyReview | null>(null);
  const copy = COPY[mode];

  async function run(withQuestion: boolean, refresh = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ nodes, edges, mode, ...(refresh ? { refresh: true } : {}), ...(withQuestion && question.trim() ? { question: question.trim() } : {}) }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error?.message || 'The AI review failed. Please try again.');
      setReview(body.data as AnyReview);
      onReview?.(body.data as AnyReview, nodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The AI review failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={clsx('border rounded-2xl p-5 mb-6 transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800/80 border-gray-700/80 backdrop-blur-md')} data-testid="ai-review-card" data-mode={mode}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className={clsx('w-4 h-4', isLight ? 'text-fuchsia-600' : 'text-fuchsia-400')} />
          <h3 className={clsx('font-semibold text-sm', isLight ? 'text-slate-900' : 'text-white')}>{copy.title}</h3>
          <span className={clsx('text-[10px] px-2 py-0.5 rounded-full border', isLight ? 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200' : 'bg-fuchsia-900/30 text-fuchsia-300 border-fuchsia-800/50')}>grounded in CloudCraft&apos;s analysis</span>
        </div>
        <button
          onClick={() => run(false, Boolean(review))}   // "Review again" asks the model afresh; the first review may come from the cache
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors shadow-sm"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {review ? 'Review again' : copy.button}
        </button>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); if (question.trim()) run(true); }} className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          placeholder={copy.placeholder}
          className={clsx('flex-1 border rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-fuchsia-500 transition-all', isLight ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400' : 'bg-gray-900 border-gray-700 text-white placeholder-gray-500')}
        />
        <button type="submit" disabled={loading || !question.trim()} aria-label="Ask" className={clsx('px-3 rounded-lg border transition-all', isLight ? 'border-slate-300 text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40' : 'border-gray-700 text-gray-300 hover:text-white hover:bg-gray-700 disabled:opacity-40')}>
          <Send className="w-3.5 h-3.5" />
        </button>
      </form>

      {error && (
        <div className="mt-3 flex items-start gap-2 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs p-3 rounded-lg">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {review && (
        <div className="mt-4 space-y-4">
          {review.answer && (
            <div className={clsx('border rounded-lg p-3', isLight ? 'bg-fuchsia-50 border-fuchsia-200' : 'bg-fuchsia-900/20 border-fuchsia-800/50')}>
              <p className={clsx('text-[10px] font-semibold uppercase tracking-wide mb-1', isLight ? 'text-fuchsia-800' : 'text-fuchsia-300')}>Answer</p>
              <p className={clsx('text-sm leading-relaxed whitespace-pre-line', isLight ? 'text-slate-800' : 'text-gray-200')}>{review.answer}</p>
            </div>
          )}

          <p className={clsx('text-sm leading-relaxed', isLight ? 'text-slate-700' : 'text-gray-300')}>{review.summary}</p>

          {mode === 'general' && <GeneralBody review={review as AiReviewResult} isLight={isLight} />}
          {mode === 'security' && <SecurityBody review={review as AiSecurityReview} isLight={isLight} />}
          {mode === 'well-architected' && <WellArchitectedBody review={review as AiWellArchitectedReview} isLight={isLight} />}

          {'suggestions' in review && review.suggestions.length > 0 && (
            <div className={clsx('border border-dashed rounded-lg p-3', isLight ? 'border-purple-300 bg-purple-50/50' : 'border-gray-600')} data-testid="ai-suggestions">
              <p className={clsx('flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide mb-1', isLight ? 'text-purple-800' : 'text-gray-400')}>
                <Lightbulb className="w-3 h-3" /> AI suggestions — not verified by CloudCraft&apos;s analysis
              </p>
              <ul className={clsx('list-disc list-inside text-xs space-y-0.5', isLight ? 'text-slate-600' : 'text-gray-400')}>{review.suggestions.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}

          <p className={clsx('flex items-center gap-1.5 text-[10px]', isLight ? 'text-slate-500' : 'text-gray-500')}>
            <BookOpen className="w-3 h-3 shrink-0" />
            Scores and findings come from CloudCraft&apos;s analysis engine; {copy.footer}
          </p>
        </div>
      )}
    </div>
  );
}

function GeneralBody({ review, isLight = false }: { review: AiReviewResult; isLight?: boolean }) {
  return (
    <>
      {review.strengths.length > 0 && (
        <ul className="space-y-1">
          {review.strengths.map((s) => (
            <li key={s} className={clsx('flex items-start gap-2 text-xs', isLight ? 'text-slate-700' : 'text-gray-300')}>
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />{s}
            </li>
          ))}
        </ul>
      )}

      {review.priorities.length > 0 && (
        <div className="space-y-2">
          <p className={clsx('text-[10px] font-semibold uppercase tracking-wide', isLight ? 'text-slate-500' : 'text-gray-400')}>Fix first</p>
          {review.priorities.map((p, i) => (
            <div key={p.ruleId} className={clsx('border rounded-lg p-3', isLight ? 'bg-slate-50 border-slate-200' : 'bg-gray-900/60 border-gray-700')}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className={clsx('text-xs', isLight ? 'text-slate-400' : 'text-gray-500')}>{i + 1}.</span>
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border uppercase font-medium', sevClass(p.severity, isLight))}>{p.severity}</span>
                <span className={clsx('text-xs font-medium', isLight ? 'text-slate-900' : 'text-white')}>{p.title}</span>
                <span className={clsx('text-[10px] font-mono', isLight ? 'text-slate-400' : 'text-gray-600')}>{p.ruleId}</span>
              </div>
              {p.resources.length > 0 && <p className={clsx('text-[11px] mb-1', isLight ? 'text-slate-500' : 'text-gray-500')}>{p.resources.join(', ')}</p>}
              <p className={clsx('text-xs mb-1', isLight ? 'text-slate-700' : 'text-gray-300')}>{p.problem}</p>
              <p className="text-xs"><span className={clsx('font-medium', isLight ? 'text-blue-600' : 'text-blue-400')}>Fix: </span><span className={isLight ? 'text-slate-700' : 'text-gray-300'}>{p.fix}</span></p>
            </div>
          ))}
        </div>
      )}

      {review.missing.length > 0 && (
        <div>
          <p className={clsx('text-[10px] font-semibold uppercase tracking-wide mb-1', isLight ? 'text-slate-500' : 'text-gray-400')}>Gaps</p>
          <ul className={clsx('list-disc list-inside text-xs space-y-0.5', isLight ? 'text-slate-700' : 'text-gray-300')}>{review.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}

      {review.facts.deploymentInputs.length > 0 && (
        <div className={clsx('text-xs border rounded-lg p-3', isLight ? 'text-amber-900 bg-amber-50 border-amber-200' : 'text-amber-300 bg-amber-900/20 border-amber-800/40')}>
          Needs your input before deploying: {review.facts.deploymentInputs.map((d) => `${d.resourceLabel} → ${d.setting}`).join('; ')}
        </div>
      )}
    </>
  );
}

const AUTOFIX_LABEL: Record<AiSecurityPriority['autoFix'], string> = { safe: 'safe auto-fix available', review: 'auto-fix needs review', manual: 'manual fix' };

function SecurityBody({ review, isLight = false }: { review: AiSecurityReview; isLight?: boolean }) {
  const { facts } = review;
  const sev = Object.entries(facts.bySeverity);
  return (
    <>
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className={clsx('px-2 py-1 rounded border', isLight ? 'bg-slate-50 border-slate-200 text-slate-700' : 'bg-gray-900/60 border-gray-700 text-gray-300')}>Security score: <b className={isLight ? 'text-slate-900' : 'text-white'}>{facts.score ?? 'n/a'}</b> ({facts.rating})</span>
        {sev.map(([k, v]) => <span key={k} className={clsx('px-2 py-1 rounded border font-medium', sevClass(k, isLight))}>{v} {k}</span>)}
        <span className={clsx('px-2 py-1 rounded border', isLight ? 'bg-slate-50 border-slate-200 text-slate-500' : 'bg-gray-900/60 border-gray-700 text-gray-400')}>{facts.autoFix.safe} safe auto-fix · {facts.autoFix.needsReview} need review · {facts.autoFix.manual} manual</span>
      </div>

      {review.themes.length > 0 && (
        <div className="space-y-1.5">
          <p className={clsx('text-[10px] font-semibold uppercase tracking-wide', isLight ? 'text-slate-500' : 'text-gray-400')}>Themes</p>
          {review.themes.map((t) => (
            <div key={t.title} className="text-xs">
              <span className={clsx('font-medium', isLight ? 'text-slate-900' : 'text-white')}>{t.title}</span>
              <span className={isLight ? 'text-slate-600' : 'text-gray-400'}> — {t.explanation}</span>
              <span className={clsx('font-mono text-[10px]', isLight ? 'text-slate-400' : 'text-gray-600')}> ({t.ruleIds.join(', ')})</span>
            </div>
          ))}
        </div>
      )}

      {review.priorities.length > 0 && (
        <div className="space-y-2">
          <p className={clsx('text-[10px] font-semibold uppercase tracking-wide', isLight ? 'text-slate-500' : 'text-gray-400')}>Fix in this order</p>
          {review.priorities.map((p, i) => (
            <div key={p.ruleId} className={clsx('border rounded-lg p-3', isLight ? 'bg-slate-50 border-slate-200' : 'bg-gray-900/60 border-gray-700')} data-testid="ai-security-priority">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className={clsx('text-xs', isLight ? 'text-slate-400' : 'text-gray-500')}>{i + 1}.</span>
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border uppercase font-medium', sevClass(p.severity, isLight))}>{p.severity}</span>
                <span className={clsx('text-xs font-medium', isLight ? 'text-slate-900' : 'text-white')}>{p.title}</span>
                <span className={clsx('text-[10px] font-mono', isLight ? 'text-slate-400' : 'text-gray-600')}>{p.ruleId}</span>
                <span className={clsx('ml-auto text-[10px]', isLight ? 'text-slate-500' : 'text-gray-400')}>{AUTOFIX_LABEL[p.autoFix]}</span>
              </div>
              {p.resources.length > 0 && <p className={clsx('text-[11px] mb-1', isLight ? 'text-slate-500' : 'text-gray-500')}>{p.resources.join(', ')}</p>}
              <p className={clsx('text-xs mb-1', isLight ? 'text-slate-700' : 'text-gray-300')}>{p.problem}</p>
              <p className="text-xs"><span className={clsx('font-medium', isLight ? 'text-blue-600' : 'text-blue-400')}>Fix: </span><span className={isLight ? 'text-slate-700' : 'text-gray-300'}>{p.fix}</span></p>
              {p.steps.length > 0 && (
                <details className="mt-1.5">
                  <summary className={clsx('text-[11px] cursor-pointer', isLight ? 'text-slate-500' : 'text-gray-500')}>Steps{p.terraform ? ' and Terraform' : ''}</summary>
                  <ol className={clsx('list-decimal list-inside text-[11px] mt-1 space-y-0.5', isLight ? 'text-slate-600' : 'text-gray-400')}>{p.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                  {p.terraform && <pre className={clsx('mt-1 text-[10px] rounded p-2 overflow-x-auto border', isLight ? 'text-slate-800 bg-slate-100 border-slate-200' : 'text-gray-300 bg-gray-950 border-gray-700')}>{p.terraform}</pre>}
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function WellArchitectedBody({ review, isLight = false }: { review: AiWellArchitectedReview; isLight?: boolean }) {
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2" data-testid="ai-wa-pillars">
        {review.pillars.map((p) => (
          <div key={p.key} className={clsx('border rounded-lg p-3', isLight ? 'bg-slate-50 border-slate-200' : 'bg-gray-900/60 border-gray-700')}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className={clsx('text-xs font-medium', isLight ? 'text-slate-900' : 'text-white')}>{p.label} <span className={clsx('uppercase text-[10px]', isLight ? 'text-slate-400' : 'text-gray-600')}>{p.provider}</span></span>
              <span className={clsx('text-[11px]', isLight ? 'text-slate-700' : 'text-gray-300')}>{p.score === null ? 'not scored' : p.score} <span className={clsx(isLight ? 'text-slate-400' : 'text-gray-500')}>· {p.status}</span></span>
            </div>
            <p className={clsx('text-xs mb-1', isLight ? 'text-slate-600' : 'text-gray-300')}>{p.assessment}</p>
            {p.topFixes.map((f) => (
              <p key={f.ruleId} className="text-xs mt-1">
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border uppercase mr-1.5 font-medium', sevClass(f.severity, isLight))}>{f.severity}</span>
                <span className={clsx('font-medium', isLight ? 'text-blue-600' : 'text-blue-400')}>{f.title}: </span><span className={isLight ? 'text-slate-700' : 'text-gray-300'}>{f.fix}</span>
              </p>
            ))}
          </div>
        ))}
      </div>

      {review.plan.length > 0 && (
        <div className="space-y-1.5">
          <p className={clsx('text-[10px] font-semibold uppercase tracking-wide', isLight ? 'text-slate-500' : 'text-gray-400')}>Improvement plan</p>
          <ol className="space-y-1.5">
            {review.plan.map((s, i) => (
              <li key={s.ruleId} className={clsx('text-xs', isLight ? 'text-slate-700' : 'text-gray-300')}>
                <span className={isLight ? 'text-slate-400' : 'text-gray-500'}>{i + 1}. </span>
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border uppercase mr-1.5 font-medium', sevClass(s.severity, isLight))}>{s.severity}</span>
                <span className={clsx('font-medium', isLight ? 'text-slate-900' : 'text-white')}>{s.title}</span> — {s.action}
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

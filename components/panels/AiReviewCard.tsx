'use client';
import { useState } from 'react';
import { Sparkles, Loader2, AlertTriangle, CheckCircle2, Send, BookOpen, Lightbulb } from 'lucide-react';
import clsx from 'clsx';
import type { CanvasNode, CanvasEdge } from '@/types';
import type { AiReviewResult, AiSecurityReview, AiSecurityPriority, AiWellArchitectedReview, AiReviewMode } from '@/lib/services/AiReviewService';

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'text-red-300 bg-red-900/30 border-red-800',
  high: 'text-orange-300 bg-orange-900/30 border-orange-800',
  medium: 'text-yellow-300 bg-yellow-900/30 border-yellow-800',
  low: 'text-blue-300 bg-blue-900/30 border-blue-800',
  informational: 'text-slate-300 bg-slate-800 border-slate-700',
};
const sevClass = (s: string) => SEVERITY_STYLE[s] ?? SEVERITY_STYLE.informational;

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
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 mb-6" data-testid="ai-review-card" data-mode={mode}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-fuchsia-400" />
          <h3 className="text-white font-semibold text-sm">{copy.title}</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-900/30 text-fuchsia-300">grounded in CloudCraft&apos;s analysis</span>
        </div>
        <button
          onClick={() => run(false, Boolean(review))}   // "Review again" asks the model afresh; the first review may come from the cache
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
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
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-fuchsia-500"
        />
        <button type="submit" disabled={loading || !question.trim()} aria-label="Ask" className="px-3 rounded-lg border border-gray-700 text-gray-300 hover:text-white disabled:opacity-40">
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
            <div className="bg-fuchsia-900/20 border border-fuchsia-800/50 rounded-lg p-3">
              <p className="text-fuchsia-300 text-[10px] font-semibold uppercase tracking-wide mb-1">Answer</p>
              <p className="text-gray-200 text-sm leading-relaxed whitespace-pre-line">{review.answer}</p>
            </div>
          )}

          <p className="text-gray-300 text-sm leading-relaxed">{review.summary}</p>

          {mode === 'general' && <GeneralBody review={review as AiReviewResult} />}
          {mode === 'security' && <SecurityBody review={review as AiSecurityReview} />}
          {mode === 'well-architected' && <WellArchitectedBody review={review as AiWellArchitectedReview} />}

          {'suggestions' in review && review.suggestions.length > 0 && (
            <div className="border border-dashed border-gray-600 rounded-lg p-3" data-testid="ai-suggestions">
              <p className="flex items-center gap-1.5 text-gray-400 text-[10px] font-semibold uppercase tracking-wide mb-1">
                <Lightbulb className="w-3 h-3" /> AI suggestions — not verified by CloudCraft&apos;s analysis
              </p>
              <ul className="list-disc list-inside text-xs text-gray-400 space-y-0.5">{review.suggestions.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}

          <p className="flex items-center gap-1.5 text-[10px] text-gray-500">
            <BookOpen className="w-3 h-3 shrink-0" />
            Scores and findings come from CloudCraft&apos;s analysis engine; {copy.footer}
          </p>
        </div>
      )}
    </div>
  );
}

function GeneralBody({ review }: { review: AiReviewResult }) {
  return (
    <>
      {review.strengths.length > 0 && (
        <ul className="space-y-1">
          {review.strengths.map((s) => (
            <li key={s} className="flex items-start gap-2 text-xs text-gray-300">
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-400 shrink-0" />{s}
            </li>
          ))}
        </ul>
      )}

      {review.priorities.length > 0 && (
        <div className="space-y-2">
          <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wide">Fix first</p>
          {review.priorities.map((p, i) => (
            <div key={p.ruleId} className="bg-gray-900/60 border border-gray-700 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-gray-500 text-xs">{i + 1}.</span>
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border uppercase', sevClass(p.severity))}>{p.severity}</span>
                <span className="text-white text-xs font-medium">{p.title}</span>
                <span className="text-gray-600 text-[10px] font-mono">{p.ruleId}</span>
              </div>
              {p.resources.length > 0 && <p className="text-gray-500 text-[11px] mb-1">{p.resources.join(', ')}</p>}
              <p className="text-gray-300 text-xs mb-1">{p.problem}</p>
              <p className="text-xs"><span className="text-blue-400 font-medium">Fix: </span><span className="text-gray-300">{p.fix}</span></p>
            </div>
          ))}
        </div>
      )}

      {review.missing.length > 0 && (
        <div>
          <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wide mb-1">Gaps</p>
          <ul className="list-disc list-inside text-xs text-gray-300 space-y-0.5">{review.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}

      {review.facts.deploymentInputs.length > 0 && (
        <div className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg p-3">
          Needs your input before deploying: {review.facts.deploymentInputs.map((d) => `${d.resourceLabel} → ${d.setting}`).join('; ')}
        </div>
      )}
    </>
  );
}

const AUTOFIX_LABEL: Record<AiSecurityPriority['autoFix'], string> = { safe: 'safe auto-fix available', review: 'auto-fix needs review', manual: 'manual fix' };

function SecurityBody({ review }: { review: AiSecurityReview }) {
  const { facts } = review;
  const sev = Object.entries(facts.bySeverity);
  return (
    <>
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="px-2 py-1 rounded bg-gray-900/60 border border-gray-700 text-gray-300">Security score: <b className="text-white">{facts.score ?? 'n/a'}</b> ({facts.rating})</span>
        {sev.map(([k, v]) => <span key={k} className={clsx('px-2 py-1 rounded border', sevClass(k))}>{v} {k}</span>)}
        <span className="px-2 py-1 rounded bg-gray-900/60 border border-gray-700 text-gray-400">{facts.autoFix.safe} safe auto-fix · {facts.autoFix.needsReview} need review · {facts.autoFix.manual} manual</span>
      </div>

      {review.themes.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wide">Themes</p>
          {review.themes.map((t) => (
            <div key={t.title} className="text-xs">
              <span className="text-white font-medium">{t.title}</span>
              <span className="text-gray-400"> — {t.explanation}</span>
              <span className="text-gray-600 font-mono text-[10px]"> ({t.ruleIds.join(', ')})</span>
            </div>
          ))}
        </div>
      )}

      {review.priorities.length > 0 && (
        <div className="space-y-2">
          <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wide">Fix in this order</p>
          {review.priorities.map((p, i) => (
            <div key={p.ruleId} className="bg-gray-900/60 border border-gray-700 rounded-lg p-3" data-testid="ai-security-priority">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-gray-500 text-xs">{i + 1}.</span>
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border uppercase', sevClass(p.severity))}>{p.severity}</span>
                <span className="text-white text-xs font-medium">{p.title}</span>
                <span className="text-gray-600 text-[10px] font-mono">{p.ruleId}</span>
                <span className="ml-auto text-[10px] text-gray-400">{AUTOFIX_LABEL[p.autoFix]}</span>
              </div>
              {p.resources.length > 0 && <p className="text-gray-500 text-[11px] mb-1">{p.resources.join(', ')}</p>}
              <p className="text-gray-300 text-xs mb-1">{p.problem}</p>
              <p className="text-xs"><span className="text-blue-400 font-medium">Fix: </span><span className="text-gray-300">{p.fix}</span></p>
              {p.steps.length > 0 && (
                <details className="mt-1.5">
                  <summary className="text-[11px] text-gray-500 cursor-pointer">Steps{p.terraform ? ' and Terraform' : ''}</summary>
                  <ol className="list-decimal list-inside text-[11px] text-gray-400 mt-1 space-y-0.5">{p.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                  {p.terraform && <pre className="mt-1 text-[10px] text-gray-300 bg-gray-950 border border-gray-700 rounded p-2 overflow-x-auto">{p.terraform}</pre>}
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function WellArchitectedBody({ review }: { review: AiWellArchitectedReview }) {
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2" data-testid="ai-wa-pillars">
        {review.pillars.map((p) => (
          <div key={p.key} className="bg-gray-900/60 border border-gray-700 rounded-lg p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-white text-xs font-medium">{p.label} <span className="text-gray-600 uppercase text-[10px]">{p.provider}</span></span>
              <span className="text-[11px] text-gray-300">{p.score === null ? 'not scored' : p.score} <span className="text-gray-500">· {p.status}</span></span>
            </div>
            <p className="text-gray-300 text-xs mb-1">{p.assessment}</p>
            {p.topFixes.map((f) => (
              <p key={f.ruleId} className="text-xs mt-1">
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border uppercase mr-1.5', sevClass(f.severity))}>{f.severity}</span>
                <span className="text-blue-400 font-medium">{f.title}: </span><span className="text-gray-300">{f.fix}</span>
              </p>
            ))}
          </div>
        ))}
      </div>

      {review.plan.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wide">Improvement plan</p>
          <ol className="space-y-1.5">
            {review.plan.map((s, i) => (
              <li key={s.ruleId} className="text-xs text-gray-300">
                <span className="text-gray-500">{i + 1}. </span>
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border uppercase mr-1.5', sevClass(s.severity))}>{s.severity}</span>
                <span className="text-white font-medium">{s.title}</span> — {s.action}
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

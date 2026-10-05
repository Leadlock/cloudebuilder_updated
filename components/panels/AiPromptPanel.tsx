import React, { useState } from 'react';
import { useApp } from '@/context/AppContext';
import { Bot, Loader2, Sparkles, X, ArrowRight, ArrowLeft, Check, AlertTriangle, Shield, Layers, Activity, Cpu, Database, HelpCircle, Zap } from 'lucide-react';
import { CloudProvider, CanvasNode, CanvasEdge, QuestionnaireResult, QuestionnaireAnswers, ArchitectureQuestion } from '@/types';
import { rekeyGraph } from '@/lib/domain/instantiateTemplate';
import clsx from 'clsx';

interface AiPromptPanelProps {
  projectId: string;
  environmentId: string;
  provider: CloudProvider;
  onClose: () => void;
  /** `notice` carries anything the user should know about the result (unsupported services, values to fill in). */
  onApplyGraph: (nodes: CanvasNode[], edges: CanvasEdge[], notice?: string) => void;
}

function getCategoryIcon(category: string) {
  switch (category) {
    case 'security':
      return <Shield className="w-3.5 h-3.5 text-emerald-400" />;
    case 'availability':
      return <Layers className="w-3.5 h-3.5 text-blue-400" />;
    case 'scale':
      return <Activity className="w-3.5 h-3.5 text-amber-400" />;
    case 'compute':
      return <Cpu className="w-3.5 h-3.5 text-purple-400" />;
    case 'database':
      return <Database className="w-3.5 h-3.5 text-indigo-400" />;
    default:
      return <HelpCircle className="w-3.5 h-3.5 text-cyan-400" />;
  }
}

export default function AiPromptPanel({
  projectId,
  environmentId,
  provider,
  onClose,
  onApplyGraph,
}: AiPromptPanelProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const [prompt, setPrompt] = useState('');
  const [step, setStep] = useState<'prompt' | 'questionnaire' | 'generating'>('prompt');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Questionnaire state
  const [questionnaire, setQuestionnaire] = useState<QuestionnaireResult | null>(null);
  const [answers, setAnswers] = useState<QuestionnaireAnswers>({});

  const handleStartDiscovery = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/ai/questionnaire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          provider,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to analyze requirements');

      const qResult: QuestionnaireResult = data.data;
      setQuestionnaire(qResult);

      const initialAnswers: QuestionnaireAnswers = {};
      qResult.questions.forEach((q: ArchitectureQuestion) => {
        const rec = q.options.find((o) => o.isRecommended);
        initialAnswers[q.id] = rec ? rec.id : q.defaultOptionId || q.options[0]?.id || '';
      });
      setAnswers(initialAnswers);
      setStep('questionnaire');
    } catch (err: any) {
      setError(err.message || 'Failed to analyze requirements');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async (useAnswers = true) => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);
    setStep('generating');

    try {
      const formattedAnswers: Record<string, string> = {};
      if (useAnswers && questionnaire) {
        questionnaire.questions.forEach((q) => {
          const selectedOptionId = answers[q.id];
          const option = q.options.find((o) => o.id === selectedOptionId);
          formattedAnswers[q.question] = option ? `${option.label} (${option.technicalImpact || ''})` : selectedOptionId;
        });
      }

      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          projectId,
          environmentId,
          provider,
          answers: useAnswers ? formattedAnswers : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error([data.error || 'Failed to generate architecture', ...(data.issues ?? []).slice(0, 3)].join(' • '));

      const { nodes: newNodes, edges: newEdges } = rekeyGraph(data.graph.nodes, data.graph.edges);

      onApplyGraph(newNodes, newEdges, data.warning);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to generate architecture');
      setStep(questionnaire ? 'questionnaire' : 'prompt');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={clsx(
        'absolute top-4 left-4 w-[460px] max-h-[85vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col z-50 animate-in slide-in-from-left-4 fade-in duration-200 border transition-colors',
        isLight ? 'bg-white border-slate-200 shadow-slate-300/80' : 'bg-slate-900 border-slate-700/80 shadow-2xl'
      )}
    >
      {/* Header */}
      <div
        className={clsx(
          'flex items-center justify-between px-5 py-3.5 border-b transition-colors',
          isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900/80 border-slate-800'
        )}
      >
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-fuchsia-500 dark:text-fuchsia-400" />
          <h3 className={clsx('font-bold text-sm tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>
            AI Cloud Architect
          </h3>
          <span
            className={clsx(
              'px-1.5 py-0.5 text-[10px] font-semibold rounded border uppercase',
              isLight
                ? 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200'
                : 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30'
            )}
          >
            {provider}
          </span>
        </div>
        <button
          onClick={onClose}
          className={clsx(
            'p-1 rounded-lg transition-colors',
            isLight
              ? 'text-slate-400 hover:text-slate-800 hover:bg-slate-200'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          )}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="p-5 overflow-y-auto flex-1 flex flex-col gap-4">
        {error && (
          <div
            className={clsx(
              'text-xs p-3 rounded-xl border flex items-start gap-2',
              isLight ? 'text-rose-800 bg-rose-50 border-rose-200' : 'text-rose-300 bg-rose-500/10 border-rose-500/30'
            )}
          >
            <AlertTriangle className={clsx('w-4 h-4 flex-shrink-0 mt-0.5', isLight ? 'text-rose-600' : 'text-rose-400')} />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: Prompt Input */}
        {step === 'prompt' && (
          <div className="flex flex-col gap-3">
            <p className={clsx('text-xs', isLight ? 'text-slate-600' : 'text-slate-400')}>
              Describe the workload you want to design. The AI will analyze requirements and ask scoping questions to produce a production-grade architecture.
            </p>

            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Build a highly available SaaS application with React frontend, Node.js API, PostgreSQL database, and Redis cache."
              className={clsx(
                'w-full border rounded-xl p-3 text-sm transition-all min-h-[110px] resize-none focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50',
                isLight
                  ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white focus:border-fuchsia-500'
                  : 'bg-slate-950 border-slate-700 text-slate-200 placeholder-slate-600 focus:border-fuchsia-500/50'
              )}
              disabled={loading}
              autoFocus
            />

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => handleGenerate(false)}
                disabled={!prompt.trim() || loading}
                className={clsx(
                  'flex-1 py-2 rounded-xl text-xs font-medium border transition-colors flex items-center justify-center gap-1.5',
                  isLight
                    ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                )}
              >
                <Zap className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                <span>Fast Generate</span>
              </button>

              <button
                type="button"
                onClick={handleStartDiscovery}
                disabled={!prompt.trim() || loading}
                className="flex-1 py-2 rounded-xl bg-gradient-to-r from-fuchsia-600 to-indigo-600 hover:from-fuchsia-500 hover:to-indigo-500 text-white text-xs font-semibold shadow-md shadow-fuchsia-900/20 transition-all flex items-center justify-center gap-1.5"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Analyzing...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Guided Scoping</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Questionnaire */}
        {step === 'questionnaire' && questionnaire && (
          <div className="flex flex-col gap-3.5">
            <div
              className={clsx(
                'flex items-center justify-between pb-2 border-b',
                isLight ? 'border-slate-200' : 'border-slate-800'
              )}
            >
              <button
                onClick={() => setStep('prompt')}
                className={clsx(
                  'text-xs flex items-center gap-1 font-medium transition-colors',
                  isLight ? 'text-slate-600 hover:text-slate-900' : 'text-slate-400 hover:text-white'
                )}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Edit Prompt</span>
              </button>
              <span className={clsx('text-[11px] font-medium', isLight ? 'text-fuchsia-700' : 'text-fuchsia-400')}>
                {questionnaire.questions.length} Questions
              </span>
            </div>

            {/* Questions list */}
            <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1 custom-scrollbar">
              {questionnaire.questions.map((q) => {
                const selected = answers[q.id];
                return (
                  <div
                    key={q.id}
                    className={clsx(
                      'border rounded-xl p-3 transition-colors',
                      isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/70 border-slate-800'
                    )}
                  >
                    <div
                      className={clsx(
                        'flex items-center gap-1.5 text-[10px] font-bold uppercase mb-1',
                        isLight ? 'text-slate-500' : 'text-slate-400'
                      )}
                    >
                      {getCategoryIcon(q.category)}
                      <span>{q.categoryLabel}</span>
                    </div>
                    <p className={clsx('text-xs font-medium mb-2', isLight ? 'text-slate-900' : 'text-white')}>
                      {q.question}
                    </p>

                    <div className="space-y-1.5">
                      {q.options.map((opt) => {
                        const isSelected = selected === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: opt.id }))}
                            className={clsx(
                              'w-full text-left p-2 rounded-lg border text-xs transition-all flex items-center justify-between gap-2',
                              isSelected
                                ? isLight
                                  ? 'bg-fuchsia-50 border-fuchsia-400 text-fuchsia-950 ring-1 ring-fuchsia-400/40'
                                  : 'bg-fuchsia-950/40 border-fuchsia-500/80 text-white'
                                : isLight
                                ? 'bg-white border-slate-200 hover:border-slate-300 text-slate-700 hover:text-slate-900'
                                : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300'
                            )}
                          >
                            <span className="truncate">{opt.label}</span>
                            {isSelected && (
                              <Check
                                className={clsx('w-3.5 h-3.5 flex-shrink-0', isLight ? 'text-fuchsia-600' : 'text-fuchsia-400')}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={() => handleGenerate(true)}
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold shadow-lg shadow-emerald-900/20 transition-all flex items-center justify-center gap-2"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Generate Architecture</span>
            </button>
          </div>
        )}

        {/* Step 3: Generating */}
        {step === 'generating' && (
          <div className="py-8 text-center flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-fuchsia-500 dark:text-fuchsia-400 animate-spin" />
            <div>
              <p className={clsx('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>
                Designing Architecture
              </p>
              <p className={clsx('text-xs mt-0.5', isLight ? 'text-slate-500' : 'text-slate-400')}>
                Translating answers into connected resources...
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


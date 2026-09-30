import React, { useState } from 'react';
import { Bot, Loader2, Sparkles, X, ArrowRight, ArrowLeft, Check, AlertTriangle, Shield, Layers, Activity, Cpu, Database, HelpCircle, Zap } from 'lucide-react';
import { CloudProvider, CanvasNode, CanvasEdge, QuestionnaireResult, QuestionnaireAnswers, ArchitectureQuestion } from '@/types';
import { mapAiGraphToCanvas } from '@/lib/ai/mapAiGraphToCanvas';
import clsx from 'clsx';

interface AiPromptPanelProps {
  projectId: string;
  environmentId: string;
  provider: CloudProvider;
  onClose: () => void;
  onApplyGraph: (nodes: CanvasNode[], edges: CanvasEdge[]) => void;
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
      if (!res.ok) throw new Error(data.error || 'Failed to generate architecture');

      const { nodes: newNodes, edges: newEdges } = mapAiGraphToCanvas(data.data, provider);

      onApplyGraph(newNodes, newEdges);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to generate architecture');
      setStep(questionnaire ? 'questionnaire' : 'prompt');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="absolute top-4 left-4 w-[460px] max-h-[85vh] bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col z-50 animate-in slide-in-from-left-4 fade-in duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-900/80">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-fuchsia-400" />
          <h3 className="text-white font-bold text-sm tracking-tight">AI Cloud Architect</h3>
          <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-fuchsia-500/20 text-fuchsia-300 rounded border border-fuchsia-500/30 uppercase">
            {provider}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="p-5 overflow-y-auto flex-1 flex flex-col gap-4">
        {error && (
          <div className="text-xs text-rose-300 bg-rose-500/10 p-3 rounded-xl border border-rose-500/30 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: Prompt Input */}
        {step === 'prompt' && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-slate-400">
              Describe the workload you want to design. The AI will analyze requirements and ask scoping questions to produce a production-grade architecture.
            </p>

            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Build a highly available SaaS application with React frontend, Node.js API, PostgreSQL database, and Redis cache."
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-fuchsia-500/50 focus:ring-1 focus:ring-fuchsia-500/50 transition-all min-h-[110px] resize-none"
              disabled={loading}
              autoFocus
            />

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => handleGenerate(false)}
                disabled={!prompt.trim() || loading}
                className="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors flex items-center justify-center gap-1.5"
              >
                <Zap className="w-3.5 h-3.5 text-amber-400" />
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
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <button
                onClick={() => setStep('prompt')}
                className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Edit Prompt</span>
              </button>
              <span className="text-[11px] text-fuchsia-400 font-medium">
                {questionnaire.questions.length} Questions
              </span>
            </div>

            {/* Questions list */}
            <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
              {questionnaire.questions.map((q, idx) => {
                const selected = answers[q.id];
                return (
                  <div key={q.id} className="bg-slate-950/70 border border-slate-800 rounded-xl p-3">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-slate-400 mb-1">
                      {getCategoryIcon(q.category)}
                      <span>{q.categoryLabel}</span>
                    </div>
                    <p className="text-xs font-medium text-white mb-2">{q.question}</p>

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
                                ? 'bg-fuchsia-950/40 border-fuchsia-500/80 text-white'
                                : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300'
                            )}
                          >
                            <span className="truncate">{opt.label}</span>
                            {isSelected && <Check className="w-3.5 h-3.5 text-fuchsia-400 flex-shrink-0" />}
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
            <Loader2 className="w-8 h-8 text-fuchsia-400 animate-spin" />
            <div>
              <p className="text-sm font-semibold text-white">Designing Architecture</p>
              <p className="text-xs text-slate-400 mt-0.5">Translating answers into connected resources...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


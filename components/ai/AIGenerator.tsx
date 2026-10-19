'use client';
import { useState } from 'react';
import { useApp } from '@/context/AppContext';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { calculateCosts } from '@/lib/analysis';
import { rekeyGraph } from '@/lib/domain/instantiateTemplate';
import {
  CloudProvider,
  CanvasNode,
  CanvasEdge,
  AIGeneratorResult,
  QuestionnaireResult,
  QuestionnaireAnswers,
  ArchitectureQuestion,
} from '@/types';
import {
  Sparkles,
  Server,
  ShieldCheck,
  ChevronRight,
  Loader2,
  BookOpen,
  AlertTriangle,
  HelpCircle,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  Shield,
  Database,
  Cpu,
  Layers,
  Activity,
  Zap,
  Check,
  DollarSign,
} from 'lucide-react';
import clsx from 'clsx';

const EXAMPLE_PROMPTS = [
  'Build a highly available SaaS application with React frontend, Node.js API, PostgreSQL and Redis cache',
  'Multi-tier e-commerce platform with CDN, auto-scaling and managed database',
  'Microservices architecture with container orchestration and message queuing',
  'Data lake with ETL pipeline, analytics compute and secure S3 storage',
  'Disaster recovery setup spanning AWS primary and Azure standby region',
];

function summarizeGraph(nodes: CanvasNode[], edges: CanvasEdge[], prompt: string): AIGeneratorResult {
  const security = runAssessment({ nodes, edges }).securityScore;
  const costs = calculateCosts(nodes);
  const estimatedCost = Math.round(costs.reduce((acc, c) => acc + c.monthlyCost, 0));
  const suggestedResources = Array.from(new Set(nodes.map((n) => n.label || n.resourceType)));
  return {
    nodes,
    edges,
    summary:
      nodes.length > 0
        ? `Generated ${nodes.length} resource${nodes.length === 1 ? '' : 's'} tailored to your exact specifications.`
        : 'The AI did not return any resources for this prompt — try adjusting your requirements.',
    suggestedResources,
    estimatedCost,
    securityScore: security.score,
  };
}

function getCategoryIcon(category: string) {
  switch (category) {
    case 'security':
      return <Shield className="w-4 h-4 text-emerald-400" />;
    case 'availability':
      return <Layers className="w-4 h-4 text-blue-400" />;
    case 'scale':
      return <Activity className="w-4 h-4 text-amber-400" />;
    case 'compute':
      return <Cpu className="w-4 h-4 text-purple-400" />;
    case 'database':
      return <Database className="w-4 h-4 text-indigo-400" />;
    default:
      return <HelpCircle className="w-4 h-4 text-cyan-400" />;
  }
}

export default function AIGenerator() {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<CloudProvider>('aws');
  const [step, setStep] = useState<'prompt' | 'questionnaire' | 'generating' | 'result'>('prompt');
  
  // Questionnaire state
  const [questionnaire, setQuestionnaire] = useState<QuestionnaireResult | null>(null);
  const [answers, setAnswers] = useState<QuestionnaireAnswers>({});
  const [customRequirements, setCustomRequirements] = useState('');
  const [discoveringQuestions, setDiscoveringQuestions] = useState(false);

  // Generation state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [result, setResult] = useState<AIGeneratorResult | null>(null);
  const [projectName, setProjectName] = useState('');

  // Step 1 -> Step 2: Fetch discovery questions & identify gaps
  async function handleStartDiscovery() {
    if (!prompt.trim()) return;
    setDiscoveringQuestions(true);
    setError(null);
    setWarning(null);

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

      // Pre-select recommended default options
      const initialAnswers: QuestionnaireAnswers = {};
      qResult.questions.forEach((q: ArchitectureQuestion) => {
        const rec = q.options.find((o) => o.isRecommended);
        initialAnswers[q.id] = rec ? rec.id : q.defaultOptionId || q.options[0]?.id || '';
      });
      setAnswers(initialAnswers);
      setProjectName(qResult.suggestedProjectName || prompt.slice(0, 35).trim());
      setStep('questionnaire');
    } catch (err: any) {
      setError(err.message || 'Failed to analyze requirements');
    } finally {
      setDiscoveringQuestions(false);
    }
  }

  // Generate directly from answers or fast-generate
  async function handleGenerate(useAnswers = true) {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);
    setWarning(null);
    setResult(null);
    setStep('generating');

    try {
      // Map answer IDs to readable labels for the LLM
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
          projectId: state.activeProjectId ?? 'draft-project',
          environmentId: state.activeEnvironment,
          provider,
          answers: useAnswers ? formattedAnswers : undefined,
          requirementsSummary: customRequirements.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error([data.error || 'Failed to generate architecture', ...(data.issues ?? []).slice(0, 3)].join(' • '));

      const { nodes, edges } = rekeyGraph(data.graph.nodes, data.graph.edges);
      const summary = summarizeGraph(nodes, edges, prompt);
      setResult(summary);
      if (!projectName) {
        setProjectName(prompt.slice(0, 35).trim());
      }
      if (data.warning) setWarning(data.warning);
      setStep('result');

      // Asynchronously fetch live real-time pricing from AWS / Azure price providers
      fetch(`/api/projects/draft-project/cost-estimates?currency=${state.displayCurrency || 'USD'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          env: 'production',
          currency: state.displayCurrency || 'USD',
          resources: nodes.map((n) => ({
            id: n.id,
            resourceType: n.resourceType,
            provider: n.provider,
            label: n.label,
            region: n.region ?? (n.provider === 'azure' ? 'eastus' : 'us-east-1'),
            config: n.config ?? {},
          })),
        }),
      })
        .then((r) => r.json())
        .then((est) => {
          if (est?.ok && est?.data?.totalMonthlyUsd !== undefined) {
            const liveCost = Math.round(est.data.totalMonthlyUsd);
            setResult((prev) => (prev ? { ...prev, estimatedCost: liveCost } : prev));
          }
        })
        .catch(() => {});
    } catch (err: any) {
      setError(err.message || 'Failed to generate architecture');
      setStep(questionnaire ? 'questionnaire' : 'prompt');
    } finally {
      setLoading(false);
    }
  }

  function handleSelectOption(questionId: string, optionId: string) {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: optionId,
    }));
  }

  function handleResetToRecommended() {
    if (!questionnaire) return;
    const recommendedAnswers: QuestionnaireAnswers = {};
    questionnaire.questions.forEach((q) => {
      const rec = q.options.find((o) => o.isRecommended);
      recommendedAnswers[q.id] = rec ? rec.id : q.defaultOptionId || q.options[0]?.id || '';
    });
    setAnswers(recommendedAnswers);
  }

  function handleApply() {
    if (!result) return;
    const name = projectName || prompt.slice(0, 40);
    dispatch({
      type: 'CREATE_PROJECT',
      provider,
      name,
      nodes: result.nodes,
      edges: result.edges,
      estimatedMonthlyCost: result.estimatedCost,
    });
  }

  return (
    <div
      className={clsx(
        'flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar transition-colors',
        isLight ? 'bg-slate-50 text-slate-800' : 'bg-slate-950 text-slate-100'
      )}
    >
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div
          className={clsx(
            'flex items-center justify-between mb-8 pb-6 border-b',
            isLight ? 'border-slate-200' : 'border-slate-800/80'
          )}
        >
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 bg-gradient-to-tr from-purple-600 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-purple-900/20">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className={clsx('font-bold text-xl tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>
                  AI Architecture Architect
                </h1>
                <span
                  className={clsx(
                    'px-2 py-0.5 text-[10px] font-semibold border rounded-full',
                    isLight
                      ? 'bg-purple-100 text-purple-700 border-purple-200'
                      : 'bg-purple-500/20 text-purple-300 border-purple-500/30'
                  )}
                >
                  Interactive Discovery
                </span>
              </div>
              <p className={clsx('text-xs mt-0.5', isLight ? 'text-slate-500' : 'text-slate-400')}>
                Guided requirements discovery and customized production-grade cloud topologies
              </p>
            </div>
          </div>

          {/* Provider switch */}
          <div
            className={clsx(
              'flex rounded-lg border p-0.5',
              isLight ? 'bg-slate-100 border-slate-300' : 'bg-slate-900 border-slate-700'
            )}
          >
            {(['aws', 'azure'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProvider(p)}
                disabled={step === 'generating'}
                className={clsx(
                  'px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-md transition-all',
                  provider === p
                    ? 'bg-purple-600 text-white shadow-sm'
                    : isLight
                    ? 'text-slate-600 hover:text-slate-900'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Global Error Alert */}
        {error && (
          <div
            className={clsx(
              'flex items-start gap-2.5 text-xs p-3.5 rounded-xl mb-6 border',
              isLight
                ? 'bg-rose-50 border-rose-200 text-rose-800'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            )}
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-rose-500" />
            <div className="flex-1">
              <p className={clsx('font-medium', isLight ? 'text-rose-900' : 'text-rose-200')}>Error</p>
              <p className="mt-0.5 opacity-90">{error}</p>
            </div>
          </div>
        )}

        {/* STEP 1: PROMPT INPUT */}
        {step === 'prompt' && (
          <div className="space-y-6">
            <div
              className={clsx(
                'border rounded-2xl p-5 shadow-xl transition-colors',
                isLight ? 'bg-white border-slate-200 shadow-slate-100' : 'bg-slate-900 border-slate-800'
              )}
            >
              <div className="flex items-center justify-between mb-3">
                <label
                  className={clsx(
                    'text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5',
                    isLight ? 'text-slate-700' : 'text-slate-300'
                  )}
                >
                  <BookOpen className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                  Describe Your Application or Workload
                </label>
                <span className={clsx('text-[11px]', isLight ? 'text-slate-400' : 'text-slate-500')}>
                  CloudBuilder will identify gaps & ask clarifying questions
                </span>
              </div>
              
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.metaKey) handleStartDiscovery();
                }}
                placeholder="e.g. Build a highly available SaaS application with React frontend, Node.js API, PostgreSQL database, and Redis cache."
                rows={4}
                disabled={discoveringQuestions}
                className={clsx(
                  'w-full border rounded-xl p-3.5 text-sm resize-none transition-all focus:outline-none focus:ring-2 focus:ring-purple-500/50',
                  isLight
                    ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-purple-500 focus:bg-white'
                    : 'bg-slate-950 border-slate-700/80 text-white placeholder-slate-500 focus:border-purple-500'
                )}
                autoFocus
              />

              <div
                className={clsx(
                  'flex flex-col sm:flex-row items-center justify-between gap-3 mt-4 pt-3 border-t',
                  isLight ? 'border-slate-200' : 'border-slate-800'
                )}
              >
                <span className={clsx('text-xs', isLight ? 'text-slate-400' : 'text-slate-500')}>
                  ⌘+Enter for Guided Discovery
                </span>
                
                <div className="flex items-center gap-2.5 w-full sm:w-auto">
                  <button
                    onClick={() => handleGenerate(false)}
                    disabled={!prompt.trim() || discoveringQuestions}
                    className={clsx(
                      'flex-1 sm:flex-none px-3.5 py-2 disabled:opacity-40 rounded-xl text-xs font-medium border transition-colors flex items-center justify-center gap-1.5',
                      isLight
                        ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border-slate-700'
                    )}
                    title="Generate directly from prompt without questionnaire"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                    Fast Generate
                  </button>

                  <button
                    onClick={handleStartDiscovery}
                    disabled={!prompt.trim() || discoveringQuestions}
                    className="flex-1 sm:flex-none px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-semibold shadow-lg shadow-purple-900/30 transition-all flex items-center justify-center gap-2"
                  >
                    {discoveringQuestions ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Analyzing Architecture Gaps...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Customize & Answer Questions</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Example prompts */}
            <div
              className={clsx(
                'border rounded-2xl p-4 transition-colors',
                isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800/80'
              )}
            >
              <p
                className={clsx(
                  'text-xs font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5',
                  isLight ? 'text-slate-500' : 'text-slate-400'
                )}
              >
                <BookOpen className={clsx('w-3.5 h-3.5', isLight ? 'text-slate-400' : 'text-slate-500')} />
                Example Architecture Prompts
              </p>
              <div className="space-y-2">
                {EXAMPLE_PROMPTS.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => setPrompt(p)}
                    className={clsx(
                      'w-full text-left px-3.5 py-2.5 rounded-xl text-xs transition-all flex items-center justify-between group border',
                      isLight
                        ? 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-700 hover:text-slate-900'
                        : 'bg-slate-950/70 hover:bg-slate-800/80 border-slate-800 text-slate-300 hover:text-white'
                    )}
                  >
                    <span className="truncate pr-2">{p}</span>
                    <ChevronRight
                      className={clsx(
                        'w-3.5 h-3.5 transition-colors flex-shrink-0',
                        isLight
                          ? 'text-slate-400 group-hover:text-purple-600'
                          : 'text-slate-600 group-hover:text-purple-400'
                      )}
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: INTERACTIVE QUESTIONNAIRE & GAP ANALYSIS */}
        {step === 'questionnaire' && questionnaire && (
          <div className="space-y-6">
            {/* Top Prompt Recap & Back Button */}
            <div
              className={clsx(
                'flex items-center justify-between border rounded-xl p-3.5',
                isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/80 border-slate-800'
              )}
            >
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setStep('prompt')}
                  className={clsx(
                    'p-1.5 rounded-lg transition-colors',
                    isLight
                      ? 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  )}
                  title="Back to prompt edit"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div>
                  <span
                    className={clsx(
                      'text-[10px] uppercase font-semibold tracking-wider',
                      isLight ? 'text-purple-700' : 'text-purple-400'
                    )}
                  >
                    Original Request
                  </span>
                  <p className={clsx('text-xs line-clamp-1 font-medium', isLight ? 'text-slate-800' : 'text-slate-200')}>
                    {prompt}
                  </p>
                </div>
              </div>
              <button
                onClick={handleResetToRecommended}
                className={clsx(
                  'text-[11px] hover:underline flex items-center gap-1 font-medium',
                  isLight ? 'text-purple-600 hover:text-purple-800' : 'text-purple-400 hover:text-purple-300'
                )}
              >
                <Sparkles className="w-3 h-3" />
                Select All Recommended
              </button>
            </div>

            {/* Identified Gaps Banner */}
            {questionnaire.identifiedGaps && questionnaire.identifiedGaps.length > 0 && (
              <div
                className={clsx(
                  'border rounded-2xl p-4',
                  isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-500/10 border-amber-500/30'
                )}
              >
                <div
                  className={clsx(
                    'flex items-center gap-2 text-xs font-semibold mb-2',
                    isLight ? 'text-amber-800' : 'text-amber-300'
                  )}
                >
                  <AlertTriangle className={clsx('w-4 h-4', isLight ? 'text-amber-600' : 'text-amber-400')} />
                  <span>Identified Architecture Gaps to Clarify</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                  {questionnaire.identifiedGaps.map((gap) => (
                    <div
                      key={gap.id}
                      className={clsx(
                        'border rounded-lg p-2.5 text-[11px]',
                        isLight
                          ? 'bg-white border-amber-200/80 text-slate-700'
                          : 'bg-slate-950/60 border-amber-500/20 text-slate-300'
                      )}
                    >
                      <span className={clsx('font-semibold block', isLight ? 'text-amber-900' : 'text-amber-200')}>
                        {gap.title}
                      </span>
                      <span className={clsx('text-[10px] mt-0.5 block', isLight ? 'text-slate-500' : 'text-slate-400')}>
                        {gap.description}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Questionnaire Questions */}
            <div className="space-y-4">
              {questionnaire.questions.map((q, qIndex) => {
                const selectedOptionId = answers[q.id];
                return (
                  <div
                    key={q.id}
                    className={clsx(
                      'border rounded-2xl p-5 transition-all shadow-md',
                      isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
                    )}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2">
                        <div
                          className={clsx(
                            'p-1.5 rounded-lg border',
                            isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-800 border-slate-700'
                          )}
                        >
                          {getCategoryIcon(q.category)}
                        </div>
                        <div>
                          <span
                            className={clsx(
                              'text-[10px] font-bold uppercase tracking-wider',
                              isLight ? 'text-slate-500' : 'text-slate-400'
                            )}
                          >
                            {q.categoryLabel}
                          </span>
                          <h3 className={clsx('text-sm font-semibold mt-0.5', isLight ? 'text-slate-900' : 'text-white')}>
                            {q.question}
                          </h3>
                        </div>
                      </div>
                      <span
                        className={clsx(
                          'text-[10px] font-bold px-2 py-0.5 rounded-full border',
                          isLight
                            ? 'text-slate-600 bg-slate-100 border-slate-200'
                            : 'text-slate-400 bg-slate-800/80 border-slate-700/50'
                        )}
                      >
                        {qIndex + 1}/{questionnaire.questions.length}
                      </span>
                    </div>

                    {q.rationale && (
                      <p className={clsx('text-[11px] mb-3 pl-8', isLight ? 'text-slate-500' : 'text-slate-400')}>
                        {q.rationale}
                      </p>
                    )}

                    {/* Options list */}
                    <div className="grid grid-cols-1 gap-2 pl-2 sm:pl-8">
                      {q.options.map((opt) => {
                        const isSelected = selectedOptionId === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => handleSelectOption(q.id, opt.id)}
                            className={clsx(
                              'text-left p-3 rounded-xl border transition-all flex items-start justify-between gap-3',
                              isSelected
                                ? isLight
                                  ? 'bg-purple-50 border-purple-400 text-purple-950 shadow-sm ring-1 ring-purple-400/40'
                                  : 'bg-purple-950/40 border-purple-500/80 shadow-md shadow-purple-900/20 text-white'
                                : isLight
                                ? 'bg-slate-50/70 border-slate-200 hover:border-slate-300 text-slate-700 hover:text-slate-900'
                                : 'bg-slate-950/70 border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white'
                            )}
                          >
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <span className={clsx('text-xs font-semibold', isLight && isSelected && 'text-purple-900')}>
                                  {opt.label}
                                </span>
                                {opt.isRecommended && (
                                  <span
                                    className={clsx(
                                      'px-1.5 py-0.5 text-[9px] font-bold border rounded',
                                      isLight
                                        ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
                                        : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                                    )}
                                  >
                                    Recommended
                                  </span>
                                )}
                              </div>
                              {opt.description && (
                                <p className={clsx('text-[11px] mt-1', isLight ? 'text-slate-600' : 'text-slate-400')}>
                                  {opt.description}
                                </p>
                              )}
                              {opt.technicalImpact && (
                                <div
                                  className={clsx(
                                    'mt-1.5 text-[10px] flex items-center gap-1 font-mono',
                                    isLight ? 'text-purple-700 font-medium' : 'text-purple-300/80'
                                  )}
                                >
                                  <span>↳</span>
                                  <span>{opt.technicalImpact}</span>
                                </div>
                              )}
                            </div>

                            <div
                              className={clsx(
                                'w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors',
                                isSelected
                                  ? 'bg-purple-600 border-purple-500 text-white'
                                  : isLight
                                  ? 'border-slate-300 bg-white'
                                  : 'border-slate-600 bg-slate-900'
                              )}
                            >
                              {isSelected && <Check className="w-2.5 h-2.5" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Extra Requirements input */}
            <div
              className={clsx(
                'border rounded-2xl p-4 transition-colors',
                isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900 border-slate-800'
              )}
            >
              <label
                className={clsx(
                  'text-xs font-semibold uppercase tracking-wider block mb-1.5',
                  isLight ? 'text-slate-700' : 'text-slate-300'
                )}
              >
                Additional Custom Requirements (Optional)
              </label>
              <input
                type="text"
                value={customRequirements}
                onChange={(e) => setCustomRequirements(e.target.value)}
                placeholder="e.g. Must include automated daily backup at 2 AM UTC and KMS CMK key"
                className={clsx(
                  'w-full border rounded-xl px-3.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all',
                  isLight
                    ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white focus:border-purple-500'
                    : 'bg-slate-950 border-slate-700/80 text-white placeholder-slate-500 focus:border-purple-500'
                )}
              />
            </div>

            {/* Bottom actions bar placed cleanly at the bottom */}
            <div
              className={clsx(
                'pt-6 pb-12 border-t flex flex-col sm:flex-row items-center justify-between gap-3 transition-all',
                isLight ? 'border-slate-200' : 'border-slate-800'
              )}
            >
              <button
                onClick={() => setStep('prompt')}
                className={clsx(
                  'w-full sm:w-auto px-4 py-2.5 border rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-1.5 active:scale-[0.98]',
                  isLight
                    ? 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700 hover:text-slate-900'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-slate-200 hover:text-white'
                )}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Prompt</span>
              </button>

              <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
                <button
                  onClick={() => handleGenerate(true)}
                  disabled={loading}
                  className="w-full sm:w-auto px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 active:scale-[0.98] text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-900/40 hover:shadow-emerald-500/25 transition-all flex items-center justify-center gap-2 ring-1 ring-emerald-400/30"
                >
                  <Sparkles className="w-4 h-4 text-emerald-100 animate-pulse" />
                  <span>Generate Custom Architecture</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: GENERATING STATE */}
        {step === 'generating' && (
          <div
            className={clsx(
              'border rounded-2xl p-8 text-center shadow-2xl space-y-6',
              isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
            )}
          >
            <div className="w-14 h-14 bg-purple-600/20 border border-purple-500/40 rounded-2xl flex items-center justify-center mx-auto">
              <Loader2 className="w-7 h-7 text-purple-600 dark:text-purple-400 animate-spin" />
            </div>

            <div>
              <h3 className={clsx('font-bold text-lg', isLight ? 'text-slate-900' : 'text-white')}>
                Synthesizing Architecture
              </h3>
              <p className={clsx('text-xs mt-1', isLight ? 'text-slate-500' : 'text-slate-400')}>
                Applying Well-Architected rules and tailoring to your answers
              </p>
            </div>

            <div className="max-w-md mx-auto space-y-2.5 text-left">
              {[
                'Translating user requirements & questionnaire answers into cloud resources',
                'Isolating compute & database into Multi-AZ private subnets',
                'Configuring Web Application Firewall (WAF) & Load Balancing',
                'Executing auto-layout and Well-Architected validation',
              ].map((s) => (
                <div
                  key={s}
                  className={clsx(
                    'flex items-center gap-3 text-xs p-2.5 rounded-xl border transition-colors',
                    isLight
                      ? 'text-slate-700 bg-slate-50 border-slate-200'
                      : 'text-slate-300 bg-slate-950/60 border-slate-800'
                  )}
                >
                  <div className="w-3.5 h-3.5 border-2 border-purple-500 rounded-full border-t-transparent animate-spin flex-shrink-0" />
                  <span>{s}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* STEP 4: RESULT REVIEW */}
        {step === 'result' && result && (
          <div className="space-y-5">
            {warning && (
              <div
                className={clsx(
                  'flex items-start gap-2 text-xs p-3.5 rounded-xl border',
                  isLight
                    ? 'bg-amber-50 border-amber-200 text-amber-800'
                    : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                )}
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span className="whitespace-pre-line">{warning}</span>
              </div>
            )}

            {/* Success Summary */}
            <div
              className={clsx(
                'border rounded-2xl p-5 shadow-xl transition-colors',
                isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className={clsx(
                    'text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5',
                    isLight ? 'text-purple-700' : 'text-purple-400'
                  )}
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  Architecture Generated Successfully
                </span>
                <span
                  className={clsx(
                    'text-[11px] px-2 py-0.5 rounded-md border font-semibold',
                    isLight
                      ? 'bg-slate-100 text-slate-700 border-slate-300'
                      : 'bg-slate-800 text-slate-300 border-slate-700'
                  )}
                >
                  {provider.toUpperCase()}
                </span>
              </div>
              <p className={clsx('text-sm leading-relaxed', isLight ? 'text-slate-700' : 'text-slate-200')}>
                {result.summary}
              </p>
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-3 gap-3">
              <div
                className={clsx(
                  'border rounded-2xl p-4 text-center transition-colors',
                  isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
                )}
              >
                <Server className="w-4 h-4 text-blue-500 dark:text-blue-400 mx-auto mb-1.5" />
                <p className={clsx('font-bold text-xl', isLight ? 'text-slate-900' : 'text-white')}>
                  {result.nodes.length}
                </p>
                <p className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>Resources</p>
              </div>
              <div
                className={clsx(
                  'border rounded-2xl p-4 text-center transition-colors',
                  isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
                )}
              >
                <DollarSign className="w-4 h-4 text-amber-500 dark:text-amber-400 mx-auto mb-1.5" />
                <p className="text-amber-500 dark:text-amber-400 font-bold text-xl">${result.estimatedCost}/mo</p>
                <p className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>Est. Monthly Cost</p>
              </div>
              <div
                className={clsx(
                  'border rounded-2xl p-4 text-center transition-colors',
                  isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
                )}
              >
                <ShieldCheck className="w-4 h-4 text-emerald-500 dark:text-emerald-400 mx-auto mb-1.5" />
                <p
                  className={clsx(
                    'font-bold text-xl',
                    result.securityScore === null
                      ? isLight
                        ? 'text-slate-400 text-sm'
                        : 'text-slate-500 text-sm'
                      : 'text-emerald-500 dark:text-emerald-400'
                  )}
                >
                  {result.securityScore === null ? 'Not scored' : `${result.securityScore}%`}
                </p>
                <p className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>Security Score</p>
              </div>
            </div>

            {/* Suggested resources */}
            <div
              className={clsx(
                'border rounded-2xl p-5 transition-colors',
                isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
              )}
            >
              <p
                className={clsx(
                  'text-xs font-medium uppercase tracking-wider mb-3',
                  isLight ? 'text-slate-600' : 'text-slate-400'
                )}
              >
                Included Resources & Components
              </p>
              <div className="flex flex-wrap gap-2">
                {result.suggestedResources.map((r) => (
                  <span
                    key={r}
                    className={clsx(
                      'text-xs px-2.5 py-1 rounded-lg font-mono border',
                      isLight
                        ? 'bg-slate-100 border-slate-200 text-slate-800'
                        : 'bg-slate-950 border-slate-700/80 text-slate-200'
                    )}
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>

            {/* Project name input */}
            <div
              className={clsx(
                'border rounded-2xl p-4 transition-colors',
                isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
              )}
            >
              <label
                className={clsx('text-xs font-medium mb-1.5 block', isLight ? 'text-slate-600' : 'text-slate-400')}
              >
                Project Name
              </label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                className={clsx(
                  'w-full border rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all',
                  isLight
                    ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white focus:border-purple-500'
                    : 'bg-slate-950 border-slate-700 text-white placeholder-slate-500 focus:border-purple-500'
                )}
              />
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-3 pt-4 pb-8">
              <button
                onClick={() => {
                  setStep('prompt');
                  setResult(null);
                  setQuestionnaire(null);
                }}
                className={clsx(
                  'flex-1 min-w-[120px] py-2.5 border rounded-xl text-xs font-semibold transition-all active:scale-[0.98]',
                  isLight
                    ? 'border-slate-300 text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200'
                    : 'border-slate-700 text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800'
                )}
              >
                Start Over
              </button>

              {questionnaire && (
                <button
                  onClick={() => setStep('questionnaire')}
                  className={clsx(
                    'flex-1 min-w-[120px] py-2.5 border rounded-xl text-xs font-semibold transition-all active:scale-[0.98]',
                    isLight
                      ? 'border-purple-300 text-purple-700 hover:text-purple-900 bg-purple-50 hover:bg-purple-100'
                      : 'border-purple-500/40 text-purple-300 hover:text-white bg-purple-950/40 hover:bg-purple-900/50'
                  )}
                >
                  Adjust Answers
                </button>
              )}

              <button
                onClick={handleApply}
                disabled={result.nodes.length === 0}
                className="flex-1 min-w-[160px] py-2.5 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/30 hover:shadow-emerald-500/25 active:scale-[0.98] ring-1 ring-emerald-400/30"
              >
                <Sparkles className="w-4 h-4" />
                <span>Open in Canvas</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


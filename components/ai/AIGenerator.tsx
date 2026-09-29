'use client';
import { useState } from 'react';
import { useApp } from '@/context/AppContext';
import { calculateCosts } from '@/lib/analysis';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { mapAiGraphToCanvas } from '@/lib/ai/mapAiGraphToCanvas';
import { CloudProvider, CanvasNode, CanvasEdge, AIGeneratorResult } from '@/types';
import { Sparkles, Server, DollarSign, ShieldCheck, ChevronRight, Loader2, BookOpen, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';

const EXAMPLE_PROMPTS = [
  'Build a highly available SaaS application with React frontend, Node.js API, PostgreSQL and Redis cache',
  'Multi-tier e-commerce platform with CDN, auto-scaling and managed database',
  'Microservices architecture with container orchestration and message queuing',
  'Data lake with ETL pipeline, analytics compute and secure S3 storage',
  'Disaster recovery setup spanning AWS primary and Azure standby region',
];

/** Derives the same summary metrics the older local generator returned, but
 * from a real AI-generated graph, using the app's actual cost/security/score
 * engines instead of canned numbers. */
function summarizeGraph(nodes: CanvasNode[], edges: CanvasEdge[], prompt: string): AIGeneratorResult {
  const costs = calculateCosts(nodes);
  const estimatedCost = Math.round(costs.reduce((acc, c) => acc + c.monthlyCost, 0));
  const security = runAssessment({ nodes, edges }).securityScore;
  const suggestedResources = Array.from(new Set(nodes.map((n) => n.label || n.resourceType)));
  return {
    nodes,
    edges,
    summary: nodes.length > 0
      ? `Generated ${nodes.length} resource${nodes.length === 1 ? '' : 's'} for "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}".`
      : 'The AI did not return any resources for this prompt — try rephrasing it with more specific services.',
    suggestedResources,
    estimatedCost,
    // null ("Not scored") is a real, intentional state from the coverage-aware
    // security engine — never substitute an unrelated score (e.g. the legacy
    // validator's blended "overall" score) for it. See SecurityPanel.tsx /
    // Dashboard.tsx for the same null-means-"Not scored" convention.
    securityScore: security.score,
  };
}

export default function AIGenerator() {
  const { state, dispatch } = useApp();
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<CloudProvider>('aws');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [result, setResult] = useState<AIGeneratorResult | null>(null);
  const [projectName, setProjectName] = useState('');

  async function handleGenerate() {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);
    setWarning(null);
    setResult(null);

    try {
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          // No project exists yet at this point — the sidebar generator's
          // job is to produce a graph to seed a brand-new project with.
          // These match what the in-canvas AI Architect panel sends while
          // working on the unsaved draft; the backend only uses them to
          // (best-effort) record AI generation history, which no-ops
          // gracefully when there's no matching architecture yet.
          projectId: state.activeProjectId ?? 'draft-project',
          environmentId: state.activeEnvironment,
          provider,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate architecture');

      const { nodes, edges } = mapAiGraphToCanvas(data.data, provider);
      setResult(summarizeGraph(nodes, edges, prompt));
      setProjectName(prompt.slice(0, 40).trim());
      if (data.warning) setWarning(data.warning);
    } catch (err: any) {
      setError(err.message || 'Failed to generate architecture');
    } finally {
      setLoading(false);
    }
  }

  function handleApply() {
    if (!result) return;
    const name = projectName || prompt.slice(0, 40);
    dispatch({ type: 'CREATE_PROJECT', provider, name, nodes: result.nodes, edges: result.edges });
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-purple-600 rounded-xl flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-white font-bold text-xl">AI Architecture Generator</h1>
            <p className="text-gray-400 text-sm">Describe your architecture in plain English — powered by Azure AI Foundry</p>
          </div>
        </div>

        {/* Input area */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-gray-400 text-xs font-medium uppercase tracking-wider">Describe your architecture</label>
            <div className="flex rounded-lg border border-gray-700 overflow-hidden">
              {(['aws', 'azure'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={clsx(
                    'px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                    provider === p ? 'bg-purple-600 text-white' : 'bg-gray-900 text-gray-500 hover:text-gray-300'
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) handleGenerate(); }}
            placeholder="e.g. Build a highly available SaaS application with a React frontend, Node.js API, PostgreSQL database, Redis cache and object storage."
            rows={4}
            disabled={loading}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-purple-500 resize-none disabled:opacity-60"
          />
          <div className="flex items-center justify-between mt-3">
            <span className="text-gray-600 text-xs">⌘+Enter to generate</span>
            <button
              onClick={handleGenerate}
              disabled={!prompt.trim() || loading}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {loading ? 'Generating...' : 'Generate Architecture'}
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs p-3 rounded-xl mb-4">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Example prompts */}
        {!result && !loading && (
          <div className="mb-6">
            <p className="text-gray-500 text-xs font-medium uppercase tracking-wider mb-3">
              <BookOpen className="w-3 h-3 inline mr-1" />Example prompts
            </p>
            <div className="space-y-2">
              {EXAMPLE_PROMPTS.map((p, i) => (
                <button key={i} onClick={() => setPrompt(p)}
                  className="w-full text-left px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-400 hover:text-white hover:border-gray-600 transition-colors">
                  <ChevronRight className="w-3 h-3 inline mr-1 text-gray-600" />
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 text-center">
            <div className="flex items-center justify-center gap-3 mb-4">
              <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
              <span className="text-white font-medium">Calling Azure AI Foundry...</span>
            </div>
            <div className="space-y-2">
              {['Sending prompt to gpt-4o', 'Validating resources against the RDE catalog', 'Laying out the canvas'].map((s, i) => (
                <div key={s} className="flex items-center gap-2 text-xs text-gray-500">
                  <div className="w-3 h-3 border border-purple-500 rounded-full border-t-transparent animate-spin" style={{ animationDelay: `${i * 150}ms` }} />
                  {s}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Result */}
        {result && !loading && (
          <div className="space-y-4">
            {warning && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs p-3 rounded-xl">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{warning}</span>
              </div>
            )}

            {/* Summary */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-2">Architecture Summary</p>
              <p className="text-gray-200 text-sm leading-relaxed">{result.summary}</p>
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-800 border border-gray-700 rounded-xl p-3 text-center">
                <Server className="w-4 h-4 text-blue-400 mx-auto mb-1" />
                <p className="text-white font-bold text-lg">{result.nodes.length}</p>
                <p className="text-gray-500 text-xs">Resources</p>
              </div>
              <div className="bg-gray-800 border border-gray-700 rounded-xl p-3 text-center">
                <DollarSign className="w-4 h-4 text-orange-400 mx-auto mb-1" />
                <p className="text-orange-400 font-bold text-lg">${result.estimatedCost}</p>
                <p className="text-gray-500 text-xs">Est/mo</p>
              </div>
              <div className="bg-gray-800 border border-gray-700 rounded-xl p-3 text-center">
                <ShieldCheck className="w-4 h-4 text-emerald-400 mx-auto mb-1" />
                <p className={clsx('font-bold text-lg', result.securityScore === null ? 'text-gray-500 text-sm' : 'text-emerald-400')}>
                  {result.securityScore === null ? 'Not scored' : result.securityScore}
                </p>
                <p className="text-gray-500 text-xs">Security</p>
              </div>
            </div>

            {/* Suggested resources */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-3">Resources</p>
              <div className="flex flex-wrap gap-2">
                {result.suggestedResources.map((r) => (
                  <span key={r} className="text-xs bg-blue-900/30 border border-blue-800 text-blue-300 px-2 py-1 rounded-lg">{r}</span>
                ))}
              </div>
            </div>

            {/* Project name */}
            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Project Name</label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
              />
            </div>

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={() => { setResult(null); setPrompt(''); setWarning(null); }}
                className="flex-1 py-2 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm transition-colors"
              >
                Start Over
              </button>
              <button
                onClick={handleApply}
                disabled={result.nodes.length === 0}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                Open in Canvas
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

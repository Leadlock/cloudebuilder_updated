'use client';
import { useState } from 'react';
import { useApp } from '@/context/AppContext';
import { generateFromPrompt } from '@/lib/generator';
import { CloudProvider } from '@/types';
import { Sparkles, Server, DollarSign, ShieldCheck, ChevronRight, Loader2, BookOpen } from 'lucide-react';
import clsx from 'clsx';

const EXAMPLE_PROMPTS = [
  'Build a highly available SaaS application with React frontend, Node.js API, PostgreSQL and Redis cache',
  'Multi-tier e-commerce platform with CDN, auto-scaling and managed database',
  'Microservices architecture with container orchestration and message queuing',
  'Data lake with ETL pipeline, analytics compute and secure S3 storage',
  'Disaster recovery setup spanning AWS primary and Azure standby region',
];

export default function AIGenerator() {
  const { dispatch } = useApp();
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof generateFromPrompt> | null>(null);
  const [projectName, setProjectName] = useState('');

  async function handleGenerate() {
    if (!prompt.trim()) return;
    setLoading(true);
    setResult(null);
    await new Promise((r) => setTimeout(r, 1800));
    const res = generateFromPrompt(prompt);
    setResult(res);
    setProjectName(prompt.slice(0, 40).trim());
    setLoading(false);
  }

  function handleApply() {
    if (!result) return;
    const name = projectName || prompt.slice(0, 40);
    // Detect provider from the generated nodes: if both aws and azure nodes exist → multi
    const hasAws = result.nodes.some((n) => n.provider === 'aws');
    const hasAzure = result.nodes.some((n) => n.provider === 'azure');
    const provider: CloudProvider = hasAws && hasAzure ? 'multi' : hasAzure ? 'azure' : 'aws';
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
            <p className="text-gray-400 text-sm">Describe your architecture in plain English</p>
          </div>
        </div>

        {/* Input area */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-4">
          <label className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-2 block">Describe your architecture</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) handleGenerate(); }}
            placeholder="e.g. Build a highly available SaaS application with a React frontend, Node.js API, PostgreSQL database, Redis cache and object storage."
            rows={4}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-purple-500 resize-none"
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
              <span className="text-white font-medium">Analyzing your requirements...</span>
            </div>
            <div className="space-y-2">
              {['Parsing architecture description', 'Selecting cloud resources', 'Optimizing topology', 'Applying security best practices'].map((s, i) => (
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
                <p className="text-emerald-400 font-bold text-lg">{result.securityScore}</p>
                <p className="text-gray-500 text-xs">Security</p>
              </div>
            </div>

            {/* Suggested resources */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-3">Suggested Resources</p>
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
                onClick={() => { setResult(null); setPrompt(''); }}
                className="flex-1 py-2 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm transition-colors"
              >
                Start Over
              </button>
              <button
                onClick={handleApply}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
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

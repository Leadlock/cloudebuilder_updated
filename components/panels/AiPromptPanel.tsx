import React, { useState } from 'react';
import { Bot, Loader2, Sparkles, X } from 'lucide-react';
import { CloudProvider, CanvasNode, CanvasEdge } from '@/types';

interface AiPromptPanelProps {
  projectId: string;
  environmentId: string;
  provider: CloudProvider;
  onClose: () => void;
  onApplyGraph: (nodes: CanvasNode[], edges: CanvasEdge[]) => void;
}

export default function AiPromptPanel({
  projectId,
  environmentId,
  provider,
  onClose,
  onApplyGraph,
}: AiPromptPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          projectId,
          environmentId,
          provider
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate architecture');

      // The backend returns architectureJson matching our prompt.
      // E.g., { resources: [], connections: [] }
      const graph = data.data;

      // Map to CanvasNode format
      const newNodes: CanvasNode[] = (graph.resources || []).map((r: any, index: number) => ({
        id: r.id || `ai-node-${Date.now()}-${index}`,
        type: 'cloud_node', // React Flow node type
        resourceType: r.resourceType,
        provider: provider,
        label: r.config?.name || r.resourceType,
        position: { x: (index % 4) * 200, y: Math.floor(index / 4) * 200 }, // basic grid layout
        config: r.config || {},
        parentId: r.parentId
      }));

      const newEdges: CanvasEdge[] = (graph.connections || []).map((c: any, index: number) => ({
        id: `ai-edge-${Date.now()}-${index}`,
        source: c.sourceId,
        target: c.targetId,
        provider: provider,
      }));

      onApplyGraph(newNodes, newEdges);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="absolute top-4 left-4 w-96 bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col z-50 animate-in slide-in-from-left-4 fade-in duration-200">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-fuchsia-400" />
          <h3 className="text-white font-bold text-sm tracking-tight">AI Cloud Architect</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 flex flex-col gap-4">
        <p className="text-xs text-slate-400">
          Describe the infrastructure you want to build. The AI will translate your prompt into a valid {provider.toUpperCase()} architecture graph.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A highly available web application with a load balancer, an autoscaling group of EC2 instances, and a multi-AZ RDS database in a private subnet."
            className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-fuchsia-500/50 focus:ring-1 focus:ring-fuchsia-500/50 transition-all min-h-[120px] resize-none"
            disabled={loading}
            autoFocus
          />

          {error && (
            <div className="text-xs text-rose-400 bg-rose-500/10 p-3 rounded-xl border border-rose-500/20">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!prompt.trim() || loading}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-indigo-600 hover:from-fuchsia-500 hover:to-indigo-500 text-white text-sm font-semibold shadow-lg shadow-fuchsia-900/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Designing Architecture...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>Generate Architecture</span>
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

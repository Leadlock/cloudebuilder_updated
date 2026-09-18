import React, { useState } from 'react';
import { GitMerge, X, Activity, GitBranch, GitPullRequest, GitCommit, CheckCircle2 } from 'lucide-react';
import { CanvasNode, CanvasEdge } from '@/types';

interface GitOpsPanelProps {
  projectId: string;
  architectureId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onClose: () => void;
}

export default function GitOpsPanel({ projectId, architectureId, nodes, edges, onClose }: GitOpsPanelProps) {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<{ prUrl?: string, commitSha: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [githubOrg, setGithubOrg] = useState('cloudcraft-deployments');
  const [githubRepo, setGithubRepo] = useState('infrastructure-live');
  const [branch, setBranch] = useState('main');
  const [commitMessage, setCommitMessage] = useState('feat: update architecture from CloudCraft');
  const [createPullRequest, setCreatePullRequest] = useState(true);
  const [githubToken, setGithubToken] = useState('');

  const handleCommit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(`/api/architecture/${architectureId}/gitops/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          githubOrg,
          githubRepo,
          branch,
          commitMessage,
          createPullRequest,
          githubToken,
          nodes,
          edges
        })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to commit to GitHub');
      
      setSuccess(data);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="absolute right-4 top-20 bottom-4 w-[400px] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl flex flex-col z-30">
      <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-800/50 rounded-t-xl">
        <div className="flex items-center gap-2">
          <GitMerge className="w-5 h-5 text-white" />
          <h2 className="text-sm font-semibold text-white">GitOps & Deployment</h2>
        </div>
        <button onClick={onClose} className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {success ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
            <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center text-emerald-400 mb-2">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-white">Successfully Pushed!</h3>
            <p className="text-sm text-slate-400 max-w-xs">
              Your Terraform infrastructure code has been generated and pushed to GitHub.
            </p>
            
            <div className="w-full bg-slate-800/50 rounded-lg p-3 text-left mt-4 border border-slate-700">
              <div className="flex items-center gap-2 text-xs text-slate-300 mb-2">
                <GitCommit className="w-4 h-4 text-slate-400" />
                <span className="font-mono text-emerald-400">{success.commitSha.substring(0, 7)}</span>
              </div>
              
              {success.prUrl && (
                <a 
                  href={success.prUrl} 
                  target="_blank" 
                  rel="noreferrer"
                  className="flex items-center gap-2 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors bg-blue-900/20 p-2 rounded border border-blue-900/50 mt-3"
                >
                  <GitPullRequest className="w-4 h-4" />
                  View Pull Request on GitHub
                </a>
              )}
            </div>
            
            <button 
              onClick={() => setSuccess(null)}
              className="mt-6 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Start Another Deployment
            </button>
          </div>
        ) : (
          <form onSubmit={handleCommit} className="space-y-4">
            <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-3 text-xs text-blue-200 mb-6 leading-relaxed">
              CloudCraft generates compliant Terraform HCL and pushes it directly to your organization&apos;s infrastructure repository via GitHub API.
            </div>

            {error && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 p-3 rounded-lg text-xs mb-4">
                {error}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">GitHub Organization</label>
                <input
                  type="text"
                  value={githubOrg}
                  onChange={(e) => setGithubOrg(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">Repository Name</label>
                <input
                  type="text"
                  value={githubRepo}
                  onChange={(e) => setGithubRepo(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">Target Branch</label>
                <div className="relative">
                  <GitBranch className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">Commit Message</label>
                <input
                  type="text"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">GitHub Personal Access Token (PAT)</label>
                <input
                  type="password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxx"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                  required
                />
                <p className="text-[10px] text-slate-500 mt-1">Requires &apos;repo&apos; scope. Token is never stored.</p>
              </div>

              <div className="pt-2">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={createPullRequest}
                    onChange={(e) => setCreatePullRequest(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900"
                  />
                  <span className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">
                    Create Pull Request (Recommended)
                  </span>
                </label>
                <p className="text-xs text-slate-500 mt-1 pl-6">
                  Automatically creates a PR against {branch} to trigger CI/CD pipelines (e.g. Terraform Plan).
                </p>
              </div>
            </div>

            <div className="pt-6">
              <button
                type="submit"
                disabled={loading || !githubToken}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-lg shadow-lg flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {loading ? (
                  <>
                    <Activity className="w-4 h-4 animate-spin" />
                    Committing to GitHub...
                  </>
                ) : (
                  <>
                    <GitMerge className="w-4 h-4" />
                    {createPullRequest ? 'Generate & Create PR' : 'Commit Directly to Branch'}
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

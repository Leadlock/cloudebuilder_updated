import React, { useState } from 'react';
import { GitMerge, X, Activity, GitBranch, GitPullRequest, GitCommit, CheckCircle2 } from 'lucide-react';
import { CanvasNode, CanvasEdge } from '@/types';
import { useApp } from '@/context/AppContext';
import clsx from 'clsx';

interface GitOpsPanelProps {
  projectId: string;
  architectureId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onClose: () => void;
}

export default function GitOpsPanel({ projectId, architectureId, nodes, edges, onClose }: GitOpsPanelProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';

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
    <div className={clsx(
      "absolute right-4 top-20 bottom-4 w-[400px] rounded-xl shadow-2xl flex flex-col z-30 border",
      isLight ? "bg-white border-slate-200 text-slate-900 shadow-xl" : "bg-slate-900 border-slate-700 text-slate-100"
    )}>
      <div className={clsx(
        "p-4 border-b flex items-center justify-between rounded-t-xl",
        isLight ? "border-slate-200 bg-slate-50" : "border-slate-800 bg-slate-800/50"
      )}>
        <div className="flex items-center gap-2">
          <GitMerge className={clsx("w-5 h-5", isLight ? "text-indigo-600" : "text-white")} />
          <h2 className={clsx("text-sm font-semibold", isLight ? "text-slate-900" : "text-white")}>GitOps & Deployment</h2>
        </div>
        <button onClick={onClose} className={clsx("p-1 rounded-lg transition-colors", isLight ? "text-slate-400 hover:text-slate-800 hover:bg-slate-200" : "text-slate-400 hover:text-white hover:bg-slate-700")}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {success ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
            <div className={clsx(
              "w-16 h-16 rounded-full flex items-center justify-center mb-2",
              isLight ? "bg-emerald-100 text-emerald-600" : "bg-emerald-500/20 text-emerald-400"
            )}>
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h3 className={clsx("text-lg font-bold", isLight ? "text-slate-900" : "text-white")}>Successfully Pushed!</h3>
            <p className={clsx("text-sm max-w-xs", isLight ? "text-slate-600" : "text-slate-400")}>
              Your Terraform infrastructure code has been generated and pushed to GitHub.
            </p>
            
            <div className={clsx("w-full rounded-lg p-3 text-left mt-4 border", isLight ? "bg-slate-50 border-slate-200" : "bg-slate-800/50 border-slate-700")}>
              <div className={clsx("flex items-center gap-2 text-xs mb-2", isLight ? "text-slate-700" : "text-slate-300")}>
                <GitCommit className="w-4 h-4 text-slate-400" />
                <span className={clsx("font-mono font-bold", isLight ? "text-emerald-700" : "text-emerald-400")}>{success.commitSha.substring(0, 7)}</span>
              </div>
              
              {success.prUrl && (
                <a 
                  href={success.prUrl} 
                  target="_blank" 
                  rel="noreferrer"
                  className={clsx(
                    "flex items-center gap-2 text-sm font-medium transition-colors p-2 rounded border mt-3",
                    isLight ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100" : "bg-blue-900/20 text-blue-400 border-blue-900/50 hover:text-blue-300"
                  )}
                >
                  <GitPullRequest className="w-4 h-4" />
                  View Pull Request on GitHub
                </a>
              )}
            </div>
            
            <button 
              onClick={() => setSuccess(null)}
              className={clsx(
                "mt-6 px-4 py-2 text-sm font-semibold rounded-lg transition-colors border",
                isLight ? "bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-300" : "bg-slate-800 hover:bg-slate-700 text-white border-transparent"
              )}
            >
              Start Another Deployment
            </button>
          </div>
        ) : (
          <form onSubmit={handleCommit} className="space-y-4">
            <div className={clsx(
              "border rounded-lg p-3 text-xs mb-6 leading-relaxed",
              isLight ? "bg-blue-50 border-blue-200 text-blue-800" : "bg-blue-900/20 border-blue-500/30 text-blue-200"
            )}>
              CloudCraft generates compliant Terraform HCL and pushes it directly to your organization&apos;s infrastructure repository via GitHub API.
            </div>

            {error && (
              <div className={clsx("p-3 rounded-lg text-xs mb-4 border", isLight ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-rose-500/10 border-rose-500/30 text-rose-400")}>
                {error}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className={clsx("text-xs font-semibold block mb-1", isLight ? "text-slate-700" : "text-slate-400")}>GitHub Organization</label>
                <input
                  type="text"
                  value={githubOrg}
                  onChange={(e) => setGithubOrg(e.target.value)}
                  className={clsx(
                    "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                    isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-slate-950 border-slate-700 text-white"
                  )}
                  required
                />
              </div>

              <div>
                <label className={clsx("text-xs font-semibold block mb-1", isLight ? "text-slate-700" : "text-slate-400")}>Repository Name</label>
                <input
                  type="text"
                  value={githubRepo}
                  onChange={(e) => setGithubRepo(e.target.value)}
                  className={clsx(
                    "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                    isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-slate-950 border-slate-700 text-white"
                  )}
                  required
                />
              </div>

              <div>
                <label className={clsx("text-xs font-semibold block mb-1", isLight ? "text-slate-700" : "text-slate-400")}>Target Branch</label>
                <div className="relative">
                  <GitBranch className={clsx("w-4 h-4 absolute left-3 top-2.5", isLight ? "text-slate-400" : "text-slate-500")} />
                  <input
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className={clsx(
                      "w-full rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                      isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-slate-950 border-slate-700 text-white"
                    )}
                    required
                  />
                </div>
              </div>

              <div>
                <label className={clsx("text-xs font-semibold block mb-1", isLight ? "text-slate-700" : "text-slate-400")}>Commit Message</label>
                <input
                  type="text"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  className={clsx(
                    "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                    isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-slate-950 border-slate-700 text-white"
                  )}
                  required
                />
              </div>

              <div>
                <label className={clsx("text-xs font-semibold block mb-1", isLight ? "text-slate-700" : "text-slate-400")}>GitHub Personal Access Token (PAT)</label>
                <input
                  type="password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxx"
                  className={clsx(
                    "w-full rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                    isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-slate-950 border-slate-700 text-white"
                  )}
                  required
                />
                <p className={clsx("text-[10px] mt-1", isLight ? "text-slate-500" : "text-slate-500")}>Requires &apos;repo&apos; scope. Token is never stored.</p>
              </div>

              <div className="pt-2">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={createPullRequest}
                    onChange={(e) => setCreatePullRequest(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className={clsx("text-sm font-medium transition-colors", isLight ? "text-slate-800 group-hover:text-slate-900" : "text-slate-300 group-hover:text-white")}>
                    Create Pull Request (Recommended)
                  </span>
                </label>
                <p className={clsx("text-xs mt-1 pl-6", isLight ? "text-slate-500" : "text-slate-500")}>
                  Automatically creates a PR against {branch} to trigger CI/CD pipelines (e.g. Terraform Plan).
                </p>
              </div>
            </div>

            <div className="pt-6">
              <button
                type="submit"
                disabled={loading || !githubToken}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-lg shadow-md flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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

'use client';

import React, { useState, useEffect } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { ApiReviewService } from '@/lib/services/ApiReviewService';
import type { ArchitectureReview } from '@/lib/services/ArchitectureReviewService';
import { formatCurrency } from '@/lib/currency/formatter';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Send,
  ShieldCheck,
  Hash,
  RotateCcw,
  MessageSquare,
  ShieldAlert,
  Loader2,
  DollarSign,
  Coins
} from 'lucide-react';
import clsx from 'clsx';

export default function ReviewWorkflowPanel() {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const activeProject = useActiveProject();
  const [reviews, setReviews] = useState<ArchitectureReview[]>([]);
  const [latestReview, setLatestReview] = useState<ArchitectureReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [comments, setComments] = useState('');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const activeCurrency = state.displayCurrency || 'USD';
  const [exchangeRate, setExchangeRate] = useState<number>(1.0);

  useEffect(() => {
    if (activeCurrency === 'USD') {
      setExchangeRate(1.0);
      return;
    }
    let cancelled = false;
    fetch(`/api/currency/rates?from=USD&to=${activeCurrency}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.ok && data.data?.rate?.rate) {
          setExchangeRate(data.data.rate.rate);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeCurrency]);

  const currentUser = (state as any).currentUser ?? {
    id: 'usr-admin-1',
    role: 'admin',
    name: 'Cloud Administrator',
    email: 'admin@cloudcraft.io',
  };
  const isAdmin = currentUser.role === 'admin';

  const formatErrorMessage = (err: any, fallback = 'An error occurred'): string => {
    if (!err) return fallback;
    if (typeof err === 'string') return err;
    if (typeof err.message === 'string' && err.message !== '[object Object]') return err.message;
    if (err.error) {
      if (typeof err.error === 'string') return err.error;
      if (typeof err.error === 'object' && err.error !== null) {
        return err.error.message || err.error.code || JSON.stringify(err.error);
      }
    }
    try {
      const str = JSON.stringify(err);
      return str !== '{}' ? str : fallback;
    } catch {
      return fallback;
    }
  };

  const fetchReviews = async () => {
    if (!activeProject) return;
    setLoading(true);
    try {
      const data = await ApiReviewService.getReviews(activeProject.id, state.activeEnvironment, currentUser);
      setReviews(data.reviews || []);
      setLatestReview(data.latest || null);
    } catch (err: any) {
      console.warn('Failed to fetch reviews:', formatErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    Promise.resolve().then(() => {
      fetchReviews();
    });
  }, [activeProject?.id, state.activeEnvironment]);

  if (!activeProject) {
    return (
      <div className={clsx("flex-1 flex items-center justify-center", isLight ? "bg-slate-50 text-slate-500" : "bg-slate-950 text-slate-400")}>
        <p>Please open or create a project to access Architecture Review.</p>
      </div>
    );
  }

  const handleSubmitForReview = async () => {
    setActionLoading(true);
    setMsg(null);
    try {
      const currentEnvState = activeProject.environments?.[state.activeEnvironment];
      const nodesToReview = (state.activeEnvironment === 'production' || !currentEnvState?.nodes?.length)
        ? activeProject.nodes
        : currentEnvState.nodes;
      const edgesToReview = (state.activeEnvironment === 'production' || !currentEnvState?.edges?.length)
        ? activeProject.edges
        : currentEnvState.edges;

      const summary = {
        nodeCount: nodesToReview.length,
        edgeCount: edgesToReview.length,
        criticalIssuesCount: (activeProject as any).securityScore < 70 ? 1 : 0,
        estimatedMonthlyCost: activeProject.estimatedMonthlyCost || 0,
      };

      const newReview = await ApiReviewService.submitReview(
        activeProject.id,
        state.activeEnvironment,
        nodesToReview,
        edgesToReview,
        summary,
        currentUser
      );

      setLatestReview(newReview);
      setReviews((prev) => [newReview, ...prev]);
      setMsg({ type: 'success', text: 'Architecture successfully submitted for review!' });
    } catch (err: any) {
      setMsg({ type: 'error', text: formatErrorMessage(err, 'Failed to submit architecture for review.') });
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!latestReview) return;
    setActionLoading(true);
    setMsg(null);
    try {
      const updated = await ApiReviewService.approveReview(
        activeProject.id,
        latestReview.id,
        comments || 'Approved for deployment',
        currentUser
      );
      setLatestReview(updated);
      setReviews((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setMsg({ type: 'success', text: 'Architecture approved for deployment!' });
    } catch (err: any) {
      setMsg({ type: 'error', text: formatErrorMessage(err, 'Failed to approve review.') });
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!latestReview) return;
    if (!comments.trim()) {
      setMsg({ type: 'error', text: 'Please provide rejection comments' });
      return;
    }
    setActionLoading(true);
    setMsg(null);
    try {
      const updated = await ApiReviewService.rejectReview(activeProject.id, latestReview.id, comments, currentUser);
      setLatestReview(updated);
      setReviews((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setMsg({ type: 'success', text: 'Review marked as rejected.' });
    } catch (err: any) {
      setMsg({ type: 'error', text: formatErrorMessage(err, 'Failed to reject review.') });
    } finally {
      setActionLoading(false);
    }
  };

  const handleRequestChanges = async () => {
    if (!latestReview) return;
    if (!comments.trim()) {
      setMsg({ type: 'error', text: 'Please provide comments detailing requested changes' });
      return;
    }
    setActionLoading(true);
    setMsg(null);
    try {
      const updated = await ApiReviewService.requestChanges(activeProject.id, latestReview.id, comments, currentUser);
      setLatestReview(updated);
      setReviews((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setMsg({ type: 'success', text: 'Changes requested from architect.' });
    } catch (err: any) {
      setMsg({ type: 'error', text: formatErrorMessage(err, 'Failed to request changes.') });
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className={clsx(
      "flex-1 flex flex-col overflow-y-auto px-4 sm:px-6 lg:px-8 py-6 pb-36 space-y-6 custom-scrollbar",
      isLight ? "bg-slate-50 text-slate-900" : "bg-slate-950 text-slate-100"
    )}>
      {/* Header */}
      <div className={clsx("flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b", isLight ? "border-slate-200" : "border-slate-800")}>
        <div>
          <div className="flex items-center gap-3">
            <h1 className={clsx("text-xl font-bold tracking-tight", isLight ? "text-slate-900" : "text-white")}>Architecture Review & Approval Workflow</h1>
            <span
              className={clsx(
                'text-xs font-semibold px-2.5 py-0.5 rounded-full uppercase tracking-wider border',
                isAdmin 
                  ? (isLight ? 'bg-cyan-50 text-cyan-800 border-cyan-200' : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30')
                  : (isLight ? 'bg-indigo-50 text-indigo-800 border-indigo-200' : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30')
              )}
            >
              Current Role: {currentUser.role.toUpperCase()}
            </span>
          </div>
          <p className={clsx("text-xs mt-1", isLight ? "text-slate-500" : "text-slate-400")}>
            Enterprise change management: submit designs, verify SHA-256 integrity, review diffs, and authorize deployments.
          </p>
        </div>

        <button
          onClick={fetchReviews}
          disabled={loading}
          className={clsx(
            "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border",
            isLight ? "bg-white border-slate-200 text-slate-700 hover:bg-slate-100 shadow-sm" : "bg-slate-800 border-transparent hover:bg-slate-700 text-slate-300"
          )}
        >
          <RotateCcw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {msg && (
        <div
          className={clsx(
            'p-4 rounded-xl border text-xs flex items-center gap-2 font-medium',
            msg.type === 'success' 
              ? (isLight ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300')
              : (isLight ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-rose-950/40 border-rose-500/40 text-rose-300')
          )}
        >
          {msg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
          <span>{typeof msg.text === 'object' ? ((msg.text as any)?.message || JSON.stringify(msg.text)) : String(msg.text)}</span>
        </div>
      )}

      {/* Latest Review Status Card */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className={clsx(
            "p-6 rounded-2xl border space-y-4",
            isLight ? "bg-white border-slate-200 shadow-sm" : "bg-slate-900 border-slate-800 shadow-xl"
          )}>
            <div className="flex items-center justify-between">
              <h2 className={clsx("text-sm font-bold uppercase tracking-wider", isLight ? "text-slate-800" : "text-white")}>Current Review Status</h2>
              {latestReview ? (
                <span
                  className={clsx(
                    'text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider flex items-center gap-1.5 border',
                    latestReview.status === 'approved' && (isLight ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'),
                    latestReview.status === 'pending_review' && (isLight ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-amber-500/20 text-amber-300 border-amber-500/30'),
                    latestReview.status === 'invalidated_due_to_changes' && (isLight ? 'bg-rose-50 text-rose-800 border-rose-200' : 'bg-rose-500/20 text-rose-300 border-rose-500/40'),
                    latestReview.status === 'rejected' && (isLight ? 'bg-rose-50 text-rose-800 border-rose-200' : 'bg-rose-500/20 text-rose-300 border-rose-500/30'),
                    latestReview.status === 'changes_requested' && (isLight ? 'bg-blue-50 text-blue-800 border-blue-200' : 'bg-blue-500/20 text-blue-300 border-blue-500/30')
                  )}
                >
                  {latestReview.status === 'approved' && <CheckCircle2 className="w-3.5 h-3.5" />}
                  {latestReview.status === 'pending_review' && <Clock className="w-3.5 h-3.5" />}
                  {latestReview.status === 'invalidated_due_to_changes' && <ShieldAlert className="w-3.5 h-3.5" />}
                  {latestReview.status.replace(/_/g, ' ')}
                </span>
              ) : (
                <span className={clsx("text-xs font-medium", isLight ? "text-slate-500" : "text-slate-500")}>No review submitted yet</span>
              )}
            </div>

            {/* Invalidation Alert */}
            {latestReview?.status === 'invalidated_due_to_changes' && (
              <div className={clsx(
                "p-4 rounded-xl border text-xs space-y-2",
                isLight ? "bg-rose-50 border-rose-200 text-rose-900" : "bg-rose-950/60 border-rose-500/40 text-rose-200"
              )}>
                <div className={clsx("flex items-center gap-2 font-bold", isLight ? "text-rose-800" : "text-rose-300")}>
                  <ShieldAlert className={clsx("w-4 h-4", isLight ? "text-rose-600" : "text-rose-400")} />
                  APPROVAL INVALIDATED — TAMPER DETECTED
                </div>
                <p>
                  The architecture topology or node configurations were modified after approval was granted.
                  Deployment is blocked until an Administrator re-reviews and approves the latest changes.
                </p>
              </div>
            )}

            {latestReview && (
              <div className={clsx("grid grid-cols-2 sm:grid-cols-4 gap-3 py-3 border-y text-xs", isLight ? "border-slate-100" : "border-slate-800")}>
                <div>
                  <span className={clsx("block text-[10px]", isLight ? "text-slate-500" : "text-slate-500")}>Submitted By</span>
                  <span className={clsx("font-medium", isLight ? "text-slate-800" : "text-slate-200")}>{latestReview.submittedBy.name}</span>
                </div>
                <div>
                  <span className={clsx("block text-[10px]", isLight ? "text-slate-500" : "text-slate-500")}>Target Env</span>
                  <span className={clsx("font-medium uppercase", isLight ? "text-slate-800" : "text-slate-200")}>{latestReview.environment}</span>
                </div>
                <div>
                  <span className={clsx("block text-[10px]", isLight ? "text-slate-500" : "text-slate-500")}>Resources</span>
                  <span className={clsx("font-medium", isLight ? "text-slate-800" : "text-slate-200")}>{latestReview.summary.nodeCount} items</span>
                </div>
                <div>
                  <span className={clsx("block text-[10px]", isLight ? "text-slate-500" : "text-slate-500")}>Estimated Cost ({activeCurrency})</span>
                  <span className={clsx("font-medium", isLight ? "text-slate-800" : "text-slate-200")}>
                    {formatCurrency(latestReview.summary.estimatedMonthlyCost * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo
                  </span>
                  {activeCurrency !== 'USD' && (
                    <span className={clsx("text-[10px] block font-mono", isLight ? "text-slate-500" : "text-slate-500")}>
                      ≈ {formatCurrency(latestReview.summary.estimatedMonthlyCost, 'USD')}/mo
                    </span>
                  )}
                </div>
              </div>
            )}

            {latestReview && (
              <div className={clsx(
                "p-3 rounded-xl border text-xs font-mono flex items-center justify-between gap-3",
                isLight ? "bg-slate-50 border-slate-200 text-slate-700" : "bg-slate-950 border-slate-800 text-slate-400"
              )}>
                <div className="flex items-center gap-2 truncate">
                  <Hash className={clsx("w-4 h-4 shrink-0", isLight ? "text-cyan-600" : "text-cyan-400")} />
                  <span className={isLight ? "text-slate-500" : "text-slate-500"}>SHA256:</span>
                  <span className={clsx("truncate font-semibold", isLight ? "text-slate-800" : "text-slate-300")}>{latestReview.architectureHash}</span>
                </div>
                <span className={clsx("text-[10px] shrink-0", isLight ? "text-slate-500" : "text-slate-500")}>Deterministic</span>
              </div>
            )}

            {/* Actions for USER and ADMIN */}
            <div className="pt-2 flex flex-wrap items-center gap-3">
              <button
                onClick={handleSubmitForReview}
                disabled={actionLoading}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                {actionLoading ? 'Submitting...' : 'Submit Current Architecture for Review'}
              </button>

              {isAdmin && latestReview && latestReview.status !== 'approved' && (
                <>
                  <button
                    onClick={handleApprove}
                    disabled={actionLoading}
                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Approve Architecture
                  </button>

                  <button
                    onClick={handleReject}
                    disabled={actionLoading}
                    className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Reject
                  </button>

                  <button
                    onClick={handleRequestChanges}
                    disabled={actionLoading}
                    className={clsx(
                      "px-3 py-2 rounded-xl font-semibold text-xs transition-colors flex items-center gap-1.5 disabled:opacity-50 border",
                      isLight ? "bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-300" : "bg-slate-800 hover:bg-slate-700 text-slate-200 border-transparent"
                    )}
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Request Changes
                  </button>
                </>
              )}
            </div>

            {isAdmin && latestReview && (
              <div className="pt-2">
                <label className={clsx("text-xs font-medium block mb-1", isLight ? "text-slate-700" : "text-slate-400")}>
                  Administrator Review Comments (Optional for approval, required for rejection)
                </label>
                <input
                  type="text"
                  value={comments}
                  onChange={(e) => setComments(e.target.value)}
                  placeholder="e.g. Approved for production deployment with gp3 storage tier."
                  className={clsx(
                    "w-full rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500 border",
                    isLight ? "bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400" : "bg-slate-950 border-slate-800 text-white placeholder-slate-500"
                  )}
                />
              </div>
            )}
          </div>
        </div>

        {/* Sidebar: Audit History */}
        <div className="space-y-4">
          <div className={clsx(
            "p-6 rounded-2xl border space-y-4",
            isLight ? "bg-white border-slate-200 shadow-sm" : "bg-slate-900 border-slate-800 shadow-xl"
          )}>
            <h3 className={clsx("text-sm font-bold uppercase tracking-wider", isLight ? "text-slate-800" : "text-white")}>Review Audit Trail</h3>
            <div className="space-y-3 max-h-96 overflow-y-auto custom-scrollbar pr-1">
              {reviews.length === 0 ? (
                <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-slate-500")}>No review records yet.</p>
              ) : (
                reviews.map((r) => (
                  <div key={r.id} className={clsx("p-3 rounded-xl border space-y-1 text-xs", isLight ? "bg-slate-50 border-slate-200" : "bg-slate-950 border-slate-800")}>
                    <div className="flex items-center justify-between">
                      <span className={clsx("font-bold text-[11px]", isLight ? "text-slate-800" : "text-slate-300")}>{r.submittedBy.name}</span>
                      <span
                        className={clsx(
                          'text-[9px] font-bold px-1.5 py-0.5 rounded uppercase border',
                          r.status === 'approved' && (isLight ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : 'bg-emerald-950 text-emerald-300 border-emerald-500/30'),
                          r.status === 'pending_review' && (isLight ? 'bg-amber-100 text-amber-800 border-amber-200' : 'bg-amber-950 text-amber-300 border-amber-500/30'),
                          r.status === 'invalidated_due_to_changes' && (isLight ? 'bg-rose-100 text-rose-800 border-rose-200' : 'bg-rose-950 text-rose-300 border-rose-500/40'),
                          r.status === 'rejected' && (isLight ? 'bg-rose-100 text-rose-800 border-rose-200' : 'bg-rose-950 text-rose-300 border-rose-500/30')
                        )}
                      >
                        {r.status.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className={clsx("text-[10px] font-mono", isLight ? "text-slate-500" : "text-slate-500")}>
                      {new Date(r.submittedAt).toLocaleTimeString()} · {r.environment} · {formatCurrency((r.summary?.estimatedMonthlyCost ?? 0) * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo
                    </p>
                    {r.reviewerComments && (
                      <p className={clsx("text-[11px] italic", isLight ? "text-slate-600" : "text-slate-400")}>&ldquo;{r.reviewerComments}&rdquo;</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

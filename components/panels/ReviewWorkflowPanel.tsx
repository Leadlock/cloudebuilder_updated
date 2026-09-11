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
      <div className="flex-1 flex items-center justify-center bg-slate-950 text-slate-400">
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
    <div className="flex-1 flex flex-col overflow-y-auto bg-slate-950 text-slate-100 p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-white tracking-tight">Architecture Review & Approval Workflow</h1>
            <span
              className={clsx(
                'text-xs font-semibold px-2.5 py-0.5 rounded-full uppercase tracking-wider',
                isAdmin ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
              )}
            >
              Current Role: {currentUser.role.toUpperCase()}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Enterprise change management: submit designs, verify SHA-256 integrity, review diffs, and authorize deployments.
          </p>
        </div>

        <button
          onClick={fetchReviews}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition-colors"
        >
          <RotateCcw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {msg && (
        <div
          className={clsx(
            'p-4 rounded-xl border text-xs flex items-center gap-2 font-medium',
            msg.type === 'success' ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300' : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
          )}
        >
          {msg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
          <span>{typeof msg.text === 'object' ? ((msg.text as any)?.message || JSON.stringify(msg.text)) : String(msg.text)}</span>
        </div>
      )}

      {/* Latest Review Status Card */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Current Review Status</h2>
              {latestReview ? (
                <span
                  className={clsx(
                    'text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider flex items-center gap-1.5',
                    latestReview.status === 'approved' && 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
                    latestReview.status === 'pending_review' && 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
                    latestReview.status === 'invalidated_due_to_changes' && 'bg-rose-500/20 text-rose-300 border border-rose-500/40',
                    latestReview.status === 'rejected' && 'bg-rose-500/20 text-rose-300 border border-rose-500/30',
                    latestReview.status === 'changes_requested' && 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                  )}
                >
                  {latestReview.status === 'approved' && <CheckCircle2 className="w-3.5 h-3.5" />}
                  {latestReview.status === 'pending_review' && <Clock className="w-3.5 h-3.5" />}
                  {latestReview.status === 'invalidated_due_to_changes' && <ShieldAlert className="w-3.5 h-3.5" />}
                  {latestReview.status.replace(/_/g, ' ')}
                </span>
              ) : (
                <span className="text-xs text-slate-500 font-medium">No review submitted yet</span>
              )}
            </div>

            {/* Invalidation Alert */}
            {latestReview?.status === 'invalidated_due_to_changes' && (
              <div className="p-4 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-200 text-xs space-y-2">
                <div className="flex items-center gap-2 font-bold text-rose-300">
                  <ShieldAlert className="w-4 h-4 text-rose-400" />
                  APPROVAL INVALIDATED — TAMPER DETECTED
                </div>
                <p>
                  The architecture topology or node configurations were modified after approval was granted.
                  Deployment is blocked until an Administrator re-reviews and approves the latest changes.
                </p>
              </div>
            )}

            {latestReview && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-3 border-y border-slate-800 text-xs">
                <div>
                  <span className="text-slate-500 block text-[10px]">Submitted By</span>
                  <span className="text-slate-200 font-medium">{latestReview.submittedBy.name}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px]">Target Env</span>
                  <span className="text-slate-200 font-medium uppercase">{latestReview.environment}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px]">Resources</span>
                  <span className="text-slate-200 font-medium">{latestReview.summary.nodeCount} items</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px]">Estimated Cost ({activeCurrency})</span>
                  <span className="text-slate-200 font-medium">
                    {formatCurrency(latestReview.summary.estimatedMonthlyCost * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo
                  </span>
                  {activeCurrency !== 'USD' && (
                    <span className="text-slate-500 text-[10px] block font-mono">
                      ≈ {formatCurrency(latestReview.summary.estimatedMonthlyCost, 'USD')}/mo
                    </span>
                  )}
                </div>
              </div>
            )}

            {latestReview && (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-slate-400 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 truncate">
                  <Hash className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span className="text-slate-500">SHA256:</span>
                  <span className="text-slate-300 truncate">{latestReview.architectureHash}</span>
                </div>
                <span className="text-[10px] text-slate-500 shrink-0">Deterministic</span>
              </div>
            )}

            {/* Actions for USER and ADMIN */}
            <div className="pt-2 flex flex-wrap items-center gap-3">
              <button
                onClick={handleSubmitForReview}
                disabled={actionLoading}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition-colors flex items-center gap-2 shadow-lg shadow-indigo-600/20 disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                {actionLoading ? 'Submitting...' : 'Submit Current Architecture for Review'}
              </button>

              {isAdmin && latestReview && latestReview.status !== 'approved' && (
                <>
                  <button
                    onClick={handleApprove}
                    disabled={actionLoading}
                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors flex items-center gap-2 shadow-lg shadow-emerald-600/20 disabled:opacity-50"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Approve Architecture
                  </button>

                  <button
                    onClick={handleReject}
                    disabled={actionLoading}
                    className="px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600 text-white font-semibold text-xs transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Reject
                  </button>

                  <button
                    onClick={handleRequestChanges}
                    disabled={actionLoading}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Request Changes
                  </button>
                </>
              )}
            </div>

            {isAdmin && latestReview && (
              <div className="pt-2">
                <label className="text-xs text-slate-400 font-medium block mb-1">
                  Administrator Review Comments (Optional for approval, required for rejection)
                </label>
                <input
                  type="text"
                  value={comments}
                  onChange={(e) => setComments(e.target.value)}
                  placeholder="e.g. Approved for production deployment with gp3 storage tier."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>
            )}
          </div>
        </div>

        {/* Sidebar: Audit History */}
        <div className="space-y-4">
          <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 shadow-xl">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">Review Audit Trail</h3>
            <div className="space-y-3 max-h-96 overflow-y-auto custom-scrollbar pr-1">
              {reviews.length === 0 ? (
                <p className="text-xs text-slate-500">No review records yet.</p>
              ) : (
                reviews.map((r) => (
                  <div key={r.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-300 text-[11px]">{r.submittedBy.name}</span>
                      <span
                        className={clsx(
                          'text-[9px] font-bold px-1.5 py-0.5 rounded uppercase',
                          r.status === 'approved' && 'bg-emerald-950 text-emerald-300 border border-emerald-500/30',
                          r.status === 'pending_review' && 'bg-amber-950 text-amber-300 border border-amber-500/30',
                          r.status === 'invalidated_due_to_changes' && 'bg-rose-950 text-rose-300 border border-rose-500/40',
                          r.status === 'rejected' && 'bg-rose-950 text-rose-300 border border-rose-500/30'
                        )}
                      >
                        {r.status.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 font-mono">
                      {new Date(r.submittedAt).toLocaleTimeString()} · {r.environment} · {formatCurrency((r.summary?.estimatedMonthlyCost ?? 0) * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo
                    </p>
                    {r.reviewerComments && (
                      <p className="text-[11px] text-slate-400 italic">&ldquo;{r.reviewerComments}&rdquo;</p>
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

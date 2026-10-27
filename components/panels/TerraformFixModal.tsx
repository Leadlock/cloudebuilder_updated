'use client';
import React, { useState } from 'react';
import {
  X,
  Wrench,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  ShieldAlert,
  Network,
  Cpu,
  Layers,
  Bot,
  Loader2,
  Check,
  ChevronRight,
  Info,
} from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';
import { StructuredTerraformWarning } from '@/lib/terraform/terraformWarningAnalyzer';

interface TerraformFixModalProps {
  warning: StructuredTerraformWarning | null;
  isOpen: boolean;
  onClose: () => void;
  onApplyManualFix: (warning: StructuredTerraformWarning, inputs?: Record<string, string>) => void;
  onApplyAiFix: (warning: StructuredTerraformWarning, prompt: string, inputs: Record<string, string>) => Promise<void>;
  initialTab?: 'manual' | 'ai';
}

export default function TerraformFixModal({
  warning,
  isOpen,
  onClose,
  onApplyManualFix,
  onApplyAiFix,
  initialTab = 'manual',
}: TerraformFixModalProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  const [activeTab, setActiveTab] = useState<'manual' | 'ai'>(initialTab);
  const [aiPrompt, setAiPrompt] = useState<string>('');
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [isApplying, setIsApplying] = useState(false);
  const [appliedSuccess, setAppliedSuccess] = useState(false);

  // Sync state whenever modal opens or warning changes
  React.useEffect(() => {
    if (warning) {
      setActiveTab(initialTab);
      setAiPrompt(warning.aiPrompt);
      const defaults: Record<string, string> = {};
      warning.aiInputs?.forEach((inp) => {
        defaults[inp.id] = inp.defaultValue;
      });
      setInputValues(defaults);
      setIsApplying(false);
      setAppliedSuccess(false);
    }
  }, [warning, initialTab]);

  if (!isOpen || !warning) return null;

  const handleInputChange = (id: string, value: string) => {
    setInputValues((prev) => ({ ...prev, [id]: value }));
  };

  const handleManualApply = () => {
    setIsApplying(true);
    try {
      onApplyManualFix(warning, inputValues);
      setAppliedSuccess(true);
      setTimeout(() => {
        onClose();
      }, 1200);
    } finally {
      setIsApplying(false);
    }
  };

  const handleAiApply = async () => {
    setIsApplying(true);
    try {
      await onApplyAiFix(warning, aiPrompt, inputValues);
      setAppliedSuccess(true);
      setTimeout(() => {
        onClose();
      }, 1200);
    } catch {
      setIsApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className={clsx(
          'w-full max-w-2xl rounded-2xl border shadow-2xl overflow-hidden flex flex-col max-h-[90vh] transition-all',
          isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-slate-900 border-slate-800 text-slate-100 shadow-slate-950/80'
        )}
      >
        {/* Header */}
        <div
          className={clsx(
            'flex items-center justify-between px-6 py-4 border-b shrink-0',
            warning.severity === 'critical'
              ? isLight ? 'bg-rose-50 border-rose-200' : 'bg-rose-950/30 border-rose-900/40'
              : isLight ? 'bg-amber-50/80 border-amber-200' : 'bg-amber-950/20 border-amber-900/30'
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={clsx(
                'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border shadow-xs',
                warning.severity === 'critical'
                  ? 'bg-rose-500 text-white border-rose-400'
                  : 'bg-amber-500 text-slate-950 border-amber-400 font-bold'
              )}
            >
              {warning.category === 'load_balancer' && <Layers className="w-5 h-5" />}
              {warning.category === 'networking' && <Network className="w-5 h-5" />}
              {warning.category === 'security' && <ShieldAlert className="w-5 h-5" />}
              {warning.category === 'database' && <Cpu className="w-5 h-5" />}
              {warning.category === 'general' && <AlertTriangle className="w-5 h-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={clsx(
                    'px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider',
                    warning.severity === 'critical'
                      ? 'bg-rose-500/20 text-rose-500 border border-rose-500/30'
                      : 'bg-amber-500/20 text-amber-500 border border-amber-500/30'
                  )}
                >
                  {warning.severity}
                </span>
                {warning.affectedResource && (
                  <span className="text-xs font-mono font-semibold opacity-75 truncate max-w-xs">
                    {warning.affectedResource}
                  </span>
                )}
              </div>
              <h2 className="text-sm sm:text-base font-bold mt-0.5 leading-snug line-clamp-1">
                {warning.title}
              </h2>
            </div>
          </div>

          <button
            onClick={onClose}
            className={clsx(
              'p-2 rounded-xl transition-colors',
              isLight ? 'hover:bg-slate-200/60 text-slate-500' : 'hover:bg-slate-800 text-slate-400 hover:text-white'
            )}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className={clsx('flex border-b shrink-0 px-6 pt-2', isLight ? 'border-slate-200 bg-slate-50/50' : 'border-slate-800 bg-slate-950/40')}>
          <button
            onClick={() => setActiveTab('manual')}
            className={clsx(
              'flex items-center gap-2 px-4 py-2.5 text-xs font-bold border-b-2 transition-all cursor-pointer',
              activeTab === 'manual'
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white'
            )}
          >
            <Wrench className="w-3.5 h-3.5" />
            <span>Manual Fix & Instructions</span>
            {warning.canAutoFixManually && (
              <span className="px-1.5 py-0.2 rounded text-[9px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-extrabold border border-emerald-500/30">
                1-Click Quick Fix
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('ai')}
            className={clsx(
              'flex items-center gap-2 px-4 py-2.5 text-xs font-bold border-b-2 transition-all cursor-pointer ml-2',
              activeTab === 'ai'
                ? 'border-purple-600 text-purple-600 dark:border-purple-400 dark:text-purple-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white'
            )}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Fix with AI Architect</span>
            <span className="px-1.5 py-0.2 rounded text-[9px] bg-purple-500/15 text-purple-600 dark:text-purple-400 font-extrabold border border-purple-500/30">
              Interactive
            </span>
          </button>
        </div>

        {/* Body Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Issue Summary Card */}
          <div
            className={clsx(
              'p-3.5 rounded-xl border text-xs leading-relaxed space-y-2',
              isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800/80'
            )}
          >
            <div>
              <span className="font-bold text-slate-500 uppercase tracking-wider text-[10px] block mb-0.5">Problem</span>
              <p className={isLight ? 'text-slate-800' : 'text-slate-200'}>{warning.problem}</p>
            </div>
            {warning.impact && (
              <div className="pt-2 border-t border-slate-200/60 dark:border-slate-800/60">
                <span className="font-bold text-rose-500 uppercase tracking-wider text-[10px] block mb-0.5">Deployment Impact</span>
                <p className={isLight ? 'text-rose-900' : 'text-rose-300'}>{warning.impact}</p>
              </div>
            )}
          </div>

          {activeTab === 'manual' ? (
            /* ── Manual Fix View ── */
            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" />
                  Recommended Resolution
                </h4>
                <p className="text-xs font-medium leading-relaxed">{warning.suggestedFix}</p>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2.5">
                  Step-by-Step Configuration Steps
                </h4>
                <div className="space-y-2">
                  {warning.manualSteps.map((step, idx) => (
                    <div
                      key={idx}
                      className={clsx(
                        'flex items-start gap-3 p-2.5 rounded-xl border text-xs',
                        isLight ? 'bg-white border-slate-200 text-slate-700' : 'bg-slate-900 border-slate-800 text-slate-300'
                      )}
                    >
                      <span className="w-5 h-5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 font-mono font-bold flex items-center justify-center shrink-0 text-[11px] border border-blue-500/20">
                        {idx + 1}
                      </span>
                      <span className="pt-0.5 leading-relaxed">{step}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 1-Click Auto Fix Action if available */}
              {warning.canAutoFixManually && (
                <div
                  className={clsx(
                    'p-4 rounded-2xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-4',
                    isLight
                      ? 'bg-emerald-50/60 border-emerald-200'
                      : 'bg-emerald-950/20 border-emerald-800/40'
                  )}
                >
                  <div>
                    <h5 className="text-xs font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      1-Click Instant Canvas Remediation
                    </h5>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
                      Automatically updates canvas resources and regenerates your production Terraform configuration.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleManualApply}
                    disabled={isApplying || appliedSuccess}
                    className={clsx(
                      'px-4 py-2 rounded-xl text-xs font-bold text-white shadow-md transition-all shrink-0 flex items-center justify-center gap-2 cursor-pointer',
                      appliedSuccess
                        ? 'bg-emerald-500'
                        : 'bg-emerald-600 hover:bg-emerald-500 active:scale-95'
                    )}
                  >
                    {isApplying ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : appliedSuccess ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <ArrowRight className="w-3.5 h-3.5" />
                    )}
                    <span>{appliedSuccess ? 'Applied!' : (warning.autoFixButtonLabel || 'Apply Manual Fix')}</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* ── AI Fix View ── */
            <div className="space-y-4">
              {/* AI Prompt Area */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1.5 flex items-center gap-1.5">
                  <Bot className="w-3.5 h-3.5 text-purple-500" />
                  AI Architect Remediation Prompt
                </label>
                <textarea
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  rows={3}
                  className={clsx(
                    'w-full text-xs font-mono rounded-xl p-3 border transition-colors resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/50',
                    isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-800 text-slate-200'
                  )}
                  placeholder="Describe your fix specifications..."
                />
              </div>

              {/* Dynamic Inputs Form */}
              {warning.aiInputs && warning.aiInputs.length > 0 && (
                <div className="space-y-3 pt-2 border-t border-slate-200/60 dark:border-slate-800/60">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                    Parameters & Technical Inputs for AI Fix
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {warning.aiInputs.map((input) => (
                      <div
                        key={input.id}
                        className={clsx(
                          'p-3 rounded-xl border flex flex-col justify-between gap-1.5',
                          isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800'
                        )}
                      >
                        <div>
                          <label className="text-xs font-semibold block">{input.label}</label>
                          {input.description && (
                            <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                              {input.description}
                            </p>
                          )}
                        </div>

                        {input.type === 'select' ? (
                          <select
                            value={inputValues[input.id] || input.defaultValue}
                            onChange={(e) => handleInputChange(input.id, e.target.value)}
                            className={clsx(
                              'text-xs font-mono rounded-lg px-2.5 py-1.5 border mt-1 focus:outline-none focus:ring-2 focus:ring-purple-500/50',
                              isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-900 border-slate-700 text-slate-100'
                            )}
                          >
                            {input.options?.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        ) : input.type === 'checkbox' ? (
                          <label className="flex items-center gap-2 mt-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={inputValues[input.id] === 'true'}
                              onChange={(e) => handleInputChange(input.id, String(e.target.checked))}
                              className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500"
                            />
                            <span className="text-xs font-mono">Enabled</span>
                          </label>
                        ) : (
                          <input
                            type="text"
                            value={inputValues[input.id] || ''}
                            onChange={(e) => handleInputChange(input.id, e.target.value)}
                            placeholder={input.placeholder || input.defaultValue}
                            className={clsx(
                              'text-xs font-mono rounded-lg px-2.5 py-1.5 border mt-1 focus:outline-none focus:ring-2 focus:ring-purple-500/50',
                              isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-900 border-slate-700 text-slate-100'
                            )}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className={clsx(
            'flex items-center justify-between px-6 py-4 border-t shrink-0',
            isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/80 border-slate-800'
          )}
        >
          <button
            type="button"
            onClick={onClose}
            className={clsx(
              'px-4 py-2 rounded-xl text-xs font-semibold border transition-colors',
              isLight ? 'border-slate-300 hover:bg-slate-100 text-slate-700' : 'border-slate-800 hover:bg-slate-800 text-slate-300'
            )}
          >
            Cancel
          </button>

          {activeTab === 'ai' ? (
            <button
              type="button"
              onClick={handleAiApply}
              disabled={isApplying || appliedSuccess || !aiPrompt.trim()}
              className={clsx(
                'px-5 py-2.5 rounded-xl text-xs font-bold text-white shadow-lg transition-all flex items-center gap-2 cursor-pointer',
                appliedSuccess
                  ? 'bg-emerald-500'
                  : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 active:scale-95 shadow-purple-950/40'
              )}
            >
              {isApplying ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : appliedSuccess ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-purple-200" />
              )}
              <span>{appliedSuccess ? 'Fix Applied!' : 'Execute AI Fix'}</span>
            </button>
          ) : (
            warning.canAutoFixManually && (
              <button
                type="button"
                onClick={handleManualApply}
                disabled={isApplying || appliedSuccess}
                className={clsx(
                  'px-5 py-2.5 rounded-xl text-xs font-bold text-white shadow-lg transition-all flex items-center gap-2 cursor-pointer',
                  appliedSuccess
                    ? 'bg-emerald-500'
                    : 'bg-emerald-600 hover:bg-emerald-500 active:scale-95 shadow-emerald-950/40'
                )}
              >
                {isApplying ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : appliedSuccess ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                <span>{appliedSuccess ? 'Applied!' : (warning.autoFixButtonLabel || 'Apply Manual Fix')}</span>
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

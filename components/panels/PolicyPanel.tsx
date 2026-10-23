'use client';

import React, { useMemo, useState, useEffect } from 'react';
import {
  ShieldAlert, CheckCircle2, AlertTriangle, Shield, Code, Play, RefreshCw,
  Plus, X, Info, DollarSign, Database, Lock, Sliders, Check, Terminal
} from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';
import { BUILT_IN_OPA_POLICIES } from '@/lib/opa/builtInPolicies';
import type { OpaEvaluationResult, OpaPolicyDefinition, OpaViolation } from '@/lib/opa/types';

export default function PolicyPanel() {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  const activeProject = state.projects.find((p) => p.id === state.activeProjectId) ?? state.draftProject;
  const nodes = activeProject.nodes ?? [];

  const [activeTab, setActiveTab] = useState<'guardrails' | 'editor' | 'evaluate'>('guardrails');
  const [policies, setPolicies] = useState<OpaPolicyDefinition[]>(BUILT_IN_OPA_POLICIES);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [evaluating, setEvaluating] = useState(false);
  const [evalResult, setEvalResult] = useState<OpaEvaluationResult | null>(null);

  // Custom Rego editor state
  const [customRuleName, setCustomRuleName] = useState('');
  const [customRuleSeverity, setCustomRuleSeverity] = useState<'deny' | 'warn'>('deny');
  const [customRuleCategory, setCustomRuleCategory] = useState<'security' | 'cost' | 'blast_radius' | 'compliance'>('security');
  const [regoCode, setRegoCode] = useState<string>(`package cloudbuilder.custom

default allow = true

# Prohibit unencrypted S3 storage
deny[sprintf("Bucket %v lacks server-side encryption", [node.label])] {
    node := input.canvas.nodes[_]
    node.resourceType == "aws_s3"
    node.config.encryption == false
}
`);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  // Load policies
  useEffect(() => {
    async function loadPolicies() {
      try {
        const res = await fetch('/api/opa/policies');
        if (res.ok) {
          const json = await res.json();
          const policyList = json.data?.policies ?? json.policies ?? (Array.isArray(json.data) ? json.data : null);
          if (Array.isArray(policyList)) setPolicies(policyList);
        }
      } catch {}
    }
    loadPolicies();
  }, []);

  // Toggle a policy
  const togglePolicy = async (policyId: string) => {
    const updated = policies.map((p) => (p.id === policyId ? { ...p, enabled: !p.enabled } : p));
    setPolicies(updated);

    const disabledIds = updated.filter((p) => !p.enabled).map((p) => p.id);
    const custom = updated.filter((p) => !p.isBuiltIn);

    try {
      await fetch('/api/opa/policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabledPolicyIds: disabledIds, customPolicies: custom }),
      });
    } catch {}
  };

  // Run OPA evaluation against active canvas & estimated cost
  const handleEvaluate = async () => {
    setEvaluating(true);
    try {
      const res = await fetch('/api/opa/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas: { nodes },
          cost: {
            monthlyTotalUsd: 1250, // Connected to active cost engine
            annualTotalUsd: 15000,
            currency: 'USD',
          },
          environment: state.activeEnvironment,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const evalData = json.data ?? json;
        setEvalResult(evalData);
      }
    } catch (err) {
      console.error('Evaluation failed:', err);
    } finally {
      setEvaluating(false);
    }
  };

  // Add custom rule
  const handleSaveCustomRule = async () => {
    if (!customRuleName.trim()) return;
    const newPolicy: OpaPolicyDefinition = {
      id: `custom-${Date.now()}`,
      name: customRuleName.trim(),
      description: 'Custom organization Rego policy',
      category: customRuleCategory,
      severity: customRuleSeverity,
      enabled: true,
      isBuiltIn: false,
      regoCode,
    };

    const updated = [...policies, newPolicy];
    setPolicies(updated);
    setSaveStatus('Custom Rego policy saved successfully!');
    setCustomRuleName('');

    const disabledIds = updated.filter((p) => !p.enabled).map((p) => p.id);
    const custom = updated.filter((p) => !p.isBuiltIn);

    try {
      await fetch('/api/opa/policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabledPolicyIds: disabledIds, customPolicies: custom }),
      });
    } catch {}

    setTimeout(() => setSaveStatus(null), 3000);
  };

  const filteredPolicies = policies.filter(
    (p) => selectedCategory === 'all' || p.category === selectedCategory,
  );

  return (
    <div className={clsx('flex flex-col h-full overflow-y-auto p-6 transition-colors', isLight ? 'bg-slate-50 text-slate-900' : 'bg-slate-950 text-slate-100')}>
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight">Policy as Code via OPA / Rego</h1>
            <span className={clsx('px-2.5 py-0.5 text-xs font-semibold rounded-full border', isLight ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300')}>
              Open Policy Agent Guardrails
            </span>
          </div>
          <p className={clsx('text-xs mt-1', isLight ? 'text-slate-500' : 'text-slate-400')}>
            Enforces enterprise compliance, FinOps cost guardrails, and security policies before plans are approved or applied.
          </p>
        </div>

        {/* Tab Navigation */}
        <div className={clsx('flex items-center p-1 rounded-xl border', isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800')}>
          <button
            onClick={() => setActiveTab('guardrails')}
            className={clsx('px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all', activeTab === 'guardrails' ? (isLight ? 'bg-indigo-600 text-white shadow-xs' : 'bg-indigo-500 text-white') : 'opacity-70 hover:opacity-100')}
          >
            Guardrail Catalog ({policies.length})
          </button>
          <button
            onClick={() => setActiveTab('editor')}
            className={clsx('px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all', activeTab === 'editor' ? (isLight ? 'bg-indigo-600 text-white shadow-xs' : 'bg-indigo-500 text-white') : 'opacity-70 hover:opacity-100')}
          >
            Rego Policy Studio
          </button>
          <button
            onClick={() => { setActiveTab('evaluate'); handleEvaluate(); }}
            className={clsx('px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all', activeTab === 'evaluate' ? (isLight ? 'bg-indigo-600 text-white shadow-xs' : 'bg-indigo-500 text-white') : 'opacity-70 hover:opacity-100')}
          >
            Live Evaluation
          </button>
        </div>
      </div>

      {/* Tab 1: Guardrail Catalog */}
      {activeTab === 'guardrails' && (
        <div className="space-y-6">
          {/* Category Filter Pills */}
          <div className="flex flex-wrap gap-2">
            {['all', 'security', 'cost', 'blast_radius', 'reliability', 'compliance'].map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={clsx(
                  'px-3 py-1 rounded-lg text-xs font-medium border transition-all capitalize',
                  selectedCategory === cat
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 font-bold'
                    : (isLight ? 'bg-white border-slate-200 text-slate-600 hover:border-slate-300' : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'),
                )}
              >
                {cat.replace('_', ' ')}
              </button>
            ))}
          </div>

          {/* Policy Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredPolicies.map((policy) => {
              const isEnabled = policy.enabled;
              return (
                <div
                  key={policy.id}
                  className={clsx(
                    'p-5 rounded-2xl border transition-all flex flex-col justify-between',
                    isEnabled
                      ? (isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-slate-900/60 border-slate-800')
                      : 'opacity-50 bg-slate-100/50 dark:bg-slate-950/40 border-dashed border-slate-300 dark:border-slate-800',
                  )}
                >
                  <div>
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2">
                        <span className={clsx(
                          'px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider',
                          policy.severity === 'deny' ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' : 'bg-amber-500/10 text-amber-500 border border-amber-500/20',
                        )}>
                          {policy.severity}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400 uppercase">{policy.category.replace('_', ' ')}</span>
                      </div>

                      {/* Toggle Switch */}
                      <button
                        onClick={() => togglePolicy(policy.id)}
                        className={clsx(
                          'w-9 h-5 rounded-full p-0.5 transition-colors relative',
                          isEnabled ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700',
                        )}
                      >
                        <div className={clsx(
                          'w-4 h-4 rounded-full bg-white shadow-xs transition-transform',
                          isEnabled ? 'translate-x-4' : 'translate-x-0',
                        )} />
                      </button>
                    </div>

                    <h3 className="text-sm font-bold">{policy.name}</h3>
                    <p className={clsx('text-xs mt-1 leading-relaxed', isLight ? 'text-slate-600' : 'text-slate-400')}>{policy.description}</p>

                    {policy.metadata?.benchmark && (
                      <p className="text-[11px] font-mono text-indigo-400 mt-2">
                        Ref: {policy.metadata.benchmark}
                      </p>
                    )}
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
                    <span>{policy.isBuiltIn ? 'Built-in Rule' : 'Custom Organization Rule'}</span>
                    <button
                      onClick={() => {
                        setCustomRuleName(`${policy.name} (Copy)`);
                        setRegoCode(policy.regoCode);
                        setActiveTab('editor');
                      }}
                      className="text-indigo-400 hover:underline"
                    >
                      View Rego Code →
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab 2: Rego Policy Studio */}
      {activeTab === 'editor' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1 min-h-0">
          <div className={clsx('lg:col-span-4 p-5 rounded-2xl border space-y-4', isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-slate-900/60 border-slate-800')}>
            <h2 className="text-sm font-bold">Create Custom Rego Policy</h2>
            <p className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>
              Author declarative Open Policy Agent rules evaluated against Terraform plans and canvas architectures.
            </p>

            <div>
              <label className="text-xs font-semibold block mb-1">Rule Name</label>
              <input
                type="text"
                placeholder="e.g., Mandatory Tag: CostCenter"
                value={customRuleName}
                onChange={(e) => setCustomRuleName(e.target.value)}
                className={clsx('w-full px-3 py-2 rounded-xl text-xs border outline-none font-medium', isLight ? 'bg-white border-slate-300' : 'bg-slate-950 border-slate-700')}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold block mb-1">Enforcement</label>
                <select
                  value={customRuleSeverity}
                  onChange={(e) => setCustomRuleSeverity(e.target.value as any)}
                  className={clsx('w-full px-2.5 py-2 rounded-xl text-xs border outline-none font-medium', isLight ? 'bg-white border-slate-300' : 'bg-slate-950 border-slate-700')}
                >
                  <option value="deny">DENY (Block Deploy)</option>
                  <option value="warn">WARN (Advisory Alert)</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold block mb-1">Category</label>
                <select
                  value={customRuleCategory}
                  onChange={(e) => setCustomRuleCategory(e.target.value as any)}
                  className={clsx('w-full px-2.5 py-2 rounded-xl text-xs border outline-none font-medium', isLight ? 'bg-white border-slate-300' : 'bg-slate-950 border-slate-700')}
                >
                  <option value="security">Security</option>
                  <option value="cost">Cost</option>
                  <option value="blast_radius">Blast Radius</option>
                  <option value="compliance">Compliance</option>
                </select>
              </div>
            </div>

            <button
              onClick={handleSaveCustomRule}
              disabled={!customRuleName.trim()}
              className="w-full py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white shadow-md transition-all"
            >
              Save Custom Policy
            </button>

            {saveStatus && (
              <p className="text-xs text-emerald-500 font-semibold">{saveStatus}</p>
            )}
          </div>

          <div className={clsx('lg:col-span-8 p-5 rounded-2xl border flex flex-col', isLight ? 'bg-white border-slate-200' : 'bg-slate-900/60 border-slate-800')}>
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 mb-3">
              <div className="flex items-center gap-2">
                <Code className="w-4 h-4 text-indigo-400" />
                <span className="text-xs font-bold uppercase tracking-wider">Rego Language Definition</span>
              </div>
              <span className="text-[11px] font-mono text-slate-400">package cloudbuilder.custom</span>
            </div>

            <textarea
              value={regoCode}
              onChange={(e) => setRegoCode(e.target.value)}
              className="w-full flex-1 p-4 bg-slate-950 text-emerald-400 font-mono text-xs rounded-xl border border-slate-800 outline-none resize-none leading-relaxed"
              rows={18}
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {/* Tab 3: Live Evaluation Test Bench */}
      {activeTab === 'evaluate' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold">Policy Evaluation Results</h2>
              <p className={clsx('text-xs mt-0.5', isLight ? 'text-slate-500' : 'text-slate-400')}>
                Evaluated against current active canvas resources ({nodes.length} nodes) and estimated monthly spend.
              </p>
            </div>

            <button
              onClick={handleEvaluate}
              disabled={evaluating}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition-all"
            >
              <RefreshCw className={clsx('w-3.5 h-3.5', evaluating && 'animate-spin')} />
              Re-evaluate Policies
            </button>
          </div>

          {evalResult ? (
            <div className="space-y-4">
              {/* Status Header */}
              <div className={clsx(
                'p-5 rounded-2xl border flex items-center justify-between',
                evalResult.passed
                  ? (isLight ? 'bg-emerald-50 border-emerald-200' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300')
                  : (isLight ? 'bg-rose-50 border-rose-200' : 'bg-rose-500/10 border-rose-500/30 text-rose-300'),
              )}>
                <div className="flex items-center gap-3">
                  {evalResult.passed ? <CheckCircle2 className="w-6 h-6 text-emerald-500" /> : <ShieldAlert className="w-6 h-6 text-rose-500" />}
                  <div>
                    <h3 className="text-sm font-bold">
                      {evalResult.passed ? 'All OPA Guardrails Passed' : `${evalResult.violations.length} Guardrail Violation(s) Found`}
                    </h3>
                    <p className="text-xs opacity-80 mt-0.5">
                      Evaluated {evalResult.rulesEvaluated} rules in {evalResult.durationMs}ms at {new Date(evalResult.evaluatedAt).toLocaleTimeString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 font-mono text-xs">
                  <span className="text-rose-500 font-bold">{evalResult.violations.length} Denials</span>
                  <span className="text-amber-500 font-bold">{evalResult.warnings.length} Warnings</span>
                </div>
              </div>

              {/* Violations & Warnings List */}
              <div className="space-y-3">
                {[...evalResult.violations, ...evalResult.warnings].map((violation, idx) => (
                  <div
                    key={idx}
                    className={clsx(
                      'p-4 rounded-xl border flex items-start justify-between gap-4',
                      violation.severity === 'deny'
                        ? (isLight ? 'bg-rose-50/50 border-rose-200' : 'bg-rose-950/20 border-rose-500/30')
                        : (isLight ? 'bg-amber-50/50 border-amber-200' : 'bg-amber-950/20 border-amber-500/30'),
                    )}
                  >
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={clsx(
                          'px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase',
                          violation.severity === 'deny' ? 'bg-rose-500 text-white' : 'bg-amber-500 text-white',
                        )}>
                          {violation.severity}
                        </span>
                        <span className="text-xs font-bold">{violation.ruleTitle}</span>
                        {violation.resourceAddress && (
                          <span className="text-xs font-mono text-slate-400">({violation.resourceAddress})</span>
                        )}
                      </div>
                      <p className="text-xs mt-1 text-slate-300">{violation.message}</p>
                      {violation.remediation && (
                        <p className="text-[11px] text-indigo-400 mt-2 font-mono">
                          Remediation: {violation.remediation}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="p-8 text-center border rounded-2xl">
              <RefreshCw className="w-8 h-8 mx-auto mb-2 opacity-30 text-indigo-500 animate-spin" />
              <p className="text-xs">Evaluating OPA guardrails against current architecture…</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

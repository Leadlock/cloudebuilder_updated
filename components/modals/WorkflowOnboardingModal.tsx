'use client';
import React, { useState } from 'react';
import { useApp } from '@/context/AppContext';
import {
  Boxes, ShieldCheck, GitFork, Terminal, RefreshCw,
  ArrowRight, ArrowLeft, Check, Sparkles, X, Compass, ExternalLink
} from 'lucide-react';
import clsx from 'clsx';
import { AppView } from '@/types';

interface WorkflowOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialStep?: number;
}

interface WorkflowStepInfo {
  step: number;
  view: AppView;
  badge: string;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  color: string;
  lightBg: string;
  darkBg: string;
  description: string;
  features: string[];
  nextHint: string;
  actionButtonLabel: string;
}

const WORKFLOW_STEPS: WorkflowStepInfo[] = [
  {
    step: 1,
    view: 'canvas',
    badge: 'Phase 1 · Visual Modeling',
    title: '1. Visual Builder: Design Your Cloud Architecture',
    subtitle: 'Drag-and-drop cloud topology with real-time connectivity validation',
    icon: Boxes,
    color: 'text-blue-500',
    lightBg: 'bg-blue-50 border-blue-200 text-blue-700',
    darkBg: 'bg-blue-950/60 border-blue-500/30 text-blue-400',
    description:
      'Start by designing your desired cloud infrastructure. Drag VPCs, subnets, compute instances, databases, and managed services onto the interactive canvas.',
    features: [
      'Multi-Cloud & Hybrid: Model AWS (VPC, EC2, RDS, S3, EKS) and Azure (VNet, VMs, SQL, Blob) seamlessly.',
      'Active Dataflow Routing: Smart connection lines with live green health indicators verify relationship integrity.',
      'AI & Templates: Kickstart designs with instant AI architecture generation or enterprise-ready blueprints.'
    ],
    nextHint: 'Once designed, validate your architecture against security, CIS baselines, and cost projections.',
    actionButtonLabel: 'Go to Visual Builder'
  },
  {
    step: 2,
    view: 'review',
    badge: 'Phase 2 · Governance & Security',
    title: '2. Architecture Review: Security, Posture & Cost Scans',
    subtitle: 'Automated compliance scans, CIS benchmarks, and 1-click AI auto-fixes',
    icon: ShieldCheck,
    color: 'text-emerald-500',
    lightBg: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    darkBg: 'bg-emerald-950/60 border-emerald-500/30 text-emerald-400',
    description:
      'Never deploy blind. CloudBuilder automatically scans your design for security flaws, IAM misconfigurations, open ports, and Well-Architected compliance.',
    features: [
      'Automated CIS Checks: Scans against AWS CIS Foundations and Azure Security Baselines.',
      '1-Click AI Auto-Fixes: Instantly remediate unencrypted databases, missing IAM roles, or public storage buckets.',
      'Enterprise Approvals: Complete audit history with SHA-256 state tracking, cost estimates, and change reviews.'
    ],
    nextHint: 'After securing your design, structure resources into dependency-ordered deployment stacks.',
    actionButtonLabel: 'Go to Architecture Review'
  },
  {
    step: 3,
    view: 'stacks',
    badge: 'Phase 3 · Dependency Orchestration',
    title: '3. Stacks & DAG: Dependency Sequencing & Clustering',
    subtitle: 'Topological dependency graphs that eliminate deployment circular locks',
    icon: GitFork,
    color: 'text-purple-500',
    lightBg: 'bg-purple-50 border-purple-200 text-purple-700',
    darkBg: 'bg-purple-950/60 border-purple-500/30 text-purple-400',
    description:
      'Real-world cloud architectures cannot be deployed in random order. CloudBuilder automatically clusters resources into an ordered Directed Acyclic Graph (DAG).',
    features: [
      'Topological Staging: Foundational layers (Network/VPC) deploy before data (RDS/S3), compute (EKS/EC2), and edge.',
      'No Circular Deadlocks: Eliminates Terraform dependency cycle errors and race conditions before provisioning starts.',
      'Modular Rollouts: Execute, test, or rollback individual stacks independently without risking your whole infrastructure.'
    ],
    nextHint: 'With sequencing locked in, generate production Terraform HCL and begin live deployment.',
    actionButtonLabel: 'Go to Stacks & DAG'
  },
  {
    step: 4,
    view: 'deploy',
    badge: 'Phase 4 · Cloud Provisioning',
    title: '4. Terraform Code & Live Cloud Deployment',
    subtitle: 'Production-ready HashiCorp HCL with strict plan guardrails',
    icon: Terminal,
    color: 'text-amber-500',
    lightBg: 'bg-amber-50 border-amber-200 text-amber-700',
    darkBg: 'bg-amber-950/60 border-amber-500/30 text-amber-400',
    description:
      'CloudBuilder transforms your visual canvas and DAG into pristine, production-grade Terraform HCL adhering to enterprise best practices.',
    features: [
      'Production Plan Guardrails: Destructive change protection, secret masking, and strict policy gates.',
      'Zero Orphan Resources: Container nodes and metadata are cleanly filtered from the emitted cloud plan.',
      'One-Click Provisioning: Plan and apply directly to your connected AWS or Azure accounts with live logs.'
    ],
    nextHint: 'After deploying live, continuously detect out-of-band console changes with drift detection.',
    actionButtonLabel: 'Go to Deployment Center'
  },
  {
    step: 5,
    view: 'drift',
    badge: 'Phase 5 · Continuous Operations',
    title: '5. Drift & Reconcile: Continuous Cloud Synchronization',
    subtitle: 'Real-time detection of console changes and bidirectional state alignment',
    icon: RefreshCw,
    color: 'text-cyan-500',
    lightBg: 'bg-cyan-50 border-cyan-200 text-cyan-700',
    darkBg: 'bg-cyan-950/60 border-cyan-500/30 text-cyan-400',
    description:
      'Cloud environments change over time. When someone modifies a security group or instance in the AWS/Azure console, CloudBuilder detects the discrepancy instantly.',
    features: [
      'Live Console Drift Detection: Spot unauthorized or accidental modifications made outside your IaC pipeline.',
      'Bidirectional Reconciliation: Reconcile live cloud modifications back to your visual canvas, or re-apply IaC to overwrite drift.',
      'Complete Continuous Lifecycle: From Design ➔ Review ➔ Stacks ➔ Deploy ➔ Reconcile and back to Design!'
    ],
    nextHint: 'The lifecycle loop is complete! You can iterate, scale, or design new architectures anytime.',
    actionButtonLabel: 'Go to Drift & Reconcile'
  }
];

export default function WorkflowOnboardingModal({
  isOpen,
  onClose,
  initialStep = 0
}: WorkflowOnboardingModalProps) {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';
  const [currentStepIndex, setCurrentStepIndex] = useState(initialStep);
  const [dontShowAgain, setDontShowAgain] = useState(true);

  if (!isOpen) return null;

  const currentStep = WORKFLOW_STEPS[currentStepIndex];
  const StepIcon = currentStep.icon;

  const handleFinish = (targetView?: AppView) => {
    if (dontShowAgain && typeof window !== 'undefined') {
      localStorage.setItem('cloudbuilder_workflow_tour_completed', 'true');
    }
    onClose();
    if (targetView) {
      dispatch({ type: 'SET_VIEW', view: targetView });
    }
  };

  const handleNext = () => {
    if (currentStepIndex < WORKFLOW_STEPS.length - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    } else {
      handleFinish('canvas');
    }
  };

  const handleBack = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  };

  const handleSkip = () => {
    handleFinish();
  };

  return (
    <div
      id="workflow-onboarding-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-modal-title"
    >
      <div
        className={clsx(
          'w-full max-w-3xl rounded-3xl border shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-in zoom-in-95 duration-200 transition-colors',
          isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-[#141416] border-white/[0.12] text-slate-100 shadow-2xl'
        )}
      >
        {/* Top Header */}
        <div
          className={clsx(
            'px-6 py-4 border-b flex items-center justify-between gap-4 shrink-0',
            isLight ? 'bg-slate-50/80 border-slate-200' : 'bg-[#18181a] border-white/[0.08]'
          )}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-md">
              <Compass className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="tour-modal-title" className={clsx('text-sm sm:text-base font-bold', isLight ? 'text-slate-900' : 'text-white')}>
                  CloudBuilder Workflow Walkthrough
                </h2>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500 border border-blue-500/20 uppercase tracking-wider">
                  5-Step Lifecycle
                </span>
              </div>
              <p className={clsx('text-xs mt-0.5 font-medium', isLight ? 'text-slate-500' : 'text-gray-400')}>
                How modern cloud infrastructure is designed, governed, sequenced, deployed, and kept in sync
              </p>
            </div>
          </div>

          <button
            onClick={handleSkip}
            className={clsx(
              'p-1.5 rounded-xl border transition-all text-xs font-semibold flex items-center gap-1.5 shrink-0',
              isLight
                ? 'bg-white hover:bg-slate-100 text-slate-500 hover:text-slate-800 border-slate-300'
                : 'bg-white/[0.05] hover:bg-white/[0.1] text-gray-400 hover:text-white border-white/[0.1]'
            )}
            title="Skip tour and close"
          >
            <span className="hidden sm:inline">Skip Tour</span>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 5-Step Visual Stepper Bar */}
        <div
          className={clsx(
            'px-6 py-3 border-b flex items-center justify-between gap-1 overflow-x-auto no-scrollbar shrink-0',
            isLight ? 'bg-slate-100/60 border-slate-200' : 'bg-black/30 border-white/[0.06]'
          )}
        >
          {WORKFLOW_STEPS.map((s, idx) => {
            const isCurrent = idx === currentStepIndex;
            const isPast = idx < currentStepIndex;
            return (
              <button
                key={s.step}
                onClick={() => setCurrentStepIndex(idx)}
                className={clsx(
                  'flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0',
                  isCurrent
                    ? isLight
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-blue-600 text-white shadow-md shadow-blue-500/25'
                    : isPast
                    ? isLight
                      ? 'bg-white text-emerald-700 border border-emerald-200'
                      : 'bg-emerald-950/40 text-emerald-300 border border-emerald-500/30'
                    : isLight
                    ? 'text-slate-500 hover:bg-white/80'
                    : 'text-gray-400 hover:bg-white/[0.05]'
                )}
              >
                <span
                  className={clsx(
                    'w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold',
                    isCurrent
                      ? 'bg-white text-blue-600'
                      : isPast
                      ? 'bg-emerald-500 text-white'
                      : isLight
                      ? 'bg-slate-200 text-slate-700'
                      : 'bg-white/[0.1] text-gray-300'
                  )}
                >
                  {isPast ? <Check className="w-3 h-3 stroke-[3]" /> : s.step}
                </span>
                <span className="whitespace-nowrap">{s.step === 1 ? 'Design' : s.step === 2 ? 'Review' : s.step === 3 ? 'Stacks' : s.step === 4 ? 'Deploy' : 'Reconcile'}</span>
              </button>
            );
          })}
        </div>

        {/* Modal Main Content Area */}
        <div className="flex-1 overflow-y-auto p-6 sm:p-8 space-y-6 custom-scrollbar">
          {/* Step Hero Section */}
          <div className="flex flex-col sm:flex-row sm:items-start gap-4">
            <div
              className={clsx(
                'w-14 h-14 rounded-2xl border flex items-center justify-center shrink-0 shadow-lg',
                isLight ? currentStep.lightBg : currentStep.darkBg
              )}
            >
              <StepIcon className="w-7 h-7" />
            </div>

            <div className="flex-1 min-w-0">
              <span
                className={clsx(
                  'inline-block text-[11px] font-bold px-2.5 py-0.5 rounded-full border mb-1.5 uppercase tracking-wide',
                  isLight ? currentStep.lightBg : currentStep.darkBg
                )}
              >
                {currentStep.badge}
              </span>
              <h3 className={clsx('text-lg sm:text-xl font-bold tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>
                {currentStep.title}
              </h3>
              <p className={clsx('text-xs sm:text-sm mt-1 font-medium', isLight ? 'text-slate-600' : 'text-gray-300')}>
                {currentStep.subtitle}
              </p>
            </div>
          </div>

          {/* Description */}
          <div
            className={clsx(
              'p-4 rounded-2xl border leading-relaxed text-xs sm:text-sm',
              isLight ? 'bg-slate-50 border-slate-200 text-slate-700' : 'bg-white/[0.03] border-white/[0.08] text-gray-300'
            )}
          >
            {currentStep.description}
          </div>

          {/* Feature Highlights */}
          <div>
            <h4 className={clsx('text-xs font-bold uppercase tracking-wider mb-3', isLight ? 'text-slate-500' : 'text-gray-400')}>
              Key Step Capabilities:
            </h4>
            <div className="grid grid-cols-1 gap-2.5">
              {currentStep.features.map((feature, i) => (
                <div
                  key={i}
                  className={clsx(
                    'p-3 rounded-xl border flex items-start gap-3 transition-colors',
                    isLight ? 'bg-white border-slate-200' : 'bg-[#18181a] border-white/[0.06]'
                  )}
                >
                  <div className="w-5 h-5 rounded-md bg-blue-500/10 text-blue-500 border border-blue-500/20 flex items-center justify-center shrink-0 mt-0.5">
                    <Check className="w-3 h-3 stroke-[2.5]" />
                  </div>
                  <span className={clsx('text-xs leading-relaxed font-medium', isLight ? 'text-slate-700' : 'text-slate-300')}>
                    {feature}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Contextual Next Step Hint Box */}
          <div
            className={clsx(
              'p-4 rounded-2xl border flex items-center justify-between gap-3',
              isLight
                ? 'bg-gradient-to-r from-blue-50/80 to-indigo-50/80 border-blue-200'
                : 'bg-gradient-to-r from-blue-950/30 to-indigo-950/30 border-blue-500/20'
            )}
          >
            <div className="flex items-center gap-2.5">
              <Sparkles className="w-4 h-4 text-blue-500 shrink-0" />
              <div>
                <p className={clsx('text-xs font-bold', isLight ? 'text-blue-900' : 'text-blue-300')}>
                  What happens next?
                </p>
                <p className={clsx('text-[11px] mt-0.5', isLight ? 'text-slate-600' : 'text-gray-400')}>
                  {currentStep.nextHint}
                </p>
              </div>
            </div>

            <button
              onClick={() => handleFinish(currentStep.view)}
              className={clsx(
                'shrink-0 hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all',
                isLight
                  ? 'bg-white hover:bg-slate-50 text-blue-700 border-blue-300 shadow-xs'
                  : 'bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border-blue-500/30'
              )}
              title={`Open ${currentStep.title} directly`}
            >
              <span>{currentStep.actionButtonLabel}</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Bottom Actions Footer */}
        <div
          className={clsx(
            'px-6 py-4 border-t flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0',
            isLight ? 'bg-slate-50/80 border-slate-200' : 'bg-[#18181a] border-white/[0.08]'
          )}
        >
          {/* Don't show again toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className={clsx('text-xs font-medium', isLight ? 'text-slate-600' : 'text-gray-400')}>
              Don't show this intro automatically again
            </span>
          </label>

          {/* Stepper Buttons */}
          <div className="flex items-center gap-2.5">
            {currentStepIndex > 0 && (
              <button
                onClick={handleBack}
                className={clsx(
                  'flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold border transition-all',
                  isLight
                    ? 'bg-white hover:bg-slate-100 text-slate-700 border-slate-300 shadow-xs'
                    : 'bg-white/[0.05] hover:bg-white/[0.1] text-slate-300 border-white/[0.1]'
                )}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            )}

            <button
              id="btn-tour-next-step"
              onClick={handleNext}
              className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold shadow-md shadow-blue-600/25 transition-all transform active:scale-98"
            >
              <span>
                {currentStepIndex === WORKFLOW_STEPS.length - 1
                  ? '🚀 Get Started with Canvas'
                  : `Next: Step ${currentStepIndex + 2} →`}
              </span>
              {currentStepIndex < WORKFLOW_STEPS.length - 1 && <ArrowRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

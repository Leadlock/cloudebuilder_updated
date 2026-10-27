'use client';
import React, { useState } from 'react';
import { useApp } from '@/context/AppContext';
import {
  Boxes, ShieldCheck, GitFork, Terminal, RefreshCw,
  ArrowRight, Check, Compass, ChevronDown, ChevronUp, Sparkles
} from 'lucide-react';
import clsx from 'clsx';
import { AppView } from '@/types';

interface WorkflowStepConfig {
  step: number;
  id: string;
  name: string;
  shortName: string;
  view: AppView;
  nextView: AppView;
  nextStepName: string;
  hint: string;
  icon: React.ElementType;
  color: string;
}

const LIFECYCLE_STEPS: Record<string, WorkflowStepConfig> = {
  canvas: {
    step: 1,
    id: 'canvas',
    name: 'Visual Builder',
    shortName: '1. Design',
    view: 'canvas',
    nextView: 'review',
    nextStepName: 'Architecture Review',
    hint: 'Architecture ready? Next step: Run security audit, policy gates & cost estimation.',
    icon: Boxes,
    color: 'text-blue-500'
  },
  review: {
    step: 2,
    id: 'review',
    name: 'Architecture Review',
    shortName: '2. Review',
    view: 'review',
    nextView: 'stacks',
    nextStepName: 'Stacks & DAG',
    hint: 'Review validated? Next step: Cluster resources into dependency-ordered deployment stacks.',
    icon: ShieldCheck,
    color: 'text-emerald-500'
  },
  stacks: {
    step: 3,
    id: 'stacks',
    name: 'Stacks & DAG Orchestration',
    shortName: '3. Stacks',
    view: 'stacks',
    nextView: 'deploy',
    nextStepName: 'Terraform & Deploy',
    hint: 'Dependencies mapped? Next step: Inspect production Terraform code and launch deployment.',
    icon: GitFork,
    color: 'text-purple-500'
  },
  terraform: {
    step: 4,
    id: 'terraform',
    name: 'Terraform & Deployment',
    shortName: '4. Deploy',
    view: 'terraform',
    nextView: 'drift',
    nextStepName: 'Drift & Reconcile',
    hint: 'Code generated? Next step: Deploy to cloud, then monitor live drift & state sync.',
    icon: Terminal,
    color: 'text-amber-500'
  },
  deploy: {
    step: 4,
    id: 'deploy',
    name: 'Terraform & Deployment',
    shortName: '4. Deploy',
    view: 'deploy',
    nextView: 'drift',
    nextStepName: 'Drift & Reconcile',
    hint: 'Infrastructure provisioned? Next step: Continuously track live cloud reality and detect drift.',
    icon: Terminal,
    color: 'text-amber-500'
  },
  drift: {
    step: 5,
    id: 'drift',
    name: 'Drift & Reconcile',
    shortName: '5. Reconcile',
    view: 'drift',
    nextView: 'canvas',
    nextStepName: 'Visual Builder (Canvas)',
    hint: 'State in sync! Lifecycle complete. Return to Visual Builder to iterate or scale new resources.',
    icon: RefreshCw,
    color: 'text-cyan-500'
  }
};

const STEP_LIST = [
  { step: 1, name: 'Design', view: 'canvas' as AppView, icon: Boxes },
  { step: 2, name: 'Review', view: 'review' as AppView, icon: ShieldCheck },
  { step: 3, name: 'Stacks (DAG)', view: 'stacks' as AppView, icon: GitFork },
  { step: 4, name: 'Deploy', view: 'deploy' as AppView, icon: Terminal },
  { step: 5, name: 'Reconcile', view: 'drift' as AppView, icon: RefreshCw },
];

export default function WorkflowStepNavigator() {
  const { state, dispatch } = useApp();
  const { activeView, theme } = state;
  const isLight = theme === 'light';
  const [collapsed, setCollapsed] = useState(false);

  const currentConfig = LIFECYCLE_STEPS[activeView];

  // If we are on non-lifecycle views like team, policy, etc., keep it slim or hidden
  if (!currentConfig) {
    return null;
  }

  const StepIcon = currentConfig.icon;

  const handleNextStep = () => {
    dispatch({ type: 'SET_VIEW', view: currentConfig.nextView });
  };

  const handleOpenTour = () => {
    dispatch({ type: 'SET_TOUR_MODAL', open: true });
  };

  return (
    <aside
      id="workflow-step-navigator"
      aria-label="Workflow Step Navigation"
      className={clsx(
        'w-full border-b transition-all duration-200 select-none z-30 shrink-0',
        isLight
          ? 'bg-gradient-to-r from-blue-50/70 via-indigo-50/50 to-slate-50 border-slate-200 text-slate-800'
          : 'bg-gradient-to-r from-slate-900/90 via-slate-900/80 to-[#141416] border-white/[0.08] text-slate-200 backdrop-blur-md'
      )}
    >
      {collapsed ? (
        // Collapsed Slim Bar
        <div className="px-3 sm:px-4 py-1 flex items-center justify-between text-xs gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span className="font-bold text-[11px] uppercase tracking-wider text-blue-500">
              Step {currentConfig.step} of 5:
            </span>
            <span className={clsx('font-semibold text-xs', isLight ? 'text-slate-800' : 'text-slate-200')}>
              {currentConfig.name}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleNextStep}
              className="flex items-center gap-1 px-2.5 py-0.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold shadow-xs transition-all"
            >
              <span>Next: {currentConfig.nextStepName}</span>
              <ArrowRight className="w-3 h-3" />
            </button>
            <button
              onClick={() => setCollapsed(false)}
              className={clsx(
                'p-1 rounded-md text-xs font-semibold hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
                isLight ? 'text-slate-500' : 'text-gray-400'
              )}
              title="Expand step guidance"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ) : (
        // Expanded Full Guidance Bar
        <div className="px-3 sm:px-4 py-2 sm:py-2.5 flex flex-col md:flex-row md:items-center justify-between gap-2.5 sm:gap-3">
          {/* Left: 5-Step Lifecycle Stepper */}
          <div className="flex items-center gap-1 sm:gap-1.5 overflow-x-auto no-scrollbar shrink-0">
            {STEP_LIST.map((stepItem) => {
              const isActive = stepItem.step === currentConfig.step;
              const isPast = stepItem.step < currentConfig.step;
              const StepItemIcon = stepItem.icon;

              return (
                <button
                  key={stepItem.step}
                  onClick={() => dispatch({ type: 'SET_VIEW', view: stepItem.view })}
                  className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all shrink-0',
                    isActive
                      ? isLight
                        ? 'bg-white text-blue-700 shadow-sm border border-blue-300 font-bold'
                        : 'bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-xs font-bold'
                      : isPast
                      ? isLight
                        ? 'text-emerald-700 hover:bg-emerald-100/60'
                        : 'text-emerald-400 hover:bg-emerald-950/30'
                      : isLight
                      ? 'text-slate-500 hover:bg-slate-200/60'
                      : 'text-gray-400 hover:bg-white/[0.05]'
                  )}
                  title={`Jump to Step ${stepItem.step}: ${stepItem.name}`}
                >
                  <span
                    className={clsx(
                      'w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
                      isActive
                        ? 'bg-blue-600 text-white'
                        : isPast
                        ? 'bg-emerald-500 text-white'
                        : isLight
                        ? 'bg-slate-200 text-slate-700'
                        : 'bg-white/[0.1] text-gray-400'
                    )}
                  >
                    {isPast ? <Check className="w-2.5 h-2.5 stroke-[3]" /> : stepItem.step}
                  </span>
                  <StepItemIcon className="w-3.5 h-3.5 shrink-0 hidden sm:inline" />
                  <span className="whitespace-nowrap">{stepItem.name}</span>
                </button>
              );
            })}
          </div>

          {/* Middle: Step Hint / Next guidance */}
          <div className="flex-1 min-w-0 flex items-center gap-2 px-1">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0 hidden lg:inline" />
            <p className={clsx('text-xs font-medium truncate', isLight ? 'text-slate-600' : 'text-gray-300')}>
              <strong className={clsx('font-bold mr-1', isLight ? 'text-slate-900' : 'text-white')}>
                Step {currentConfig.step} of 5:
              </strong>
              {currentConfig.hint}
            </p>
          </div>

          {/* Right: "Go to Next Step" Button + Quick Tour Button */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleOpenTour}
              className={clsx(
                'hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition-all shrink-0',
                isLight
                  ? 'bg-white hover:bg-slate-100 text-slate-700 border-slate-300 shadow-2xs'
                  : 'bg-white/[0.05] hover:bg-white/[0.1] text-gray-300 border-white/[0.1]'
              )}
              title="Open full interactive workflow walkthrough"
            >
              <Compass className="w-3.5 h-3.5 text-blue-500" />
              <span>Tour</span>
            </button>

            <button
              id="btn-go-to-next-step"
              onClick={handleNextStep}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-bold shadow-sm transition-all transform active:scale-98 shrink-0 animate-in fade-in"
              title={`Proceed to logical next phase: ${currentConfig.nextStepName}`}
            >
              <span>{currentConfig.step === 5 ? '↺ Return to Builder' : `Next: ${currentConfig.nextStepName}`}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => setCollapsed(true)}
              className={clsx(
                'p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors shrink-0',
                isLight ? 'text-slate-400 hover:text-slate-700' : 'text-gray-400 hover:text-white'
              )}
              title="Collapse step guidance"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

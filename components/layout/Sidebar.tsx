'use client';
import { useApp, useActiveProject } from '@/context/AppContext';
import {
  LayoutDashboard, Box, Code2, ShieldCheck, DollarSign, Rocket,
  ChevronLeft, ChevronRight, Cloud, Plus, Trash2, Wand2, LayoutGrid,
  Sparkles, Brain, History, GitBranch, Shield, Upload, CheckSquare, FileCheck,
  Activity, Scale
} from 'lucide-react';
import clsx from 'clsx';
import { AppView } from '@/types';

const NAV_GROUPS = [
  {
    label: 'General',
    items: [
      { id: 'dashboard',  label: 'Dashboard',        icon: LayoutDashboard, requiresProject: false },
    ],
  },
  {
    label: 'Build',
    items: [
      { id: 'canvas',     label: 'Visual Builder',    icon: Box,             requiresProject: true },
      { id: 'wizard',     label: 'Arch. Wizard',      icon: Wand2,           requiresProject: false },
      { id: 'templates',  label: 'Templates',         icon: LayoutGrid,      requiresProject: false },
      { id: 'ai-generator',label: 'AI Generator',    icon: Sparkles,        requiresProject: false },
      { id: 'import',     label: 'Import',            icon: Upload,          requiresProject: false },
    ],
  },
  {
    label: 'Analyze',
    items: [
      { id: 'analyze',    label: 'Overview',          icon: Activity,        requiresProject: true },
      { id: 'well-architected', label: 'Well-Architected', icon: CheckSquare, requiresProject: true },
      { id: 'security',   label: 'Security',          icon: ShieldCheck,     requiresProject: true },
      { id: 'cost',       label: 'Cost Estimate',     icon: DollarSign,      requiresProject: true },
      { id: 'cost-comparison', label: 'Cost Comparison', icon: Scale,        requiresProject: true },
      { id: 'advisor',    label: 'Advisor',           icon: Brain,           requiresProject: true },
    ],
  },
  {
    label: 'Deliver',
    items: [
      { id: 'review',     label: 'Review Workflow',  icon: FileCheck,       requiresProject: true },
      { id: 'terraform',  label: 'Terraform',         icon: Code2,           requiresProject: true },
      { id: 'deploy',     label: 'Deploy',            icon: Rocket,          requiresProject: true },
      { id: 'disaster-recovery', label: 'DR Designer', icon: Shield,         requiresProject: false },
    ],
  },
  {
    label: 'Manage',
    items: [
      { id: 'environments', label: 'Environments',   icon: GitBranch,       requiresProject: true },
      { id: 'history',    label: 'History',           icon: History,         requiresProject: true },
    ],
  },
] as const;

export default function Sidebar() {
  const { state, dispatch } = useApp();
  const { activeView, sidebarCollapsed, projects, activeProjectId } = state;

  return (
    <aside className={clsx(
      'flex flex-col bg-gray-950 border-r border-gray-800 transition-all duration-200 shrink-0',
      sidebarCollapsed ? 'w-14' : 'w-56'
    )}>
      {/* Logo */}
      <div className="flex items-center gap-3 px-3 py-4 border-b border-gray-800">
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
          <Cloud className="w-4 h-4 text-white" />
        </div>
        {!sidebarCollapsed && (
          <div>
            <span className="text-white font-bold text-base leading-none">CloudCraft</span>
            <p className="text-gray-500 text-[10px] mt-0.5">Infrastructure Platform</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 overflow-y-auto px-1.5 space-y-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {!sidebarCollapsed && (
              <p className="text-gray-600 text-[10px] uppercase tracking-widest font-medium px-2 mb-1">{group.label}</p>
            )}
            <div className="space-y-0.5">
              {group.items.map(({ id, label, icon: Icon, requiresProject }) => {
                const active = activeView === id;
                const disabled = requiresProject && !activeProjectId;
                return (
                  <button
                    key={id}
                    disabled={disabled}
                    onClick={() => dispatch({ type: 'SET_VIEW', view: id as AppView })}
                    title={disabled ? 'Select a project first' : sidebarCollapsed ? label : undefined}
                    aria-label={disabled ? `${label} — Select a project first` : label}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500',
                      active ? 'bg-blue-600 text-white' :
                      disabled ? 'text-gray-700 cursor-not-allowed' :
                      'text-gray-400 hover:text-white hover:bg-gray-800'
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    {!sidebarCollapsed && <span className="truncate text-xs">{label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Project list */}
      {!sidebarCollapsed && (
        <div className="border-t border-gray-800 p-2">
          <div className="flex items-center justify-between mb-1.5 px-1">
            <span className="text-gray-600 text-[10px] uppercase tracking-wider font-medium">Projects</span>
            <button onClick={() => dispatch({ type: 'SET_VIEW', view: 'dashboard' })} className="text-gray-600 hover:text-blue-400 transition-colors" title="New project">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-0.5 max-h-36 overflow-y-auto">
            {projects.map((p) => (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => { dispatch({ type: 'SET_ACTIVE_PROJECT', id: p.id }); dispatch({ type: 'SET_VIEW', view: 'canvas' }); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    dispatch({ type: 'SET_ACTIVE_PROJECT', id: p.id });
                    dispatch({ type: 'SET_VIEW', view: 'canvas' });
                  }
                }}
                className={clsx(
                  'w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 group transition-colors cursor-pointer select-none',
                  p.id === activeProjectId ? 'bg-blue-900/40 text-blue-300' : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800'
                )}
              >
                <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', p.provider === 'aws' ? 'bg-orange-400' : p.provider === 'azure' ? 'bg-blue-400' : 'bg-purple-400')} />
                <span className="truncate flex-1">{p.name}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); dispatch({ type: 'DELETE_PROJECT', id: p.id }); }}
                  className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all p-0.5 rounded"
                  title="Delete project"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Collapse toggle */}
      <button
        onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
        className="flex items-center justify-center py-3 border-t border-gray-800 text-gray-600 hover:text-gray-300 transition-colors"
      >
        {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>
    </aside>
  );
}

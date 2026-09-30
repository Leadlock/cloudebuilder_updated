'use client';
import { useApp } from '@/context/AppContext';
import {
  LayoutDashboard, Box, Code2, ShieldCheck, DollarSign, Rocket,
  ChevronLeft, ChevronRight, Cloud, Plus, Trash2, Wand2, LayoutGrid,
  Sparkles, Brain, History, GitBranch, Shield, Upload, CheckSquare, FileCheck,
  Activity, Scale, Users, X
} from 'lucide-react';
import clsx from 'clsx';
import { AppView, Project } from '@/types';
import DeleteProjectModal from '@/components/modals/DeleteProjectModal';
import { useState } from 'react';

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
      { id: 'canvas',     label: 'Visual Builder',    icon: Box,             requiresProject: false },
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
      { id: 'team',       label: 'Team',              icon: Users,           requiresProject: false, adminOnly: true },
    ],
  },
] as const;

export default function Sidebar() {
  const { state, dispatch } = useApp();
  const { activeView, sidebarCollapsed, mobileSidebarOpen, projects, activeProjectId, currentUser } = state;
  const isAdmin = currentUser?.role === 'admin' || (!currentUser && process.env.NODE_ENV === 'development');
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const handleNavClick = (id: AppView) => {
    dispatch({ type: 'SET_VIEW', view: id });
    if (mobileSidebarOpen) {
      dispatch({ type: 'SET_MOBILE_SIDEBAR', open: false });
    }
  };

  const handleProjectClick = (projectId: string) => {
    dispatch({ type: 'SET_ACTIVE_PROJECT', id: projectId });
    dispatch({ type: 'SET_VIEW', view: 'canvas' });
    if (mobileSidebarOpen) {
      dispatch({ type: 'SET_MOBILE_SIDEBAR', open: false });
    }
  };

  const navContent = (isMobile = false) => (
    <>
      {/* Header / Logo */}
      <div className="flex items-center justify-between px-3 py-4 border-b border-gray-800 bg-gray-950">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-lg flex items-center justify-center shrink-0 shadow-md shadow-blue-500/20">
            <Cloud className="w-4 h-4 text-white" />
          </div>
          {(!sidebarCollapsed || isMobile) && (
            <div>
              <span className="text-white font-bold text-base leading-none">CloudCraft</span>
              <p className="text-gray-500 text-[10px] mt-0.5">Infrastructure Platform</p>
            </div>
          )}
        </div>
        {isMobile && (
          <button
            onClick={() => dispatch({ type: 'SET_MOBILE_SIDEBAR', open: false })}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            title="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Nav groups */}
      <nav className="flex-1 py-3 overflow-y-auto px-2 space-y-4 custom-scrollbar">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {(!sidebarCollapsed || isMobile) && (
              <p className="text-gray-600 text-[10px] uppercase tracking-widest font-semibold px-2 mb-1.5">{group.label}</p>
            )}
            <div className="space-y-0.5">
              {group.items.filter((item) => !('adminOnly' in item && item.adminOnly) || isAdmin).map(({ id, label, icon: Icon, requiresProject }) => {
                const active = activeView === id;
                const hasArchitecture = !!activeProjectId || (state.draftProject && state.draftProject.nodes.length > 0) || activeView === 'canvas';
                const disabled = requiresProject && !hasArchitecture;
                return (
                  <button
                    key={id}
                    disabled={disabled}
                    onClick={() => handleNavClick(id as AppView)}
                    title={disabled ? 'Select a project first' : sidebarCollapsed && !isMobile ? label : undefined}
                    aria-label={disabled ? `${label} — Select a project first` : label}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500',
                      active ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-600/20' :
                      disabled ? 'text-gray-700 cursor-not-allowed' :
                      'text-gray-400 hover:text-white hover:bg-gray-800/80'
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    {(!sidebarCollapsed || isMobile) && <span className="truncate text-xs">{label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Project list */}
      {(!sidebarCollapsed || isMobile) && (
        <div className="border-t border-gray-800 p-2.5 bg-gray-950">
          <div className="flex items-center justify-between mb-1.5 px-1">
            <span className="text-gray-600 text-[10px] uppercase tracking-wider font-semibold">Projects</span>
            <button
              onClick={() => {
                dispatch({ type: 'SET_VIEW', view: 'dashboard' });
                if (isMobile) dispatch({ type: 'SET_MOBILE_SIDEBAR', open: false });
              }}
              className="text-gray-500 hover:text-blue-400 transition-colors p-0.5 rounded"
              title="New project"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-0.5 max-h-36 overflow-y-auto custom-scrollbar">
            {projects.map((p) => (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => handleProjectClick(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    handleProjectClick(p.id);
                  }
                }}
                className={clsx(
                  'w-full text-left px-2 py-1.5 rounded-lg text-xs flex items-center gap-2 group transition-colors cursor-pointer select-none',
                  p.id === activeProjectId ? 'bg-blue-900/40 text-blue-300 font-medium border border-blue-800/40' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/70'
                )}
              >
                <span className={clsx('w-2 h-2 rounded-full shrink-0', p.provider === 'aws' ? 'bg-orange-400' : p.provider === 'azure' ? 'bg-blue-400' : 'bg-purple-400')} />
                <span className="truncate flex-1">{p.name}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setProjectToDelete(p);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-all p-0.5 rounded cursor-pointer"
                  title={isAdmin ? "Delete project" : "Only administrators can delete projects"}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Collapse toggle (Desktop only) */}
      {!isMobile && (
        <button
          onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          className="flex items-center justify-center py-3 border-t border-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-900/50 transition-colors"
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      )}
    </>
  );

  return (
    <>
      {/* Desktop In-flow Sidebar */}
      <aside className={clsx(
        'hidden lg:flex flex-col bg-gray-950 border-r border-gray-800 transition-all duration-200 shrink-0 h-screen select-none',
        sidebarCollapsed ? 'w-14' : 'w-56'
      )}>
        {navContent(false)}
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileSidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-sm transition-opacity animate-in fade-in duration-150"
            onClick={() => dispatch({ type: 'SET_MOBILE_SIDEBAR', open: false })}
          />
          {/* Slide-over Drawer */}
          <div className="relative w-64 max-w-[80vw] bg-gray-950 border-r border-gray-800 h-full flex flex-col shadow-2xl z-10 animate-in slide-in-from-left duration-200">
            {navContent(true)}
          </div>
        </div>
      )}

      {/* Confirmation Modal for Project Deletion */}
      <DeleteProjectModal
        isOpen={Boolean(projectToDelete)}
        project={projectToDelete}
        isAdmin={Boolean(isAdmin)}
        onClose={() => setProjectToDelete(null)}
        onConfirm={async (id) => {
          dispatch({ type: 'DELETE_PROJECT', id });
        }}
      />
    </>
  );
}

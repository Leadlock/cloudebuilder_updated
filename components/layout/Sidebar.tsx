'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '@/context/AppContext';
import {
  LayoutDashboard, Box, Code2, ShieldCheck, DollarSign, Rocket,
  ChevronLeft, ChevronRight, Cloud, Plus, Trash2, Wand2, LayoutGrid,
  Sparkles, Brain, History, GitBranch, Shield, Upload, CheckSquare, FileCheck,
  Activity, Scale, Users, X, GripVertical
} from 'lucide-react';
import clsx from 'clsx';
import { AppView, Project } from '@/types';
import DeleteProjectModal from '@/components/modals/DeleteProjectModal';

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
  const isAdmin = currentUser?.role === 'admin';

  // Resizable sidebar state
  const [sidebarWidth, setSidebarWidth] = useState<number>(240);
  const [isResizing, setIsResizing] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const widthRef = useRef(sidebarWidth);
  widthRef.current = sidebarWidth;

  // Load persisted width on mount
  useEffect(() => {
    try {
      const savedWidth = localStorage.getItem('cloudcraft_sidebar_width');
      if (savedWidth) {
        const num = parseInt(savedWidth, 10);
        if (num >= 180 && num <= 480) {
          setSidebarWidth(num);
        }
      }
    } catch {}
  }, []);

  // Resizing drag listeners
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(180, Math.min(480, e.clientX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      try {
        localStorage.setItem('cloudcraft_sidebar_width', widthRef.current.toString());
      } catch {}
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

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

  const confirmDeleteProject = (id: string) => {
    dispatch({ type: 'DELETE_PROJECT', id });
    setProjectToDelete(null);
  };

  const navContent = (isMobile = false) => (
    <>
      {/* Header / Logo */}
      <div className="flex items-center justify-between px-3 py-4 border-b border-gray-800 bg-gray-950 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-lg flex items-center justify-center shrink-0 shadow-md shadow-blue-500/20">
            <Cloud className="w-4 h-4 text-white" />
          </div>
          {(!sidebarCollapsed || isMobile) && (
            <div className="min-w-0">
              <span className="text-white font-bold text-base leading-none block truncate">CloudCraft</span>
              <p className="text-gray-500 text-[10px] mt-0.5 truncate">Infrastructure Platform</p>
            </div>
          )}
        </div>
        {isMobile ? (
          <button
            onClick={() => dispatch({ type: 'SET_MOBILE_SIDEBAR', open: false })}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            title="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        ) : (
          !sidebarCollapsed && (
            <button
              onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
              className="p-1 text-gray-500 hover:text-white rounded hover:bg-gray-800/80 transition-colors"
              title="Collapse sidebar"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )
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
                      'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 text-left',
                      active ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-600/20' :
                      disabled ? 'text-gray-700 cursor-not-allowed' :
                      'text-gray-400 hover:text-white hover:bg-gray-800/80'
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    {(!sidebarCollapsed || isMobile) && <span className="truncate text-xs flex-1">{label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Project list at bottom-left */}
      {(!sidebarCollapsed || isMobile) && (
        <div className="border-t border-gray-800 p-2.5 bg-gray-950/90 shrink-0">
          <div className="flex items-center justify-between mb-1.5 px-1">
            <span className="text-gray-500 text-[10px] uppercase tracking-wider font-semibold">
              Projects ({projects.length})
            </span>
            <button
              onClick={() => {
                dispatch({ type: 'SET_VIEW', view: 'dashboard' });
                if (isMobile) dispatch({ type: 'SET_MOBILE_SIDEBAR', open: false });
              }}
              className="text-gray-400 hover:text-blue-400 transition-colors p-1 rounded hover:bg-gray-800"
              title="Create new project"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto custom-scrollbar pr-0.5">
            {projects.length === 0 ? (
              <p className="text-gray-600 text-[11px] px-2 py-1.5 italic">No projects yet</p>
            ) : (
              projects.map((p) => {
                const isActive = p.id === activeProjectId;
                return (
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
                    title={`${p.name} (${p.provider.toUpperCase()})`}
                    className={clsx(
                      'w-full text-left px-2.5 py-2 rounded-lg text-xs flex items-center gap-2 group transition-all cursor-pointer select-none border',
                      isActive
                        ? 'bg-blue-950/50 text-blue-200 font-semibold border-blue-700/60 shadow-sm'
                        : 'text-gray-300 hover:text-white hover:bg-gray-800/80 border-transparent'
                    )}
                  >
                    <span
                      className={clsx(
                        'w-2 h-2 rounded-full shrink-0 shadow-sm',
                        p.provider === 'aws' ? 'bg-orange-400 ring-2 ring-orange-500/20' :
                        p.provider === 'azure' ? 'bg-blue-400 ring-2 ring-blue-500/20' :
                        'bg-purple-400 ring-2 ring-purple-500/20'
                      )}
                    />
                    <span className="truncate flex-1 font-medium">{p.name}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setProjectToDelete(p);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-all p-1 rounded hover:bg-red-500/10"
                      title="Delete project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Collapse toggle (Desktop only when collapsed) */}
      {!isMobile && sidebarCollapsed && (
        <button
          onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          className="flex items-center justify-center py-3 border-t border-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-900/50 transition-colors shrink-0"
          title="Expand sidebar"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </>
  );

  return (
    <>
      {/* Desktop In-flow Sidebar */}
      <aside
        style={{
          width: sidebarCollapsed ? '56px' : `${sidebarWidth}px`,
        }}
        className={clsx(
          'hidden lg:flex flex-col bg-gray-950 border-r border-gray-800 shrink-0 h-screen select-none relative group/sidebar',
          !isResizing && 'transition-[width] duration-200 ease-out'
        )}
      >
        {navContent(false)}

        {/* Resizable Drag Handle on Right Border */}
        {!sidebarCollapsed && (
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizing(true);
            }}
            className={clsx(
              'absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-blue-500/50 transition-colors z-20 flex items-center justify-center',
              isResizing ? 'bg-blue-500 shadow-md' : 'bg-transparent'
            )}
            title="Drag to resize sidebar width"
          >
            <div className="opacity-0 group-hover/sidebar:opacity-100 transition-opacity">
              <GripVertical className="w-3 h-3 text-gray-500 -ml-1" />
            </div>
          </div>
        )}
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
          <div className="relative w-72 max-w-[85vw] bg-gray-950 border-r border-gray-800 h-full flex flex-col shadow-2xl z-10 animate-in slide-in-from-left duration-200">
            {navContent(true)}
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {projectToDelete && (
        <DeleteProjectModal
          isOpen={true}
          projectId={projectToDelete.id}
          projectName={projectToDelete.name}
          onConfirm={confirmDeleteProject}
          onCancel={() => setProjectToDelete(null)}
        />
      )}
    </>
  );
}

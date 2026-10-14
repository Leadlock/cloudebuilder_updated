'use client';

import { RESTRICTED_VIEWS } from '@/lib/auth/restrictedFeatures';
import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '@/context/AppContext';
import {
  LayoutDashboard, Box, Code2, ShieldCheck, DollarSign, Rocket,
  ChevronLeft, ChevronRight, Cloud, Plus, Trash2, Wand2, LayoutGrid,
  Sparkles, Brain, History, GitBranch, Shield, Upload, CheckSquare, FileCheck,
  Activity, Scale, Users, Package, X, GripVertical, Link2, LogOut, User, ClipboardList
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
      { id: 'container-templates', label: 'Container Templates', icon: Package, requiresProject: false },
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
      { id: 'accounts',   label: 'Cloud Accounts',    icon: Link2,           requiresProject: false },
      { id: 'environments', label: 'Environments',   icon: GitBranch,       requiresProject: true },
      { id: 'history',    label: 'History',           icon: History,         requiresProject: true },
      { id: 'policy',     label: 'Policy',            icon: ClipboardList,   requiresProject: false },
      { id: 'team',       label: 'Team',              icon: Users,           requiresProject: false, adminOnly: true },
      { id: 'operator-access', label: 'Deploy access', icon: ShieldCheck,     requiresProject: false, operatorOnly: true },
    ],
  },
] as const;

export default function Sidebar() {
  const { state, dispatch } = useApp();
  const { activeView, sidebarCollapsed, mobileSidebarOpen, projects, activeProjectId, currentUser, theme } = state;
  const isLight = theme === 'light';
  const isAdmin = currentUser?.role === 'admin';
  // The server decides; this only keeps closed tabs out of sight. A user object without the field (an older saved one) is treated as allowed.
  const canUseRestricted = currentUser?.restrictedFeatures !== false;

  // Resizable sidebar state
  const [sidebarWidth, setSidebarWidth] = useState<number>(240);
  const [isResizing, setIsResizing] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const widthRef = useRef(sidebarWidth);
  useEffect(() => { widthRef.current = sidebarWidth; }, [sidebarWidth]);

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

  const handleLogout = async () => {
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('cloudcraft_demo_user');
      }
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      dispatch({ type: 'SET_USER', user: null });
      dispatch({ type: 'SET_LOGIN_MODAL', open: true });
    } catch (e) {
      console.error('Logout failed:', e);
    }
  };

  const navContent = (isMobile = false) => (
    <>
      {/* Header / Logo */}
      <div className={clsx(
        "flex items-center justify-between px-3 py-4 border-b shrink-0 transition-colors",
        isLight ? "border-slate-200 bg-white" : "border-gray-800 bg-gray-950"
      )}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-lg flex items-center justify-center shrink-0 shadow-md shadow-blue-500/20">
            <Cloud className="w-4 h-4 text-white" />
          </div>
          {(!sidebarCollapsed || isMobile) && (
            <div className="min-w-0">
              <span className={clsx("font-bold text-base leading-none block truncate", isLight ? "text-slate-900" : "text-white")}>CloudCraft</span>
              <p className={clsx("text-[10px] mt-0.5 truncate font-medium", isLight ? "text-slate-500" : "text-gray-500")}>Infrastructure Platform</p>
            </div>
          )}
        </div>
        {isMobile ? (
          <button
            onClick={() => dispatch({ type: 'SET_MOBILE_SIDEBAR', open: false })}
            className={clsx(
              "p-1.5 rounded-lg transition-colors",
              isLight ? "text-slate-500 hover:text-slate-900 hover:bg-slate-100" : "text-gray-400 hover:text-white hover:bg-gray-800"
            )}
            title="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        ) : (
          !sidebarCollapsed && (
            <button
              onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
              className={clsx(
                "p-1 rounded transition-colors",
                isLight ? "text-slate-400 hover:text-slate-800 hover:bg-slate-100" : "text-gray-500 hover:text-white hover:bg-gray-800/80"
              )}
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
              <p className={clsx("text-[10px] uppercase tracking-widest font-bold px-2.5 mb-1.5", isLight ? "text-slate-400" : "text-gray-500")}>{group.label}</p>
            )}
            <div className="space-y-1">
              {group.items.filter((item) => (!('adminOnly' in item && item.adminOnly) || isAdmin) && (!('operatorOnly' in item && item.operatorOnly) || currentUser?.operator === true) && (canUseRestricted || !RESTRICTED_VIEWS.has(item.id))).map(({ id, label, icon: Icon, requiresProject }) => {
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
                      'w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-xs font-semibold transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/50 text-left',
                      active
                        ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-600/25 ring-1 ring-blue-400/30 font-bold'
                        : disabled
                        ? isLight ? 'text-slate-300 cursor-not-allowed opacity-50' : 'text-gray-700 cursor-not-allowed opacity-40'
                        : isLight
                        ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 active:scale-[0.98]'
                        : 'text-gray-400 hover:text-white hover:bg-gray-900/90 active:scale-[0.98]'
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    {(!sidebarCollapsed || isMobile) && <span className="truncate flex-1">{label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Project list at bottom-left */}
      {(!sidebarCollapsed || isMobile) && (
        <div className={clsx(
          "border-t p-3 shrink-0 transition-colors",
          isLight ? "border-slate-200 bg-slate-50/80" : "border-gray-800/80 bg-gray-950/95"
        )}>
          <div className="flex items-center justify-between mb-2 px-1">
            <span className={clsx("text-[10px] uppercase tracking-wider font-bold", isLight ? "text-slate-500" : "text-gray-400")}>
              Projects ({projects.length})
            </span>
            <button
              onClick={() => {
                dispatch({ type: 'SET_VIEW', view: 'dashboard' });
                if (isMobile) dispatch({ type: 'SET_MOBILE_SIDEBAR', open: false });
              }}
              className={clsx(
                "transition-all p-1 rounded-lg",
                isLight ? "text-slate-500 hover:text-blue-600 hover:bg-slate-200/80" : "text-gray-400 hover:text-blue-400 hover:bg-gray-800/80"
              )}
              title="Create new project"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar pr-0.5">
            {projects.length === 0 ? (
              <p className={clsx("text-[11px] px-2 py-1.5 italic", isLight ? "text-slate-400" : "text-gray-600")}>No projects yet</p>
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
                      'w-full text-left px-2.5 py-2 rounded-xl text-xs flex items-center gap-2.5 group transition-all cursor-pointer select-none border',
                      isActive
                        ? isLight
                          ? 'bg-blue-50 text-blue-900 font-bold border-blue-300 shadow-xs'
                          : 'bg-blue-950/60 text-blue-200 font-semibold border-blue-600/50 shadow-md shadow-blue-950/50'
                        : isLight
                        ? 'text-slate-700 hover:text-slate-900 hover:bg-white border-slate-200/90 shadow-2xs'
                        : 'text-gray-300 hover:text-white hover:bg-gray-900/80 border-gray-800/50'
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
                      className={clsx(
                        "opacity-0 group-hover:opacity-100 transition-all p-1 rounded-lg",
                        isLight ? "text-slate-400 hover:text-red-600 hover:bg-red-50" : "text-gray-400 hover:text-red-400 hover:bg-red-500/10"
                      )}
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

      {/* User Profile & Logout Footer */}
      {(!sidebarCollapsed || isMobile) ? (
        <div className={clsx(
          "border-t p-2.5 shrink-0 flex items-center justify-between gap-2 transition-colors",
          isLight ? "border-slate-200 bg-white" : "border-gray-800 bg-gray-950"
        )}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className={clsx(
              "w-7 h-7 rounded-full flex items-center justify-center text-xs text-white font-bold shrink-0 shadow-sm",
              isAdmin ? "bg-gradient-to-tr from-cyan-600 to-blue-600" : "bg-gradient-to-tr from-indigo-600 to-purple-600"
            )}>
              {(currentUser?.name || currentUser?.email || 'U')[0].toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className={clsx("text-xs font-semibold truncate leading-tight", isLight ? "text-slate-900" : "text-white")}>
                {currentUser?.name || 'Guest User'}
              </p>
              <p className={clsx("text-[10px] truncate font-mono", isLight ? "text-slate-500" : "text-gray-400")}>
                {currentUser?.email || 'Not signed in'}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className={clsx(
              "p-1.5 rounded-lg transition-colors shrink-0 text-rose-500 hover:text-rose-600",
              isLight ? "hover:bg-rose-50" : "hover:bg-rose-950/40"
            )}
            title="Sign Out (Logout)"
            aria-label="Sign Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="border-t p-2 flex justify-center shrink-0">
          <button
            onClick={handleLogout}
            className="p-2 rounded-lg text-rose-500 hover:text-rose-600 hover:bg-rose-950/40 transition-colors"
            title="Sign Out (Logout)"
            aria-label="Sign Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Collapse toggle (Desktop only when collapsed) */}
      {!isMobile && sidebarCollapsed && (
        <button
          onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          className={clsx(
            "flex items-center justify-center py-3 border-t transition-colors shrink-0",
            isLight ? "border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-slate-100" : "border-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-900/50"
          )}
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
          'hidden lg:flex flex-col shrink-0 h-screen select-none relative group/sidebar transition-colors',
          isLight ? 'bg-white border-r border-slate-200' : 'bg-gray-950 border-r border-gray-800',
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

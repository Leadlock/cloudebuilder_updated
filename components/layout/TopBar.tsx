'use client';
import { useState, useRef, useEffect } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { Bell, Globe, Coins, ShieldCheck, UserCheck, LogOut, User, FileCheck, Menu } from 'lucide-react';
import clsx from 'clsx';
import { AppView, Environment } from '@/types';
import { cloudRegionService } from '@/lib/cloud/regions/CloudRegionService';
import { SUPPORTED_CURRENCIES } from '@/lib/currency/types';
import LoginModal from '@/components/auth/LoginModal';

const VIEW_LABELS: Partial<Record<AppView, string>> = {
  dashboard: 'Dashboard',
  canvas: 'Visual Builder',
  terraform: 'Terraform',
  security: 'Security Scan',
  cost: 'Cost Estimate',
  deploy: 'Deployment Center',
  wizard: 'Architecture Wizard',
  templates: 'Templates',
  'ai-generator': 'AI Generator',
  advisor: 'Architecture Advisor',
  'disaster-recovery': 'DR Designer',
  import: 'Import Infrastructure',
  history: 'Version History',
  environments: 'Environments',
  review: 'Architecture Review',
  team: 'Team Management',
};

const ENV_COLORS: Record<Environment, string> = {
  development: 'bg-blue-900/40 text-blue-300 border-blue-800',
  staging:     'bg-yellow-900/40 text-yellow-300 border-yellow-800',
  production:  'bg-emerald-900/40 text-emerald-300 border-emerald-800',
};

export default function TopBar() {
  const { state, dispatch } = useApp();
  const { activeView, activeEnvironment, currentUser } = state;
  const activeProject = useActiveProject();
  const activeRegion = activeProject?.environments[activeEnvironment]?.region ?? activeProject?.region ?? 'us-east-1';

  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      dispatch({ type: 'SET_USER', user: null });
      setUserMenuOpen(false);
      dispatch({ type: 'SET_LOGIN_MODAL', open: true });
    } catch (e) {
      console.error('Logout failed:', e);
    }
  };

  const isAdmin = currentUser?.role === 'admin';

  return (
    <header className="h-12 bg-gray-900 border-b border-gray-800 flex items-center px-2.5 sm:px-4 gap-2 sm:gap-3 shrink-0 select-none overflow-x-auto no-scrollbar">
      {/* Mobile Sidebar Hamburger Toggle */}
      <button
        onClick={() => dispatch({ type: 'TOGGLE_MOBILE_SIDEBAR' })}
        className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0 focus:outline-none"
        title="Open Navigation Menu"
        aria-label="Open Navigation Menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Breadcrumb with responsive truncation */}
      <div className="flex items-center gap-1.5 sm:gap-2 text-sm flex-1 min-w-0 mr-1 sm:mr-2 overflow-hidden">
        <span className="text-gray-500 text-xs shrink-0 hidden xs:inline">CloudCraft</span>
        <span className="text-gray-700 text-xs shrink-0 hidden xs:inline">/</span>
        {activeProject && (
          <>
            <button
              className="text-gray-400 hover:text-white flex items-center gap-1.5 truncate text-xs shrink-0 max-w-[90px] sm:max-w-[140px]"
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'canvas' })}
            >
              <span className={clsx('w-2 h-2 rounded-full shrink-0', activeProject.provider === 'aws' ? 'bg-orange-400' : activeProject.provider === 'azure' ? 'bg-blue-400' : 'bg-purple-400')} />
              <span className="truncate">{activeProject.name}</span>
            </button>
            <span className="text-gray-700 text-xs shrink-0">/</span>
          </>
        )}
        <span className="text-white font-medium text-xs truncate">{VIEW_LABELS[activeView]}</span>
      </div>

      {/* Region Selector (Desktop / Tablet) */}
      {activeProject && (
        <div className="hidden md:flex items-center gap-1.5 shrink-0" title={`Cloud Region: ${activeRegion}`}>
          <div className="flex items-center bg-gray-800/90 border border-gray-700 rounded-lg px-2 py-1 gap-1.5 text-xs text-gray-300">
            <Globe className="w-3.5 h-3.5 text-blue-400 shrink-0" aria-hidden="true" />
            <select
              aria-label="Cloud Region"
              value={activeRegion}
              onChange={(e) => dispatch({ type: 'SET_REGION', region: e.target.value })}
              className="bg-transparent text-gray-200 text-xs font-medium focus:outline-none cursor-pointer pr-1 max-w-[110px] truncate"
            >
              {cloudRegionService.getRegions(activeProject.provider === 'azure' ? 'azure' : 'aws').map((r) => (
                <option key={r.id} value={r.id} className="bg-gray-900 text-gray-200">
                  {r.id} — {r.displayName}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Currency Selector */}
      <div className="hidden sm:flex items-center gap-1.5 shrink-0" title={`Display Currency: ${state.displayCurrency}`}>
        <div className="flex items-center bg-gray-800/90 border border-gray-700 rounded-lg px-2 py-1 gap-1.5 text-xs text-gray-300">
          <Coins className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
          <select
            aria-label="Display Currency"
            value={state.displayCurrency}
            onChange={(e) => dispatch({ type: 'SET_CURRENCY', currency: e.target.value })}
            className="bg-transparent text-gray-200 text-xs font-medium focus:outline-none cursor-pointer pr-1"
          >
            {Object.values(SUPPORTED_CURRENCIES).map((c) => (
              <option key={c.code} value={c.code} className="bg-gray-900 text-gray-200">
                {c.code} ({c.symbol})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Env switcher (only when project is active) */}
      {activeProject && (
        <div className="hidden sm:flex items-center gap-1 shrink-0">
          {(['development', 'staging', 'production'] as Environment[]).map((env) => (
            <button
              key={env}
              onClick={() => dispatch({ type: 'SET_ENVIRONMENT', env })}
              className={clsx(
                'px-2 py-0.5 rounded text-[10px] font-medium border capitalize transition-colors',
                activeEnvironment === env ? ENV_COLORS[env] : 'border-transparent text-gray-600 hover:text-gray-400'
              )}
            >
              {env === 'development' ? 'Dev' : env === 'staging' ? 'Staging' : 'Prod'}
            </button>
          ))}
        </div>
      )}

      {/* Review shortcut */}
      {activeProject && (
        <button
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'review' })}
          className={clsx(
            "flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg border transition-colors shrink-0",
            activeView === 'review'
              ? "bg-indigo-600 border-indigo-500 text-white"
              : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
          )}
        >
          <FileCheck className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden sm:inline">Review</span>
        </button>
      )}

      {/* Deploy button */}
      {activeProject && !['dashboard', 'wizard', 'templates', 'ai-generator', 'import', 'disaster-recovery'].includes(activeView) && (
        <button
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'deploy' })}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-colors shrink-0 shadow-sm"
        >
          Deploy
        </button>
      )}

      {/* User profile / RBAC indicator */}
      <div className="relative shrink-0" ref={userMenuRef}>
        <button
          onClick={() => setUserMenuOpen((v) => !v)}
          className="flex items-center gap-1.5 sm:gap-2 px-1.5 sm:px-2 py-1 rounded-lg hover:bg-slate-800 transition-colors focus:outline-none"
          title={`Signed in as ${currentUser?.name || 'Guest'} (${currentUser?.role || 'user'})`}
        >
          <div className={clsx(
            "w-7 h-7 rounded-full flex items-center justify-center text-xs text-white font-bold shadow-sm",
            isAdmin ? "bg-gradient-to-tr from-cyan-600 to-blue-600" : "bg-gradient-to-tr from-indigo-600 to-purple-600"
          )}>
            {currentUser?.name?.[0] || 'U'}
          </div>
          <span className={clsx(
            "hidden sm:inline-block text-[10px] font-bold px-1.5 py-0.5 rounded uppercase",
            isAdmin ? "bg-cyan-950 text-cyan-300 border border-cyan-500/40" : "bg-indigo-950 text-indigo-300 border border-indigo-500/40"
          )}>
            {currentUser?.role || 'user'}
          </span>
        </button>

        {/* Dropdown Menu */}
        {userMenuOpen && (
          <div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-2 z-50 text-xs space-y-2">
            <div className="px-3 py-2 border-b border-slate-800">
              <p className="text-white font-bold truncate">{currentUser?.name || 'Guest User'}</p>
              <p className="text-slate-400 text-[11px] truncate font-mono">{currentUser?.email || 'Not authenticated'}</p>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="text-[10px] text-slate-500 uppercase font-semibold">Active Role:</span>
                <span className={clsx(
                  "text-[9px] font-bold px-1.5 py-0.2 rounded uppercase",
                  isAdmin ? "bg-cyan-500/20 text-cyan-300" : "bg-indigo-500/20 text-indigo-300"
                )}>
                  {currentUser?.role || 'user'}
                </span>
              </div>
            </div>

            {/* Sign in with another account */}
            <button
              onClick={() => {
                setUserMenuOpen(false);
                dispatch({ type: 'SET_LOGIN_MODAL', open: true });
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors text-left"
            >
              <User className="w-3.5 h-3.5 text-blue-400" />
              <span>Switch Account / Sign In</span>
            </button>

            {/* Logout */}
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 transition-colors text-left border-t border-slate-800"
            >
              <LogOut className="w-3.5 h-3.5 text-rose-400" />
              <span>Sign Out</span>
            </button>
          </div>
        )}
      </div>

      <LoginModal
        isOpen={state.isLoginModalOpen}
        onSuccess={(user) => {
          dispatch({ type: 'SET_USER', user });
          dispatch({ type: 'SET_LOGIN_MODAL', open: false });
        }}
        onClose={() => dispatch({ type: 'SET_LOGIN_MODAL', open: false })}
      />
    </header>
  );
}

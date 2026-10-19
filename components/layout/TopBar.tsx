'use client';
import { RESTRICTED_FEATURE_LABEL } from '@/lib/auth/restrictedFeatures';
import { useState, useRef, useEffect } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { Bell, Globe, Coins, ShieldCheck, UserCheck, LogOut, User, FileCheck, Menu, Sun, Moon, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { AppView, Environment } from '@/types';
import { cloudRegionService } from '@/lib/cloud/regions/CloudRegionService';
import { SUPPORTED_CURRENCIES } from '@/lib/currency/types';
import LoginModal from '@/components/auth/LoginModal';
import { useOrgPolicy } from '@/components/policy/orgPolicyStore';
import { isRegionAllowed } from '@/lib/engines/policy/allowed';

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
  'container-templates': 'Container Templates',
  import: 'Import Infrastructure',
  accounts: 'Cloud Accounts',
  history: 'Version History',
  environments: 'Environments',
  review: 'Architecture Review',
  policy: 'Organization Policy',
  'operator-access': 'Deploy access',
  team: 'Team Management',
};

const ENV_COLORS: Record<Environment, string> = {
  development: 'bg-[#0078d4]/18 text-[#50e6ff] border-[#0078d4]/40 font-medium',
  staging:     'bg-amber-500/18 text-amber-300 border-amber-500/40 font-medium',
  production:  'bg-emerald-500/18 text-emerald-300 border-emerald-500/40 font-medium',
};

const ENV_COLORS_LIGHT: Record<Environment, string> = {
  development: 'bg-[#0078d4]/10 text-[#005a9e] border-[#0078d4]/30 font-semibold shadow-xs',
  staging:     'bg-amber-50 text-amber-900 border-amber-300 font-semibold shadow-xs',
  production:  'bg-emerald-50 text-emerald-900 border-emerald-300 font-semibold shadow-xs',
};

export default function TopBar() {
  const { state, dispatch } = useApp();
  const { activeView, activeEnvironment, currentUser, theme } = state;
  const isLight = theme === 'light';
  const activeProject = useActiveProject();
  const activeRegion = activeProject?.environments[activeEnvironment]?.region ?? activeProject?.region ?? 'us-east-1';
  const regionProvider = activeProject?.provider === 'azure' ? 'azure' : 'aws';
  const { policy } = useOrgPolicy(currentUser?.id);

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
      if (typeof window !== 'undefined') {
        localStorage.removeItem('cloudcraft_demo_user');
      }
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
    <header className={clsx(
      "h-12 border-b flex items-center justify-between px-2.5 sm:px-4 gap-2 sm:gap-3 shrink-0 select-none relative z-40 transition-colors",
      isLight ? "bg-white border-slate-200 text-slate-900 shadow-sm" : "bg-[#18181a] border-white/[0.08] text-slate-100"
    )}>
      {/* Left / Middle Scrollable Section */}
      <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0 overflow-x-auto no-scrollbar py-1">
        {/* Mobile Sidebar Hamburger Toggle */}
        <button
          onClick={() => dispatch({ type: 'TOGGLE_MOBILE_SIDEBAR' })}
          className={clsx(
            "lg:hidden p-1.5 rounded-lg transition-colors shrink-0 focus:outline-none",
            isLight ? "text-slate-600 hover:text-slate-900 hover:bg-slate-100" : "text-slate-400 hover:text-white hover:bg-slate-800"
          )}
          title="Open Navigation Menu"
          aria-label="Open Navigation Menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Breadcrumb with responsive truncation */}
        <div className="flex items-center gap-1.5 sm:gap-2 text-sm shrink-0 min-w-0 mr-1 sm:mr-2 overflow-hidden">
          <span className={clsx("text-xs shrink-0 hidden xs:inline", isLight ? "text-slate-500" : "text-gray-500")}>CloudBuilder</span>
          <span className={clsx("text-xs shrink-0 hidden xs:inline", isLight ? "text-slate-400" : "text-gray-700")}>/</span>
          {activeProject && (
            <>
              <button
                className={clsx(
                  "flex items-center gap-1.5 truncate text-xs shrink-0 max-w-[140px] sm:max-w-[280px] font-semibold transition-colors",
                  isLight ? "text-slate-700 hover:text-slate-900" : "text-gray-300 hover:text-white"
                )}
                onClick={() => dispatch({ type: 'SET_VIEW', view: 'canvas' })}
                title={`Active Project: ${activeProject.name}`}
              >
                <span className={clsx('w-2 h-2 rounded-full shrink-0', activeProject.provider === 'aws' ? 'bg-orange-500' : activeProject.provider === 'azure' ? 'bg-blue-500' : 'bg-purple-500')} />
                <span className="truncate">{activeProject.name}</span>
              </button>
              <span className={clsx("text-xs shrink-0", isLight ? "text-slate-400" : "text-gray-700")}>/</span>
            </>
          )}
          <span className={clsx("font-bold text-xs truncate", isLight ? "text-slate-900" : "text-white")}>{VIEW_LABELS[activeView]}</span>
        </div>

        {/* Region Selector (Desktop / Tablet) */}
        {activeProject && (
          <div className="hidden md:flex items-center gap-1.5 shrink-0" title={`Cloud Region: ${activeRegion}`}>
            <div className={clsx(
              "flex items-center rounded-lg px-2 py-1 gap-1.5 text-xs transition-colors border",
              isLight
                ? "bg-slate-100 hover:bg-slate-200/80 border-slate-300 text-slate-800 shadow-xs"
                : "bg-[#242426] hover:bg-[#2c2c2e] border-white/[0.12] text-slate-200"
            )}>
              <Globe className="w-3.5 h-3.5 text-blue-500 shrink-0" aria-hidden="true" />
              <select
                aria-label="Cloud Region"
                value={activeRegion}
                onChange={(e) => dispatch({ type: 'SET_REGION', region: e.target.value })}
                className={clsx(
                  "bg-transparent text-xs font-semibold focus:outline-none cursor-pointer pr-1 max-w-[110px] truncate",
                  isLight ? "text-slate-800" : "text-gray-200"
                )}
              >
                {cloudRegionService.getRegions(regionProvider).map((r) => {
                  // Regions the organization policy does not approve are greyed out; the region already in use never is.
                  const blocked = r.id !== activeRegion && !isRegionAllowed(policy, regionProvider, r.id);
                  return (
                    <option key={r.id} value={r.id} disabled={blocked} className={clsx(blocked ? "text-slate-400" : isLight ? "bg-white text-slate-900" : "bg-gray-900 text-gray-200")}>
                      {r.id} — {r.displayName}{blocked ? ' (outside org policy)' : ''}
                    </option>
                  );
                })}
              </select>
            </div>
          </div>
        )}

        {/* Currency Selector */}
        <div className="hidden sm:flex items-center gap-1.5 shrink-0" title={`Display Currency: ${state.displayCurrency}`}>
          <div className={clsx(
            "flex items-center rounded-lg px-2 py-1 gap-1.5 text-xs transition-colors border",
            isLight
              ? "bg-slate-100 hover:bg-slate-200/80 border-slate-300 text-slate-800 shadow-xs"
              : "bg-[#242426] hover:bg-[#2c2c2e] border-white/[0.12] text-slate-200"
          )}>
            <Coins className="w-3.5 h-3.5 text-emerald-500 shrink-0" aria-hidden="true" />
            <select
              aria-label="Display Currency"
              value={state.displayCurrency}
              onChange={(e) => dispatch({ type: 'SET_CURRENCY', currency: e.target.value })}
              className={clsx(
                "bg-transparent text-xs font-semibold focus:outline-none cursor-pointer pr-1",
                isLight ? "text-slate-800" : "text-gray-200"
              )}
            >
              {Object.values(SUPPORTED_CURRENCIES).map((c) => (
                <option key={c.code} value={c.code} className={clsx(isLight ? "bg-white text-slate-900" : "bg-gray-900 text-gray-200")}>
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
                  activeEnvironment === env
                    ? (isLight ? ENV_COLORS_LIGHT[env] : ENV_COLORS[env])
                    : (isLight ? 'border-transparent text-slate-500 hover:text-slate-800' : 'border-transparent text-gray-600 hover:text-gray-400')
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
                ? "bg-[#0078d4] border-[#0078d4] text-white shadow-xs"
                : isLight
                ? "bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700 shadow-xs"
                : "bg-[#242426] hover:bg-[#2c2c2e] border-white/[0.12] text-slate-300"
            )}
          >
            <FileCheck className="w-3.5 h-3.5 text-indigo-500" />
            <span className="hidden sm:inline">Review</span>
          </button>
        )}

        {/* Deploy button */}
        {activeProject && !['dashboard', 'wizard', 'templates', 'ai-generator', 'import', 'container-templates', 'disaster-recovery'].includes(activeView) && (
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'deploy' })}
            disabled={currentUser?.restrictedFeatures === false}
            title={currentUser?.restrictedFeatures === false ? `Deploy — ${RESTRICTED_FEATURE_LABEL}` : undefined}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-colors shrink-0 shadow-sm active:scale-[0.98] disabled:bg-gray-500/40 disabled:text-gray-400 disabled:cursor-not-allowed disabled:shadow-none disabled:active:scale-100"
          >
            Deploy
          </button>
        )}
      </div>

      {/* Right Fixed Section (Theme Toggle + User Profile Dropdown) */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Dark / Night Mode Toggle */}
        <button
          type="button"
          onClick={() => dispatch({ type: 'TOGGLE_THEME' })}
          className={clsx(
            "flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-all text-xs font-semibold shrink-0 focus:outline-none focus:ring-2 focus:ring-[#0078d4]/50 active:scale-[0.98]",
            isLight
              ? "bg-slate-100 hover:bg-slate-200/80 border-slate-300 text-slate-800 shadow-xs"
              : "bg-[#242426] hover:bg-[#2c2c2e] border-white/[0.12] text-slate-200"
          )}
          title={isLight ? 'Switch to Night Mode (Dark)' : 'Switch to Light Mode'}
          aria-label={isLight ? 'Switch to Night Mode' : 'Switch to Light Mode'}
        >
          {isLight ? (
            <>
              <Moon className="w-3.5 h-3.5 text-indigo-600 animate-in spin-in-45 duration-200" />
              <span className="hidden sm:inline text-[11px] font-bold">Night</span>
            </>
          ) : (
            <>
              <Sun className="w-3.5 h-3.5 text-amber-400 animate-in spin-in-45 duration-200" />
              <span className="hidden sm:inline text-[11px] font-bold">Light</span>
            </>
          )}
        </button>

      {/* User profile / RBAC indicator & Dropdown */}
      <div className="relative shrink-0" ref={userMenuRef}>
        <button
          onClick={() => setUserMenuOpen((v) => !v)}
          className={clsx(
            "flex items-center gap-1.5 sm:gap-2 px-2 py-1 rounded-lg transition-colors border focus:outline-none",
            isLight
              ? "bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-800 shadow-xs"
              : "bg-[#242426] hover:bg-[#2c2c2e] border-white/[0.12] text-slate-200"
          )}
          title={`Signed in as ${currentUser?.name || currentUser?.email || 'Guest'} (${currentUser?.role || 'user'})`}
        >
          <div className={clsx(
            "w-6 h-6 rounded-full flex items-center justify-center text-xs text-white font-bold shadow-sm shrink-0",
            isAdmin ? "bg-gradient-to-tr from-cyan-600 to-blue-600" : "bg-gradient-to-tr from-indigo-600 to-purple-600"
          )}>
            {(currentUser?.name || currentUser?.email || 'U')[0].toUpperCase()}
          </div>
          <span className={clsx(
            "hidden sm:inline-block text-[10px] font-bold px-1.5 py-0.5 rounded uppercase",
            isAdmin ? (isLight ? "bg-cyan-100 text-cyan-800 border border-cyan-300" : "bg-cyan-950 text-cyan-300 border border-cyan-500/40")
                    : (isLight ? "bg-indigo-100 text-indigo-800 border border-indigo-300" : "bg-indigo-950 text-indigo-300 border border-indigo-500/40")
          )}>
            {currentUser?.role || 'user'}
          </span>
          <ChevronDown className={clsx("w-3.5 h-3.5 opacity-60 transition-transform", userMenuOpen && "rotate-180")} />
        </button>

        {/* Dropdown Menu */}
        {userMenuOpen && (
          <div className={clsx(
            "absolute right-0 mt-2 w-64 rounded-xl shadow-2xl p-2 z-50 text-xs space-y-1.5 border animate-in fade-in zoom-in-95 duration-150",
            isLight ? "bg-white border-slate-200 text-slate-900 shadow-xl" : "bg-[#1c1c1e] border-white/[0.10] text-slate-100 shadow-2xl"
          )}>
            <div className={clsx("px-3 py-2 border-b", isLight ? "border-slate-100 bg-slate-50/50 rounded-t-lg" : "border-white/[0.08]")}>
              <p className={clsx("font-bold truncate", isLight ? "text-slate-900" : "text-white")}>
                {currentUser?.name || 'Guest User'}
              </p>
              <p className={clsx("text-[11px] truncate font-mono", isLight ? "text-slate-500" : "text-slate-400")}>
                {currentUser?.email || 'Not authenticated'}
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                <span className={clsx("text-[10px] uppercase font-semibold", isLight ? "text-slate-500" : "text-slate-500")}>Role:</span>
                <span className={clsx(
                  "text-[9px] font-bold px-1.5 py-0.2 rounded uppercase",
                  isAdmin
                    ? (isLight ? "bg-cyan-100 text-cyan-800" : "bg-cyan-500/20 text-cyan-300")
                    : (isLight ? "bg-indigo-100 text-indigo-800" : "bg-indigo-500/20 text-indigo-300")
                )}>
                  {currentUser?.role || 'user'}
                </span>
              </div>
            </div>

            {/* Switch / Sign In */}
            <button
              onClick={() => {
                setUserMenuOpen(false);
                dispatch({ type: 'SET_LOGIN_MODAL', open: true });
              }}
              className={clsx(
                "w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left",
                isLight ? "text-slate-700 hover:text-slate-900 hover:bg-slate-100" : "text-slate-300 hover:text-white hover:bg-slate-800"
              )}
            >
              <User className="w-3.5 h-3.5 text-blue-500" />
              <span>Switch Account / Sign In</span>
            </button>

            {/* Logout */}
            <button
              onClick={handleLogout}
              className={clsx(
                "w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left border-t font-semibold",
                isLight
                  ? "border-slate-100 text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                  : "border-slate-800 text-rose-400 hover:text-rose-300 hover:bg-rose-950/40"
              )}
            >
              <LogOut className="w-3.5 h-3.5 text-rose-500" />
              <span>Sign Out (Logout)</span>
            </button>
          </div>
        )}
      </div>
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

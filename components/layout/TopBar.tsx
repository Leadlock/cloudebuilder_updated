'use client';
import { useApp, useActiveProject } from '@/context/AppContext';
import { Bell, Globe, Coins } from 'lucide-react';
import clsx from 'clsx';
import { AppView, Environment } from '@/types';
import { cloudRegionService } from '@/lib/cloud/regions/CloudRegionService';
import { SUPPORTED_CURRENCIES } from '@/lib/currency/types';

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
};

const ENV_COLORS: Record<Environment, string> = {
  development: 'bg-blue-900/40 text-blue-300 border-blue-800',
  staging:     'bg-yellow-900/40 text-yellow-300 border-yellow-800',
  production:  'bg-emerald-900/40 text-emerald-300 border-emerald-800',
};

export default function TopBar() {
  const { state, dispatch } = useApp();
  const { activeView, activeEnvironment } = state;
  const activeProject = useActiveProject();
  const activeRegion = activeProject?.environments[activeEnvironment]?.region ?? activeProject?.region ?? 'us-east-1';

  return (
    <header className="h-12 bg-gray-900 border-b border-gray-800 flex items-center px-4 gap-3 shrink-0">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm flex-1 min-w-0">
        <span className="text-gray-500 text-xs">CloudCraft</span>
        <span className="text-gray-700 text-xs">/</span>
        {activeProject && (
          <>
            <button className="text-gray-400 hover:text-white flex items-center gap-1.5 truncate text-xs"
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'canvas' })}>
              <span className={clsx('w-2 h-2 rounded-full', activeProject.provider === 'aws' ? 'bg-orange-400' : activeProject.provider === 'azure' ? 'bg-blue-400' : 'bg-purple-400')} />
              <span className="truncate max-w-[120px]">{activeProject.name}</span>
            </button>
            <span className="text-gray-700 text-xs">/</span>
          </>
        )}
        <span className="text-white font-medium text-xs">{VIEW_LABELS[activeView]}</span>
      </div>

      {/* Region Selector */}
      {activeProject && (
        <div className="flex items-center gap-1.5 shrink-0" title={`Cloud Region: ${activeRegion}`}>
          <div className="flex items-center bg-gray-800/90 border border-gray-700 rounded-md px-2 py-1 gap-1.5 text-xs text-gray-300">
            <Globe className="w-3.5 h-3.5 text-blue-400 shrink-0" aria-hidden="true" />
            <select
              aria-label="Cloud Region"
              value={activeRegion}
              onChange={(e) => dispatch({ type: 'SET_REGION', region: e.target.value })}
              className="bg-transparent text-gray-200 text-xs font-medium focus:outline-none cursor-pointer pr-1"
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
      <div className="flex items-center gap-1.5 shrink-0" title={`Display Currency: ${state.displayCurrency}`}>
        <div className="flex items-center bg-gray-800/90 border border-gray-700 rounded-md px-2 py-1 gap-1.5 text-xs text-gray-300">
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
        <div className="flex items-center gap-1.5 shrink-0">
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

      {/* View switcher (canvas context) */}
      {activeProject && activeView !== 'dashboard' && activeView !== 'wizard' && activeView !== 'templates' && activeView !== 'ai-generator' && activeView !== 'import' && activeView !== 'disaster-recovery' && (
        <div className="flex bg-gray-800 rounded-md p-0.5 shrink-0">
          {(['canvas', 'security', 'cost', 'terraform'] as const).map((v) => (
            <button
              key={v}
              onClick={() => dispatch({ type: 'SET_VIEW', view: v })}
              className={clsx(
                'px-2.5 py-1 rounded text-[10px] font-medium transition-colors capitalize',
                activeView === v ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              )}
            >
              {v === 'canvas' ? 'Canvas' : v === 'security' ? 'Security' : v === 'cost' ? 'Cost' : 'Terraform'}
            </button>
          ))}
        </div>
      )}

      {/* Deploy button */}
      {activeProject && !['dashboard', 'wizard', 'templates', 'ai-generator', 'import', 'disaster-recovery'].includes(activeView) && (
        <button
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'deploy' })}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-md transition-colors shrink-0"
        >
          Deploy
        </button>
      )}

      <button aria-label="Notifications" className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-white rounded-md hover:bg-gray-800 transition-colors shrink-0 focus:outline-none focus:ring-2 focus:ring-blue-500">
        <Bell className="w-4 h-4" aria-hidden="true" />
      </button>
      <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-xs text-white font-medium shrink-0">U</div>
    </header>
  );
}

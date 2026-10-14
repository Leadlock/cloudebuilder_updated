'use client';
import { RESTRICTED_FEATURE_LABEL } from '@/lib/auth/restrictedFeatures';
import React, { useState } from 'react';
import { useEscapeKey } from '@/lib/ui/useEscapeKey';
import { ProviderMode, ScaleProfile, Region, AWS_REGIONS, AZURE_REGIONS } from '@/types';
import { useApp } from '@/context/AppContext';
import { Cloud, Server, Sparkles, Cpu, Globe, Activity, Check, ArrowRight, ShieldCheck, X } from 'lucide-react';
import clsx from 'clsx';

interface CanvasStartModalProps {
  isOpen: boolean;
  onClose?: () => void;
  onStart: (options: {
    providerMode: ProviderMode;
    scaleProfile: ScaleProfile;
    mode: 'manual' | 'ai';
    aiPrompt?: string;
    region?: Region;
  }) => void;
}

const SCALE_PRESETS = [
  { label: '100', users: 100, rps: 1, peakRps: 5, sla: '99.9%' },
  { label: '1,000', users: 1000, rps: 8, peakRps: 25, sla: '99.9%' },
  { label: '10,000', users: 10000, rps: 50, peakRps: 150, sla: '99.9%' },
  { label: '50,000', users: 50000, rps: 250, peakRps: 800, sla: '99.95%' },
  { label: '100,000', users: 100000, rps: 600, peakRps: 2000, sla: '99.99%' },
  { label: '500,000', users: 500000, rps: 3000, peakRps: 9000, sla: '99.99%' },
  { label: '1,000,000+', users: 1000000, rps: 7000, peakRps: 22000, sla: '99.999%' },
];

export default function CanvasStartModal({ isOpen, onClose, onStart }: CanvasStartModalProps) {
  const { state } = useApp();
  useEscapeKey(isOpen && onClose ? onClose : undefined);
  const isLight = state.theme === 'light';
  const [providerMode, setProviderMode] = useState<ProviderMode>('AWS');
  const [buildMode, setBuildMode] = useState<'manual' | 'ai'>('manual');
  const aiLocked = state.currentUser?.restrictedFeatures === false;
  const [expectedUsers, setExpectedUsers] = useState<number>(10000);
  const [customUsers, setCustomUsers] = useState<string>('');
  const [isCustomUsers, setIsCustomUsers] = useState<boolean>(false);
  const [trafficPattern, setTrafficPattern] = useState<string>('steady');
  const [slaTarget, setSlaTarget] = useState<string>('99.9%');
  const [selectedRegion, setSelectedRegion] = useState<Region>('us-east-1');
  const [aiPrompt, setAiPrompt] = useState<string>(
    'Web application with autoscaled container compute, managed database with read replica, caching tier, and secure public-private VPC subnet isolation.'
  );

  if (!isOpen) return null;

  const currentUsers = isCustomUsers ? parseInt(customUsers, 10) || 10000 : expectedUsers;
  const estimatedRps = Math.max(1, Math.round(currentUsers * 0.005));
  const estimatedPeakRps = Math.round(estimatedRps * 3);

  const availableRegions =
    providerMode === 'AZURE' ? AZURE_REGIONS :
    AWS_REGIONS;

  const handleStart = () => {
    const scaleProfile: ScaleProfile = {
      expectedUsers: currentUsers,
      requestsPerSecond: estimatedRps,
      peakRequestsPerSecond: estimatedPeakRps,
      availabilityTarget: slaTarget,
      trafficPattern,
      geographicDistribution: currentUsers >= 100000 ? 'multi-region' : 'single-region',
    };

    onStart({
      providerMode,
      scaleProfile,
      mode: buildMode,
      aiPrompt: buildMode === 'ai' ? aiPrompt : undefined,
      region: selectedRegion,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className={clsx(
        'relative w-full max-w-2xl border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]',
        isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-gray-900 border-gray-800 text-white'
      )}>
        {/* Header */}
        <div className={clsx(
          'relative px-6 pt-6 pb-4 border-b',
          isLight
            ? 'border-slate-200 bg-gradient-to-r from-slate-50 via-white to-blue-50/50'
            : 'border-gray-800 bg-gradient-to-r from-gray-900 via-gray-900/90 to-blue-950/40'
        )}>
          {onClose && (
            <button
              onClick={onClose}
              className={clsx(
                'absolute top-5 right-5 p-1 rounded-lg transition-colors',
                isLight ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100' : 'text-gray-400 hover:text-white hover:bg-gray-800'
              )}
              aria-label="Close dialog"
            >
              <X className="w-5 h-5" />
            </button>
          )}
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <h2 className={clsx('text-xl font-bold tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>Create Your Architecture</h2>
              <p className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-gray-400')}>Initialize canvas with cloud provider, target scale, and validation rules</p>
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="px-6 py-5 overflow-y-auto space-y-6 flex-1 custom-scrollbar">
          {/* Cloud Selection */}
          <div>
            <label className={clsx('block text-xs font-semibold uppercase tracking-wider mb-2.5', isLight ? 'text-slate-600' : 'text-gray-300')}>
              1. What cloud are you building for?
            </label>
            <div className="grid grid-cols-3 gap-3">
              {/* AWS */}
              <button
                type="button"
                id="select-cloud-aws"
                onClick={() => {
                  setProviderMode('AWS');
                  setSelectedRegion('us-east-1');
                }}
                className={clsx(
                  'flex flex-col items-center justify-center p-3.5 rounded-xl border transition-all text-center relative',
                  providerMode === 'AWS'
                    ? (isLight ? 'border-orange-500 bg-orange-50 text-orange-950 ring-2 ring-orange-400/40 shadow-sm' : 'border-orange-500/80 bg-orange-500/10 text-white ring-1 ring-orange-500/50 shadow-md shadow-orange-500/10')
                    : isLight
                    ? 'border-slate-200 bg-slate-50 hover:border-slate-300 text-slate-700 hover:text-slate-900'
                    : 'border-gray-800 bg-gray-950/60 hover:border-gray-700 text-gray-400 hover:text-gray-200'
                )}
              >
                {providerMode === 'AWS' && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-orange-500"></span>
                )}
                <span className={clsx('text-sm font-bold mb-0.5', isLight ? 'text-orange-600' : 'text-orange-400')}>AWS</span>
                <span className={clsx('text-[11px]', isLight ? 'text-slate-500' : 'text-gray-400')}>Amazon Web Services</span>
              </button>

              {/* Azure */}
              <button
                type="button"
                id="select-cloud-azure"
                onClick={() => {
                  setProviderMode('AZURE');
                  setSelectedRegion('eastus');
                }}
                className={clsx(
                  'flex flex-col items-center justify-center p-3.5 rounded-xl border transition-all text-center relative',
                  providerMode === 'AZURE'
                    ? (isLight ? 'border-blue-500 bg-blue-50 text-blue-950 ring-2 ring-blue-400/40 shadow-sm' : 'border-blue-500/80 bg-blue-500/10 text-white ring-1 ring-blue-500/50 shadow-md shadow-blue-500/10')
                    : isLight
                    ? 'border-slate-200 bg-slate-50 hover:border-slate-300 text-slate-700 hover:text-slate-900'
                    : 'border-gray-800 bg-gray-950/60 hover:border-gray-700 text-gray-400 hover:text-gray-200'
                )}
              >
                {providerMode === 'AZURE' && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-blue-500"></span>
                )}
                <span className={clsx('text-sm font-bold mb-0.5', isLight ? 'text-blue-600' : 'text-blue-400')}>Azure</span>
                <span className={clsx('text-[11px]', isLight ? 'text-slate-500' : 'text-gray-400')}>Microsoft Azure</span>
              </button>

              {/* AWS + Azure (Multi-Cloud) */}
              <button
                type="button"
                id="select-cloud-multicloud"
                onClick={() => {
                  setProviderMode('MULTI_CLOUD');
                  setSelectedRegion('us-east-1');
                }}
                className={clsx(
                  'flex flex-col items-center justify-center p-3.5 rounded-xl border transition-all text-center relative',
                  providerMode === 'MULTI_CLOUD'
                    ? (isLight ? 'border-purple-500 bg-purple-50 text-purple-950 ring-2 ring-purple-400/40 shadow-sm' : 'border-purple-500/80 bg-purple-500/10 text-white ring-1 ring-purple-500/50 shadow-md shadow-purple-500/10')
                    : isLight
                    ? 'border-slate-200 bg-slate-50 hover:border-slate-300 text-slate-700 hover:text-slate-900'
                    : 'border-gray-800 bg-gray-950/60 hover:border-gray-700 text-gray-400 hover:text-gray-200'
                )}
              >
                {providerMode === 'MULTI_CLOUD' && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-purple-500"></span>
                )}
                <span className="text-sm font-bold bg-gradient-to-r from-orange-500 to-blue-500 bg-clip-text text-transparent mb-0.5">
                  AWS + Azure
                </span>
                <span className={clsx('text-[11px]', isLight ? 'text-slate-500' : 'text-gray-400')}>Multi-Cloud</span>
              </button>
            </div>
          </div>

          {/* Scale: Expected Users */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={clsx('block text-xs font-semibold uppercase tracking-wider', isLight ? 'text-slate-600' : 'text-gray-300')}>
                2. How many users are you designing for?
              </label>
              <span className={clsx('text-xs font-bold', isLight ? 'text-blue-600' : 'text-blue-400')}>
                {currentUsers.toLocaleString()} users (~{estimatedRps} RPS)
              </span>
            </div>

            <div className="flex flex-wrap gap-2 mb-2.5">
              {SCALE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setExpectedUsers(preset.users);
                    setIsCustomUsers(false);
                    setSlaTarget(preset.sla);
                  }}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                    !isCustomUsers && expectedUsers === preset.users
                      ? 'bg-blue-600 border-blue-500 text-white shadow-sm'
                      : isLight
                      ? 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'
                      : 'bg-gray-800/80 border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white'
                  )}
                >
                  {preset.label} users
                </button>
              ))}
              <button
                type="button"
                onClick={() => setIsCustomUsers(true)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                  isCustomUsers
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : isLight
                    ? 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'
                    : 'bg-gray-800/80 border-gray-700 text-gray-300 hover:bg-gray-700'
                )}
              >
                Custom
              </button>
            </div>

            {isCustomUsers && (
              <div className="mt-2">
                <input
                  type="number"
                  min="1"
                  max="100000000"
                  placeholder="Enter expected users (e.g. 25000)"
                  value={customUsers}
                  onChange={(e) => setCustomUsers(e.target.value)}
                  className={clsx(
                    'w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500',
                    isLight
                      ? 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white'
                      : 'bg-gray-950 border-blue-500/50 text-white'
                  )}
                />
              </div>
            )}

            {/* Workload Profile Stats */}
            <div className={clsx(
              'grid grid-cols-3 gap-2.5 mt-3 p-3 rounded-xl border text-xs',
              isLight ? 'bg-slate-50 border-slate-200' : 'bg-gray-950/60 border-gray-800/80'
            )}>
              <div>
                <span className={clsx('block text-[10px] uppercase font-semibold', isLight ? 'text-slate-500' : 'text-gray-500')}>Estimated RPS</span>
                <span className={clsx('font-mono font-medium', isLight ? 'text-slate-800' : 'text-gray-200')}>{estimatedRps} req/s</span>
              </div>
              <div>
                <span className={clsx('block text-[10px] uppercase font-semibold', isLight ? 'text-slate-500' : 'text-gray-500')}>Peak RPS</span>
                <span className={clsx('font-mono font-medium', isLight ? 'text-slate-800' : 'text-gray-200')}>{estimatedPeakRps} req/s</span>
              </div>
              <div>
                <span className={clsx('block text-[10px] uppercase font-semibold', isLight ? 'text-slate-500' : 'text-gray-500')}>Target SLA</span>
                <span className={clsx('font-mono font-medium', isLight ? 'text-emerald-700' : 'text-emerald-400')}>{slaTarget}</span>
              </div>
            </div>
          </div>

          {/* Creation Mode: Manual vs AI */}
          <div>
            <label className={clsx('block text-xs font-semibold uppercase tracking-wider mb-2.5', isLight ? 'text-slate-600' : 'text-gray-300')}>
              3. Architecture Creation Mode
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                id="btn-mode-manual"
                onClick={() => setBuildMode('manual')}
                className={clsx(
                  'flex items-start gap-3 p-3 rounded-xl border text-left transition-all',
                  buildMode === 'manual'
                    ? (isLight ? 'border-blue-500 bg-blue-50 text-slate-900 ring-1 ring-blue-400/40 shadow-sm' : 'border-blue-500 bg-blue-500/10 text-white ring-1 ring-blue-500/30')
                    : isLight
                    ? 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:text-slate-900'
                    : 'border-gray-800 bg-gray-950/60 text-gray-400 hover:border-gray-700'
                )}
              >
                <div className={clsx('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', isLight ? 'bg-blue-100 text-blue-600' : 'bg-gray-800 text-blue-400')}>
                  <Server className="w-4 h-4" />
                </div>
                <div>
                  <div className={clsx('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>Manual Architecture</div>
                  <div className={clsx('text-[11px] leading-snug mt-0.5', isLight ? 'text-slate-500' : 'text-gray-400')}>
                    Start on a blank canvas with full palette, RDE validation, and auto-fix.
                  </div>
                </div>
              </button>

              <button
                type="button"
                id="btn-mode-ai"
                disabled={aiLocked}
                title={aiLocked ? `AI-Assisted — ${RESTRICTED_FEATURE_LABEL}` : undefined}
                onClick={() => setBuildMode('ai')}
                className={clsx(
                  'flex items-start gap-3 p-3 rounded-xl border text-left transition-all',
                  aiLocked && 'opacity-50 grayscale cursor-not-allowed',
                  buildMode === 'ai'
                    ? (isLight ? 'border-indigo-500 bg-indigo-50 text-slate-900 ring-1 ring-indigo-400/40 shadow-sm' : 'border-indigo-500 bg-indigo-500/10 text-white ring-1 ring-indigo-500/30')
                    : isLight
                    ? 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:text-slate-900'
                    : 'border-gray-800 bg-gray-950/60 text-gray-400 hover:border-gray-700'
                )}
              >
                <div className={clsx('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', isLight ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-900/50 text-indigo-300')}>
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <div className={clsx('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>AI-Assisted</div>
                  <div className={clsx('text-[11px] leading-snug mt-0.5', isLight ? 'text-slate-500' : 'text-gray-400')}>
                    {aiLocked ? RESTRICTED_FEATURE_LABEL : 'CloudCraft derives workload and suggests validated canonical topology.'}
                  </div>
                </div>
              </button>
            </div>

            {buildMode === 'ai' && (
              <div className="mt-3">
                <label className={clsx('block text-[11px] font-medium mb-1.5', isLight ? 'text-slate-600' : 'text-gray-400')}>
                  Describe what you want to build:
                </label>
                <textarea
                  rows={3}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="e.g. E-commerce application for 100k users with high weekend traffic, multi-AZ database, and queue processing."
                  className={clsx(
                    'w-full px-3 py-2 border rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500',
                    isLight
                      ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white'
                      : 'bg-gray-950 border-gray-700 text-white placeholder-gray-500'
                  )}
                />
              </div>
            )}
          </div>

          {/* Optional: Region & Traffic Pattern */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label className={clsx('block text-[11px] font-semibold uppercase tracking-wider mb-1.5', isLight ? 'text-slate-600' : 'text-gray-400')}>
                Primary Region
              </label>
              <select
                value={selectedRegion}
                onChange={(e) => setSelectedRegion(e.target.value as Region)}
                className={clsx(
                  'w-full px-3 py-2 border rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-blue-500',
                  isLight ? 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white' : 'bg-gray-950 border-gray-800 text-gray-200'
                )}
              >
                {availableRegions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={clsx('block text-[11px] font-semibold uppercase tracking-wider mb-1.5', isLight ? 'text-slate-600' : 'text-gray-400')}>
                Traffic Pattern
              </label>
              <select
                value={trafficPattern}
                onChange={(e) => setTrafficPattern(e.target.value)}
                className={clsx(
                  'w-full px-3 py-2 border rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-blue-500',
                  isLight ? 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white' : 'bg-gray-950 border-gray-800 text-gray-200'
                )}
              >
                <option value="steady">Steady Continuous</option>
                <option value="spiky">Spiky (Unpredictable bursts)</option>
                <option value="weekend-spikes">Weekend Spikes (E-commerce)</option>
                <option value="diurnal">Diurnal (Business Hours Peak)</option>
                <option value="batch">Batch / Scheduled Processing</option>
              </select>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className={clsx(
          'px-6 py-4 border-t flex items-center justify-between',
          isLight ? 'border-slate-200 bg-slate-50/90' : 'border-gray-800 bg-gray-950/80'
        )}>
          <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-gray-400">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <span className={isLight ? 'text-slate-600 font-medium' : 'text-gray-400'}>RDE Deterministic Validation Enforced</span>
          </div>

          <button
            type="button"
            id="btn-start-building"
            onClick={handleStart}
            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white rounded-xl text-sm font-semibold shadow-lg shadow-blue-500/25 transition-all transform active:scale-98"
          >
            <span>{buildMode === 'ai' ? 'Generate & Open Canvas' : 'Start Building'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

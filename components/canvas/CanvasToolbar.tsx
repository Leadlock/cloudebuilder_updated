'use client';
import React from 'react';
import { useApp } from '@/context/AppContext';
import {
  MousePointer,
  Hand,
  Maximize2,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  Layout,
  Plus,
  Compass,
  Wrench,
  Check,
  Loader2,
  AlertTriangle,
  Users,
  RotateCcw,
} from 'lucide-react';
import clsx from 'clsx';
import { ProviderMode } from '@/types';

interface CanvasToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  hasSelected: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAutoLayout: () => void;
  onAutoFix?: () => void;
  isFixing?: boolean;
  onFitView: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onDeleteSelected: () => void;
  onCopy: () => void;
  onOpenAddModal?: () => void;
  onDiscard?: () => void;
  providerMode?: ProviderMode;
  onSelectProviderMode?: (mode: ProviderMode) => void;
  expectedUsers?: number;
  onSelectExpectedUsers?: (users: number) => void;
  autoSaveStatus?: 'saved' | 'saving' | 'unsaved' | 'error';
  lastSavedTime?: string | null;
  onSaveNow?: () => void;
  isDraft?: boolean;
}

export default function CanvasToolbar({
  canUndo,
  canRedo,
  hasSelected,
  onUndo,
  onRedo,
  onAutoLayout,
  onAutoFix,
  isFixing = false,
  onFitView,
  onZoomIn,
  onZoomOut,
  onDeleteSelected,
  onCopy,
  onOpenAddModal,
  onDiscard,
  providerMode,
  onSelectProviderMode,
  expectedUsers,
  onSelectExpectedUsers,
  autoSaveStatus,
  lastSavedTime,
  onSaveNow,
  isDraft = false,
}: CanvasToolbarProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  return (
    <div
      className={clsx(
        'absolute top-3 left-3 sm:top-4 sm:left-4 z-20 max-w-[calc(100vw-1.5rem)] sm:max-w-[calc(100vw-2rem)] overflow-x-auto no-scrollbar flex items-center gap-1 p-1 rounded-xl shadow-xl backdrop-blur-md select-none border transition-colors',
        isLight ? 'bg-white/95 border-slate-200 text-slate-800 shadow-slate-300/60' : 'bg-slate-900/95 border-slate-700/80 text-slate-200 shadow-2xl'
      )}
    >
      {/* Quick Add Service */}
      {onOpenAddModal && (
        <>
          <button
            onClick={onOpenAddModal}
            title="Add Cloud Resource"
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow transition-all mr-1"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Add Resource</span>
          </button>
          <div className={clsx('shrink-0 w-[1px] h-4 mx-0.5', isLight ? 'bg-slate-200' : 'bg-slate-700')} />
        </>
      )}

      {/* Auto Layout */}
      <button
        id="btn-auto-layout"
        onClick={onAutoLayout}
        title="Auto Layout Architecture (Logical Hierarchy)"
        className={clsx(
          'shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
          isLight
            ? 'text-slate-700 hover:text-slate-900 hover:bg-slate-100'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        )}
      >
        <Layout className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
        <span className="hidden md:inline">Auto Layout</span>
      </button>

      {/* Auto-Fix */}
      {onAutoFix && (
        <button
          id="btn-auto-fix"
          onClick={onAutoFix}
          disabled={isFixing}
          title="Auto-Fix Deterministic Architecture Violations"
          className={clsx(
            'shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors',
            isLight
              ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-200'
              : 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border-emerald-500/30'
          )}
        >
          <Wrench className={clsx('w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400', isFixing && 'animate-spin')} />
          <span className="hidden md:inline">{isFixing ? 'Fixing...' : 'Auto-Fix'}</span>
        </button>
      )}

      {/* Discard / Reset Canvas */}
      {onDiscard && (
        <button
          id="btn-discard-canvas"
          onClick={onDiscard}
          title="Discard / Reset Architecture Canvas"
          className={clsx(
            'shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors',
            isLight
              ? 'bg-rose-50 hover:bg-rose-100 text-rose-800 border-rose-200'
              : 'text-rose-300 hover:text-rose-100 hover:bg-rose-950/50 border-rose-900/40'
          )}
        >
          <Trash2 className="w-3.5 h-3.5 text-rose-500 dark:text-rose-400" />
          <span className="hidden sm:inline">Discard</span>
        </button>
      )}

      {/* Fit View */}
      <button
        onClick={onFitView}
        title="Fit Architecture to View"
        className={clsx(
          'shrink-0 p-1.5 rounded-lg transition-colors',
          isLight
            ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        )}
      >
        <Maximize2 className="w-4 h-4" />
      </button>

      <div className={clsx('shrink-0 w-[1px] h-4 mx-0.5', isLight ? 'bg-slate-200' : 'bg-slate-700')} />

      {/* Zoom In / Out */}
      <button
        onClick={onZoomIn}
        title="Zoom In"
        className={clsx(
          'shrink-0 p-1.5 rounded-lg transition-colors',
          isLight
            ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        )}
      >
        <ZoomIn className="w-4 h-4" />
      </button>
      <button
        onClick={onZoomOut}
        title="Zoom Out"
        className={clsx(
          'shrink-0 p-1.5 rounded-lg transition-colors',
          isLight
            ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        )}
      >
        <ZoomOut className="w-4 h-4" />
      </button>

      <div className={clsx('shrink-0 w-[1px] h-4 mx-0.5', isLight ? 'bg-slate-200' : 'bg-slate-700')} />

      {/* Undo / Redo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        className={clsx(
          'shrink-0 p-1.5 rounded-lg transition-colors',
          canUndo
            ? isLight
              ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              : 'text-slate-300 hover:text-white hover:bg-slate-800'
            : isLight
            ? 'text-slate-300 cursor-not-allowed'
            : 'text-slate-600 cursor-not-allowed'
        )}
      >
        <Undo2 className="w-4 h-4" />
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo (Ctrl+Y)"
        className={clsx(
          'shrink-0 p-1.5 rounded-lg transition-colors',
          canRedo
            ? isLight
              ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              : 'text-slate-300 hover:text-white hover:bg-slate-800'
            : isLight
            ? 'text-slate-300 cursor-not-allowed'
            : 'text-slate-600 cursor-not-allowed'
        )}
      >
        <Redo2 className="w-4 h-4" />
      </button>

      {/* Copy / Delete (Only active when node is selected) */}
      {hasSelected && (
        <>
          <div className={clsx('shrink-0 w-[1px] h-4 mx-0.5', isLight ? 'bg-slate-200' : 'bg-slate-700')} />
          <button
            onClick={onCopy}
            title="Duplicate Selected (Ctrl+C)"
            className={clsx(
              'shrink-0 p-1.5 rounded-lg transition-colors',
              isLight
                ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                : 'text-slate-300 hover:text-white hover:bg-slate-800'
            )}
          >
            <Copy className="w-4 h-4 text-blue-500 dark:text-blue-400" />
          </button>
          <button
            onClick={onDeleteSelected}
            title="Delete Selected (Delete / Backspace)"
            className={clsx(
              'shrink-0 p-1.5 rounded-lg transition-colors',
              isLight
                ? 'text-slate-600 hover:text-rose-600 hover:bg-rose-50'
                : 'text-slate-300 hover:text-rose-400 hover:bg-rose-950/40'
            )}
          >
            <Trash2 className="w-4 h-4 text-rose-500 dark:text-rose-400" />
          </button>
        </>
      )}

      {/* Provider Mode Switcher */}
      {onSelectProviderMode && (
        <>
          <div className={clsx('shrink-0 w-[1px] h-4 mx-1', isLight ? 'bg-slate-200' : 'bg-slate-700')} />
          <div
            className={clsx(
              'shrink-0 flex items-center rounded-lg p-0.5 border text-[11px] font-semibold',
              isLight ? 'bg-slate-100 border-slate-300' : 'bg-slate-950/80 border-slate-800'
            )}
          >
            <button
              type="button"
              id="toolbar-cloud-aws"
              onClick={() => onSelectProviderMode('AWS')}
              className={clsx(
                'px-2 py-1 rounded transition-colors',
                providerMode === 'AWS'
                  ? isLight
                    ? 'bg-orange-100 text-orange-800 border border-orange-300 shadow-xs'
                    : 'bg-orange-500/20 text-orange-300 border border-orange-500/40'
                  : isLight
                  ? 'text-slate-600 hover:text-slate-900'
                  : 'text-slate-400 hover:text-slate-200'
              )}
              title="AWS-only mode"
            >
              AWS
            </button>
            <button
              type="button"
              id="toolbar-cloud-azure"
              onClick={() => onSelectProviderMode('AZURE')}
              className={clsx(
                'px-2 py-1 rounded transition-colors',
                providerMode === 'AZURE'
                  ? isLight
                    ? 'bg-blue-100 text-blue-800 border border-blue-300 shadow-xs'
                    : 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                  : isLight
                  ? 'text-slate-600 hover:text-slate-900'
                  : 'text-slate-400 hover:text-slate-200'
              )}
              title="Azure-only mode"
            >
              Azure
            </button>
            <button
              type="button"
              id="toolbar-cloud-multicloud"
              onClick={() => onSelectProviderMode('MULTI_CLOUD')}
              className={clsx(
                'px-2 py-1 rounded transition-colors',
                providerMode === 'MULTI_CLOUD'
                  ? isLight
                    ? 'bg-purple-100 text-purple-800 border border-purple-300 shadow-xs'
                    : 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                  : isLight
                  ? 'text-slate-600 hover:text-slate-900'
                  : 'text-slate-400 hover:text-slate-200'
              )}
              title="Multi-Cloud (AWS + Azure) mode"
            >
              Multi-Cloud
            </button>
          </div>
        </>
      )}

      {/* Expected Users / Scale */}
      {onSelectExpectedUsers && (
        <>
          <div className={clsx('shrink-0 w-[1px] h-4 mx-1 hidden sm:block', isLight ? 'bg-slate-200' : 'bg-slate-700')} />
          <div
            className={clsx(
              'shrink-0 hidden sm:flex items-center gap-1.5 border rounded-lg px-2 py-1',
              isLight ? 'bg-slate-100 border-slate-300' : 'bg-slate-950/80 border-slate-800'
            )}
          >
            <Users className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
            <select
              id="select-expected-users"
              value={expectedUsers || 10000}
              onChange={(e) => onSelectExpectedUsers(Number(e.target.value))}
              className={clsx(
                'bg-transparent text-xs font-semibold focus:outline-none cursor-pointer',
                isLight ? 'text-slate-800' : 'text-cyan-300'
              )}
              title="Architecture Target Scale (Expected Users)"
            >
              <option value={100} className={isLight ? 'bg-white text-slate-900' : 'bg-slate-900 text-slate-200'}>100 users</option>
              <option value={500} className={isLight ? 'bg-white text-slate-900' : 'bg-slate-900 text-slate-200'}>500 users</option>
              <option value={1000} className={isLight ? 'bg-white text-slate-900' : 'bg-slate-900 text-slate-200'}>1,000 users</option>
              <option value={5000} className={isLight ? 'bg-white text-slate-900' : 'bg-slate-900 text-slate-200'}>5,000 users</option>
              <option value={10000} className={isLight ? 'bg-white text-slate-900' : 'bg-slate-900 text-slate-200'}>10,000 users</option>
              <option value={50000} className={isLight ? 'bg-white text-slate-900' : 'bg-slate-900 text-slate-200'}>50,000 users</option>
              <option value={100000} className={isLight ? 'bg-white text-slate-900' : 'bg-slate-900 text-slate-200'}>100,000 users</option>
              <option value={500000} className={isLight ? 'bg-white text-slate-900' : 'bg-slate-900 text-slate-200'}>500,000 users</option>
              <option value={1000000} className={isLight ? 'bg-white text-slate-900' : 'bg-slate-900 text-slate-200'}>1,000,000+ users</option>
            </select>
          </div>
        </>
      )}

      {/* Auto-Save Status & Save Button */}
      {autoSaveStatus && (
        <>
          <div className={clsx('shrink-0 w-[1px] h-4 mx-1', isLight ? 'bg-slate-200' : 'bg-slate-700')} />
          <div className="shrink-0 flex items-center gap-1.5 sm:gap-2">
            <div
              id="autosave-indicator"
              className={clsx(
                'flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 sm:px-2.5 rounded-lg border',
                isLight ? 'bg-slate-100 border-slate-300' : 'bg-slate-950/80 border-slate-800'
              )}
            >
              {autoSaveStatus === 'saved' && (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-emerald-600 dark:text-emerald-400 hidden md:inline">Saved</span>
                </>
              )}
              {autoSaveStatus === 'saving' && (
                <>
                  <Loader2 className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400 animate-spin" />
                  <span className="text-cyan-600 dark:text-cyan-400 hidden md:inline">Saving...</span>
                </>
              )}
              {autoSaveStatus === 'unsaved' && (
                <>
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                  <span className="text-amber-600 dark:text-amber-300 hidden md:inline">Unsaved</span>
                </>
              )}
              {autoSaveStatus === 'error' && (
                <>
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
                  <span className="text-rose-600 dark:text-rose-400 hidden md:inline">Save error</span>
                </>
              )}
            </div>

            {onSaveNow && (
              <button
                type="button"
                id="btn-save-now"
                onClick={onSaveNow}
                title={isDraft ? "Save this builder as a new Project in your account" : "Save changes to this project"}
                className="px-3 py-1 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white transition-colors shadow-sm flex items-center gap-1 shrink-0"
              >
                <span>{isDraft ? "Save Project" : "Save"}</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

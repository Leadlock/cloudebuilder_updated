'use client';
import React from 'react';
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
  LayoutGrid,
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
  onOpenImportTemplate?: () => void;
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
  onOpenImportTemplate,
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
  return (
    <div className="absolute top-3 left-3 sm:top-4 sm:left-4 z-20 max-w-[calc(100vw-1.5rem)] sm:max-w-[calc(100vw-2rem)] overflow-x-auto no-scrollbar flex items-center gap-1 p-1 bg-slate-900/95 border border-slate-700/80 rounded-xl shadow-2xl backdrop-blur-md select-none">
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
          <div className="shrink-0 w-[1px] h-4 bg-slate-700 mx-0.5" />
        </>
      )}

      {/* Import Template */}
      {onOpenImportTemplate && (
        <>
          <button
            id="btn-import-template"
            onClick={onOpenImportTemplate}
            title="Import Architecture Template"
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 text-xs font-medium transition-colors"
          >
            <LayoutGrid className="w-3.5 h-3.5 text-indigo-400" />
            <span className="hidden sm:inline">Templates</span>
          </button>
          <div className="shrink-0 w-[1px] h-4 bg-slate-700 mx-0.5" />
        </>
      )}

      {/* Auto Layout */}
      <button
        id="btn-auto-layout"
        onClick={onAutoLayout}
        title="Auto Layout Architecture (Logical Hierarchy)"
        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 text-xs font-medium transition-colors"
      >
        <Layout className="w-3.5 h-3.5 text-cyan-400" />
        <span className="hidden md:inline">Auto Layout</span>
      </button>

      {/* Auto-Fix */}
      {onAutoFix && (
        <button
          id="btn-auto-fix"
          onClick={onAutoFix}
          disabled={isFixing}
          title="Auto-Fix Deterministic Architecture Violations"
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition-colors"
        >
          <Wrench className={clsx('w-3.5 h-3.5 text-emerald-400', isFixing && 'animate-spin')} />
          <span className="hidden md:inline">{isFixing ? 'Fixing...' : 'Auto-Fix'}</span>
        </button>
      )}

      {/* Discard / Reset Canvas */}
      {onDiscard && (
        <button
          id="btn-discard-canvas"
          onClick={onDiscard}
          title="Discard / Reset Architecture Canvas"
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-rose-300 hover:text-rose-100 hover:bg-rose-950/50 border border-rose-900/40 text-xs font-semibold transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5 text-rose-400" />
          <span className="hidden sm:inline">Discard</span>
        </button>
      )}

      {/* Fit View */}
      <button
        onClick={onFitView}
        title="Fit Architecture to View"
        className="shrink-0 p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
      >
        <Maximize2 className="w-4 h-4" />
      </button>

      <div className="shrink-0 w-[1px] h-4 bg-slate-700 mx-0.5" />

      {/* Zoom In / Out */}
      <button
        onClick={onZoomIn}
        title="Zoom In"
        className="shrink-0 p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
      >
        <ZoomIn className="w-4 h-4" />
      </button>
      <button
        onClick={onZoomOut}
        title="Zoom Out"
        className="shrink-0 p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
      >
        <ZoomOut className="w-4 h-4" />
      </button>

      <div className="shrink-0 w-[1px] h-4 bg-slate-700 mx-0.5" />

      {/* Undo / Redo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        className={clsx(
          'shrink-0 p-1.5 rounded-lg transition-colors',
          canUndo ? 'text-slate-300 hover:text-white hover:bg-slate-800' : 'text-slate-600 cursor-not-allowed'
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
          canRedo ? 'text-slate-300 hover:text-white hover:bg-slate-800' : 'text-slate-600 cursor-not-allowed'
        )}
      >
        <Redo2 className="w-4 h-4" />
      </button>

      {/* Copy / Delete (Only active when node is selected) */}
      {hasSelected && (
        <>
          <div className="shrink-0 w-[1px] h-4 bg-slate-700 mx-0.5" />
          <button
            onClick={onCopy}
            title="Duplicate Selected (Ctrl+C)"
            className="shrink-0 p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <Copy className="w-4 h-4 text-blue-400" />
          </button>
          <button
            onClick={onDeleteSelected}
            title="Delete Selected (Delete / Backspace)"
            className="shrink-0 p-1.5 rounded-lg text-slate-300 hover:text-rose-400 hover:bg-rose-950/40 transition-colors"
          >
            <Trash2 className="w-4 h-4 text-rose-400" />
          </button>
        </>
      )}

      {/* Provider Mode Switcher */}
      {onSelectProviderMode && (
        <>
          <div className="shrink-0 w-[1px] h-4 bg-slate-700 mx-1" />
          <div className="shrink-0 flex items-center bg-slate-950/80 rounded-lg p-0.5 border border-slate-800 text-[11px] font-semibold">
            <button
              type="button"
              id="toolbar-cloud-aws"
              onClick={() => onSelectProviderMode('AWS')}
              className={clsx(
                'px-2 py-1 rounded transition-colors',
                providerMode === 'AWS'
                  ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40'
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
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
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
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
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
          <div className="shrink-0 w-[1px] h-4 bg-slate-700 mx-1 hidden sm:block" />
          <div className="shrink-0 hidden sm:flex items-center gap-1.5 bg-slate-950/80 border border-slate-800 rounded-lg px-2 py-1">
            <Users className="w-3.5 h-3.5 text-cyan-400" />
            <select
              id="select-expected-users"
              value={expectedUsers || 10000}
              onChange={(e) => onSelectExpectedUsers(Number(e.target.value))}
              className="bg-transparent text-cyan-300 text-xs font-semibold focus:outline-none cursor-pointer"
              title="Architecture Target Scale (Expected Users)"
            >
              <option value={100} className="bg-slate-900 text-slate-200">100 users</option>
              <option value={500} className="bg-slate-900 text-slate-200">500 users</option>
              <option value={1000} className="bg-slate-900 text-slate-200">1,000 users</option>
              <option value={5000} className="bg-slate-900 text-slate-200">5,000 users</option>
              <option value={10000} className="bg-slate-900 text-slate-200">10,000 users</option>
              <option value={50000} className="bg-slate-900 text-slate-200">50,000 users</option>
              <option value={100000} className="bg-slate-900 text-slate-200">100,000 users</option>
              <option value={500000} className="bg-slate-900 text-slate-200">500,000 users</option>
              <option value={1000000} className="bg-slate-900 text-slate-200">1,000,000+ users</option>
            </select>
          </div>
        </>
      )}

      {/* Auto-Save Status & Save Button */}
      {autoSaveStatus && (
        <>
          <div className="shrink-0 w-[1px] h-4 bg-slate-700 mx-1" />
          <div className="shrink-0 flex items-center gap-1.5 sm:gap-2">
            <div
              id="autosave-indicator"
              className="flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 sm:px-2.5 rounded-lg bg-slate-950/80 border border-slate-800"
            >
              {autoSaveStatus === 'saved' && (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 hidden md:inline">Saved</span>
                </>
              )}
              {autoSaveStatus === 'saving' && (
                <>
                  <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                  <span className="text-cyan-400 hidden md:inline">Saving...</span>
                </>
              )}
              {autoSaveStatus === 'unsaved' && (
                <>
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                  <span className="text-amber-300 hidden md:inline">Unsaved</span>
                </>
              )}
              {autoSaveStatus === 'error' && (
                <>
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                  <span className="text-rose-400 hidden md:inline">Save error</span>
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

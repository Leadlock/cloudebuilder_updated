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
  Plus,
  Compass,
} from 'lucide-react';
import clsx from 'clsx';

interface CanvasToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  hasSelected: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAutoLayout: () => void;
  onFitView: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onDeleteSelected: () => void;
  onCopy: () => void;
  onOpenAddModal?: () => void;
}

export default function CanvasToolbar({
  canUndo,
  canRedo,
  hasSelected,
  onUndo,
  onRedo,
  onAutoLayout,
  onFitView,
  onZoomIn,
  onZoomOut,
  onDeleteSelected,
  onCopy,
  onOpenAddModal,
}: CanvasToolbarProps) {
  return (
    <div className="absolute top-4 left-4 z-20 flex items-center gap-1 p-1 bg-slate-900/90 border border-slate-700/80 rounded-xl shadow-2xl backdrop-blur-md select-none">
      {/* Quick Add Service */}
      {onOpenAddModal && (
        <>
          <button
            onClick={onOpenAddModal}
            title="Add Cloud Resource"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow transition-all mr-1"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Resource</span>
          </button>
          <div className="w-[1px] h-4 bg-slate-700 mx-0.5" />
        </>
      )}

      {/* Auto Layout */}
      <button
        onClick={onAutoLayout}
        title="Auto Layout Architecture (Logical Hierarchy)"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 text-xs font-medium transition-colors"
      >
        <Layout className="w-3.5 h-3.5 text-cyan-400" />
        <span>Auto Layout</span>
      </button>

      {/* Fit View */}
      <button
        onClick={onFitView}
        title="Fit Architecture to View"
        className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
      >
        <Maximize2 className="w-4 h-4" />
      </button>

      <div className="w-[1px] h-4 bg-slate-700 mx-0.5" />

      {/* Zoom In / Out */}
      <button
        onClick={onZoomIn}
        title="Zoom In"
        className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
      >
        <ZoomIn className="w-4 h-4" />
      </button>
      <button
        onClick={onZoomOut}
        title="Zoom Out"
        className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
      >
        <ZoomOut className="w-4 h-4" />
      </button>

      <div className="w-[1px] h-4 bg-slate-700 mx-0.5" />

      {/* Undo / Redo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        className={clsx(
          'p-1.5 rounded-lg transition-colors',
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
          'p-1.5 rounded-lg transition-colors',
          canRedo ? 'text-slate-300 hover:text-white hover:bg-slate-800' : 'text-slate-600 cursor-not-allowed'
        )}
      >
        <Redo2 className="w-4 h-4" />
      </button>

      {/* Copy / Delete (Only active when node is selected) */}
      {hasSelected && (
        <>
          <div className="w-[1px] h-4 bg-slate-700 mx-0.5" />
          <button
            onClick={onCopy}
            title="Duplicate Selected (Ctrl+C)"
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <Copy className="w-4 h-4 text-blue-400" />
          </button>
          <button
            onClick={onDeleteSelected}
            title="Delete Selected (Delete / Backspace)"
            className="p-1.5 rounded-lg text-slate-300 hover:text-rose-400 hover:bg-rose-950/40 transition-colors"
          >
            <Trash2 className="w-4 h-4 text-rose-400" />
          </button>
        </>
      )}
    </div>
  );
}

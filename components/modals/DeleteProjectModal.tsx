'use client';

import React, { useEffect } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { useApp } from '@/context/AppContext';

interface DeleteProjectModalProps {
  isOpen: boolean;
  projectName: string;
  projectId: string;
  onConfirm: (projectId: string) => void;
  onCancel: () => void;
}

export default function DeleteProjectModal({
  isOpen,
  projectName,
  projectId,
  onConfirm,
  onCancel,
}: DeleteProjectModalProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className={`fixed inset-0 ${isLight ? 'bg-slate-900/40' : 'bg-black/80'} backdrop-blur-sm transition-opacity animate-in fade-in duration-150`}
        onClick={onCancel}
      />

      {/* Modal Dialog */}
      <div className={`relative w-full max-w-md ${isLight ? 'bg-white border-rose-200 shadow-2xl shadow-rose-900/10' : 'bg-gradient-to-b from-gray-900 to-gray-950 border-red-500/30 shadow-2xl shadow-red-950/40'} border rounded-2xl p-6 z-10 animate-in zoom-in-95 duration-200`}>
        {/* Close Button */}
        <button
          type="button"
          onClick={onCancel}
          className={`absolute top-4 right-4 ${isLight ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100' : 'text-gray-400 hover:text-white hover:bg-gray-800'} p-1 rounded-lg transition-colors`}
          title="Cancel"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Warning Icon & Header */}
        <div className="flex items-start gap-4">
          <div className={`w-11 h-11 rounded-xl ${isLight ? 'bg-rose-50 border border-rose-200 text-rose-600' : 'bg-red-500/10 border border-red-500/30 text-red-400'} flex items-center justify-center shrink-0 shadow-inner`}>
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h3 className={`${isLight ? 'text-slate-900' : 'text-white'} font-bold text-lg leading-tight`}>Delete Project</h3>
            <p className={`${isLight ? 'text-slate-500' : 'text-gray-400'} text-xs mt-1`}>
              This action cannot be undone. Are you sure you want to delete this project?
            </p>
          </div>
        </div>

        {/* Project Details Box */}
        <div className={`mt-4 p-3.5 ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-gray-950/80 border-gray-800'} border rounded-xl`}>
          <div className="flex items-center justify-between">
            <span className={`${isLight ? 'text-slate-500' : 'text-gray-400'} text-xs`}>Project Name:</span>
            <span className={`${isLight ? 'text-slate-900' : 'text-white'} text-xs font-semibold max-w-[240px] truncate`} title={projectName}>
              {projectName}
            </span>
          </div>
          <div className={`flex items-center justify-between mt-2 pt-2 border-t ${isLight ? 'border-slate-200 text-rose-600' : 'border-gray-800/80 text-red-400/90'} text-[11px]`}>
            <span>Impact:</span>
            <span>All canvases, subnets & environments will be deleted</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className={`px-4 py-2 text-xs font-medium ${isLight ? 'text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border-slate-300' : 'text-gray-300 hover:text-white bg-gray-800/80 hover:bg-gray-800 border-gray-700/80'} border rounded-xl transition-colors`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(projectId)}
            className="px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 rounded-xl shadow-lg shadow-red-600/30 transition-all flex items-center gap-2"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete Project</span>
          </button>
        </div>
      </div>
    </div>
  );
}
